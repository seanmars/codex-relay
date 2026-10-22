// codex-relay: one local address for Claude Code. Each session's model calls go to Anthropic unchanged or to the
// local Codex proxy (claude-code-proxy), by the session's pinned route; every other request goes to Anthropic.
// Usage: node relay.mjs [claudeConfigDir]
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { pipeline } from 'node:stream'
import { fileURLToPath } from 'node:url'
import * as L from './logic.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = process.argv[2] || L.claudeConfigDir()
const REAL_DIR = L.realDir(dir)
const CFG_FILE = L.configFile(dir)
const STATE_FILE = L.stateFile(dir)
const LOG_FILE = L.logFile(dir)
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(here, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()

// A proxy variable inherited from the shell would send loopback calls to the proxy server
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k]

const log = (line) => {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.writeFileSync(LOG_FILE, '')
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

const readCfg = () => {
  try {
    return L.parseConfig(fs.readFileSync(CFG_FILE, 'utf8'))
  } catch {
    return L.parseConfig('')
  }
}

// ---------- sticky state ----------
let state = (() => {
  try {
    return L.pruneSticky(L.parseState(fs.readFileSync(STATE_FILE, 'utf8')), Date.now())
  } catch {
    return L.parseState(null)
  }
})()
let saveTimer = null
const save = () => {
  try {
    const tmp = `${STATE_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ ...L.pruneSticky(state, Date.now()), updatedAt: Date.now() }))
    fs.renameSync(tmp, STATE_FILE)
  } catch (e) {
    log(`state save failed: ${e.message}`)
  }
}
// Every model call refreshes its session's time; one write per few seconds is plenty
const saveSoon = () => {
  if (!saveTimer) saveTimer = setTimeout(() => ((saveTimer = null), save()), 3000)
}
const short = (sid) => (sid ? sid.slice(0, 8) : '-')

// ---------- HTTP helpers ----------
const HOP = ['connection', 'proxy-connection', 'keep-alive', 'upgrade', 'transfer-encoding', 'te', 'trailer']
const forwardHeaders = (headers, host) => {
  const out = { ...headers, host }
  for (const h of HOP) delete out[h]
  return out
}

const apiError = (res, status, message) => {
  if (res.headersSent) return res.destroy()
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `codex-relay: ${message}` } }))
}

const json = (res, obj, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

// pipeline() destroys `res` when the upstream drops mid-stream; pipe() alone would leave the caller waiting
const relayBody = (ur, res) => pipeline(ur, res, () => {})

function send(base, req, res, body, headers) {
  // The caller left while the Codex proxy was starting: its 'close' already fired, so nothing would stop this request
  if (res.destroyed) return
  const u = new URL(base)
  const lib = u.protocol === 'http:' ? http : https
  const up = lib.request(
    {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: L.upstreamPath(base, req.url),
      method: req.method,
      headers: { ...forwardHeaders(headers, u.host), 'content-length': body.length },
    },
    (ur) => {
      res.writeHead(ur.statusCode, ur.headers)
      relayBody(ur, res)
    },
  )
  up.on('error', (e) => apiError(res, 502, `${u.host} unreachable: ${e.message}`))
  // The caller gave up (Esc in Claude Code): stop the upstream generation too
  const callerLeft = () => {
    if (!res.writableEnded) up.destroy()
  }
  res.on('close', callerLeft)
  up.on('close', () => res.off('close', callerLeft))
  up.end(body)
}

// Streams a request that is not a model call to Anthropic untouched (token refresh, profile, models, ...)
function passthrough(cfg, req, res) {
  const u = new URL(cfg.claudeUrl)
  const lib = u.protocol === 'http:' ? http : https
  const up = lib.request(
    {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: L.upstreamPath(cfg.claudeUrl, req.url),
      method: req.method,
      headers: forwardHeaders(req.headers, u.host),
    },
    (ur) => {
      res.writeHead(ur.statusCode, ur.headers)
      relayBody(ur, res)
    },
  )
  up.on('error', (e) => apiError(res, 502, `Anthropic unreachable: ${e.message}`))
  res.on('close', () => up.destroy())
  req.pipe(up)
}

// ---------- the Codex proxy ----------
const portOpen = (port, timeoutMs = 1000) =>
  new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    const done = (ok) => (s.destroy(), resolve(ok))
    s.setTimeout(timeoutMs, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })

let proxyChild = null // { pid, port } of a proxy this relay started
let proxyStarting = null
let proxyError = null

// Starts the proxy when its port is closed and waits up to 15 s for it; concurrent callers share one attempt
function ensureProxy(cfg) {
  if (proxyStarting) return proxyStarting
  proxyStarting = (async () => {
    if (await portOpen(cfg.proxyPort)) return true
    try {
      const c = spawn(cfg.proxyCommand, ['serve', '--no-monitor', '--port', String(cfg.proxyPort)], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      const failed = new Promise((resolve) => c.once('error', (e) => resolve(e)))
      // A proxy stopped from outside must not leave its pid here: /__shutdown would end whatever reuses it
      c.once('exit', () => {
        if (proxyChild?.pid === c.pid) proxyChild = null
      })
      c.unref()
      log(`started ${cfg.proxyCommand} on port ${cfg.proxyPort} (pid ${c.pid})`)
      for (let i = 0; i < 30; i++) {
        const err = await Promise.race([failed, new Promise((r) => setTimeout(() => r(null), 500))])
        if (err) {
          proxyError = `cannot start "${cfg.proxyCommand}": ${err.message}. Install it with "cargo install --path proxy" or set proxyCommand in ${CFG_FILE}`
          log(proxyError)
          return false
        }
        if (await portOpen(cfg.proxyPort)) {
          proxyChild = { pid: c.pid, port: cfg.proxyPort }
          proxyError = null
          return true
        }
      }
      proxyError = `"${cfg.proxyCommand}" did not open port ${cfg.proxyPort} within 15 s`
      log(proxyError)
      return false
    } catch (e) {
      proxyError = `cannot start "${cfg.proxyCommand}": ${e.message}`
      log(proxyError)
      return false
    }
  })().finally(() => {
    proxyStarting = null
  })
  return proxyStarting
}

async function toCodex(cfg, req, res, body) {
  if (!(await ensureProxy(cfg))) return apiError(res, 502, `the Codex proxy is not running: ${proxyError || 'unknown error'}`)
  let out = body
  try {
    const j = JSON.parse(body.toString('utf8'))
    if (typeof j.model === 'string') j.model = L.codexModelFor(j.model)
    out = Buffer.from(JSON.stringify(j))
  } catch {}
  // The proxy signs in with Codex CLI's own account: Claude Code's credentials stay out of it
  const headers = { ...req.headers }
  delete headers.authorization
  delete headers['x-api-key']
  send(`http://127.0.0.1:${cfg.proxyPort}`, req, res, out, headers)
}

// ---------- statusline data ----------
const cache = { usage: { at: 0, value: null, error: null, running: false } }

// The proxy's JSON answer at `urlPath`, or null
function proxyGet(cfg, urlPath) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: cfg.proxyPort, path: urlPath, timeout: 1500 }, (ur) => {
      const ch = []
      ur.on('data', (c) => ch.push(c))
      ur.on('end', () => {
        try {
          resolve(ur.statusCode === 200 ? JSON.parse(Buffer.concat(ch).toString('utf8')) : null)
        } catch {
          resolve(null)
        }
      })
    })
    r.on('error', () => resolve(null))
    // destroy() without an error raises no 'error': answer here, or a proxy that never answers hangs /__health
    r.on('timeout', () => {
      r.destroy()
      resolve(null)
    })
  })
}

// The plan's usage windows, read through the proxy's own CLI (it holds the refreshing sign-in). At most every 2 min.
function refreshUsage(cfg) {
  const u = cache.usage
  if (u.running || Date.now() - u.at < 120000) return
  u.running = true
  execFile(cfg.proxyCommand, ['codex', 'usage', '--json'], { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
    u.running = false
    u.at = Date.now()
    if (err) {
      u.error = String(stderr || err.message).trim().split('\n')[0]
      return
    }
    try {
      u.value = L.usageSummary(JSON.parse(stdout))
      u.error = null
    } catch (e) {
      u.error = `unreadable usage: ${e.message}`
    }
  })
}

// ---------- control ----------
let inflight = 0
let server

async function control(req, res, body) {
  const u = new URL(req.url, 'http://x')
  const cfg = readCfg()
  if (u.pathname === '/__health') {
    const sid = u.searchParams.get('sid') || ''
    const session = L.sessionRoute(state, cfg, sid)
    if (session.route === 'codex' || u.searchParams.get('usage') === '1') refreshUsage(cfg)
    const proxyUp = await portOpen(cfg.proxyPort, 500)
    const [monitor, proxyHealth] = proxyUp ? await Promise.all([proxyGet(cfg, '/monitor'), proxyGet(cfg, '/healthz')]) : [null, null]
    return json(res, {
      ok: true,
      pid: process.pid,
      version: VERSION,
      configDir: REAL_DIR,
      configDirArg: dir, // as given on the command line; the hook compares its own spelling against both
      port: server.address().port,
      inflight,
      defaultRoute: cfg.defaultRoute,
      agentModel: cfg.agentModel,
      agentEffort: cfg.agentEffort,
      pinnedSessions: Object.keys(state.sticky).length,
      session: { sid, ...session, codex: L.sessionStats(monitor, sid), agents: L.agentStats(monitor, sid) },
      proxy: {
        port: cfg.proxyPort,
        command: cfg.proxyCommand,
        up: proxyUp,
        startedPid: proxyChild?.pid ?? null,
        error: proxyError,
        overrides: L.proxyOverrides(proxyHealth),
        auth: L.proxyAuth(proxyHealth),
      },
      usage: cache.usage.value,
      usageError: cache.usage.error,
      usageAt: cache.usage.at || null,
    })
  }
  if (u.pathname === '/__session' && req.method === 'POST') {
    let sid = ''
    let route = ''
    try {
      ;({ sid, route } = JSON.parse(body.toString('utf8')))
    } catch {}
    if (!sid || !L.isRoute(route)) return apiError(res, 400, 'need {sid, route: "claude" | "codex"}')
    state = L.setSticky(state, sid, route, Date.now())
    save()
    log(`session ${short(sid)} set to ${route} by hand`)
    if (route === 'codex') ensureProxy(cfg)
    return json(res, { ok: true, session: { sid, route, pinned: true } })
  }
  if (u.pathname === '/__shutdown' && req.method === 'POST') {
    let ask = {}
    try {
      ask = JSON.parse(body.toString('utf8') || '{}') || {}
    } catch {}
    const stopProxy = Boolean(ask.proxy)
    // Checked here, not by the caller: no request can start between this check and the exit
    if (ask.ifIdle && inflight > 0) return json(res, { ok: false, busy: inflight }, 409)
    json(res, { ok: true, pid: process.pid, stoppedProxy: stopProxy && proxyChild ? proxyChild.pid : null })
    log(`shutdown requested${stopProxy ? ' (with proxy)' : ''}`)
    if (stopProxy && proxyChild) {
      try {
        process.kill(proxyChild.pid)
      } catch {}
    }
    save()
    setTimeout(() => process.exit(0), 100)
    return
  }
  return apiError(res, 404, 'unknown control path')
}

// ---------- dispatch ----------
function dispatch(req, res) {
  if (!req.url.startsWith('/') || !L.isLocalRequest(req.headers, server.address().port)) {
    return apiError(res, 403, 'only local programs may use the relay (Host 127.0.0.1 or localhost on the relay port, no browser requests)')
  }
  const cfg = readCfg()
  const isControl = req.url.startsWith('/__')
  if (!isControl) {
    inflight++
    res.once('close', () => inflight--)
  }
  if (!isControl && !L.isModelCall(req.method, req.url)) return passthrough(cfg, req, res)
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    if (isControl) return control(req, res, body).catch((e) => apiError(res, 500, e.message))
    const sid = String(req.headers['x-claude-code-session-id'] || '')
    let model = null
    try {
      model = JSON.parse(body.toString('utf8')).model
    } catch {}
    const d = L.decide(state, cfg, sid, model, Date.now())
    if (d.state !== state) {
      if (!state.sticky[sid]) log(`session ${short(sid)} starts on ${d.route}`)
      state = d.state
      saveSoon()
    }
    if (d.route === 'codex') return toCodex(cfg, req, res, body)
    send(cfg.claudeUrl, req, res, body, req.headers)
  })
}

server = http.createServer(dispatch)
const PORT = readCfg().port
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // The hook starts a relay only after a failed health check, so finding our own relay here is a startup race
    const refuse = (h) => {
      const other = h && h.configDir
      if (other && L.sameDir(other, REAL_DIR)) process.exit(0)
      log(
        `port ${PORT} is already used by ${other ? `another codex-relay (config dir ${other})` : 'an unknown process'}; this relay (config dir ${REAL_DIR}) did not start. Set another "port" in ${CFG_FILE}`,
      )
      process.exit(1)
    }
    const r = http.get({ host: '127.0.0.1', port: PORT, path: '/__health', timeout: 2000 }, (ur) => {
      const ch = []
      ur.on('data', (c) => ch.push(c))
      ur.on('end', () => {
        let h = null
        try {
          const j = JSON.parse(Buffer.concat(ch).toString('utf8'))
          if (j && j.ok === true && j.pid) h = j
        } catch {}
        refuse(h)
      })
    })
    r.on('error', () => refuse(null))
    r.on('timeout', () => refuse(null))
    return
  }
  log(`server error: ${e.message}`)
  process.exit(1)
})
server.listen(PORT, '127.0.0.1', () => {
  log(`relay ${VERSION} up on ${PORT}, pid ${process.pid}, config dir ${dir}`)
  if (readCfg().defaultRoute === 'codex') ensureProxy(readCfg())
})
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (save(), process.exit(0)))
