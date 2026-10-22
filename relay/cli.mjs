// codex-relay command line. Usage: node cli.mjs <command> [args]
//   start | stop [--proxy] | stop-proxy | restart [--proxy] [--if-stale] [--if-idle] | status [--json]
//   | default [claude|codex] | effort [low|medium|high|xhigh|max|auto] | config | wait [seconds]
// The config directory is $CLAUDE_CONFIG_DIR, or ~/.claude.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as L from './logic.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = L.claudeConfigDir()
const CFG_FILE = L.configFile(dir)

const readRaw = () => {
  try {
    return fs.readFileSync(CFG_FILE, 'utf8')
  } catch {
    return ''
  }
}
const cfg = () => L.parseConfig(readRaw())
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(here, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()

function request(method, urlPath, body, timeoutMs = 2000, port = cfg().port) {
  return new Promise((resolve) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const r = http.request(
      { host: '127.0.0.1', port, path: urlPath, method, timeout: timeoutMs, headers: data ? { 'content-type': 'application/json' } : {} },
      (res) => {
        const ch = []
        res.on('data', (c) => ch.push(c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(ch).toString('utf8')))
          } catch {
            resolve(null)
          }
        })
      },
    )
    r.on('error', () => resolve(null))
    // destroy() without an error raises no 'error': answer here, or a port that never answers hangs the CLI
    r.on('timeout', () => {
      r.destroy()
      resolve(null)
    })
    r.end(data)
  })
}

const health = (sid = '') => request('GET', `/__health?usage=1&sid=${encodeURIComponent(sid)}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A relay that another config dir started answers on our port: it reads that dir's config, so it is not ours to stop
function foreign(h) {
  if (!h?.configDir || L.sameDir(h.configDir, dir)) return false
  console.error(`The relay on 127.0.0.1:${h.port} (pid ${h.pid}) belongs to config dir ${h.configDir}, not ${dir}. Stop it there, or set another "port" in ${CFG_FILE}.`)
  process.exitCode = 1
  return true
}

async function start() {
  const h = await health()
  if (h?.ok && foreign(h)) return
  if (h?.ok) return console.log(`Relay already running on 127.0.0.1:${h.port} (pid ${h.pid}, ${h.version})`)
  const c = spawn(process.execPath, [path.join(here, 'relay.mjs'), dir], { detached: true, stdio: 'ignore', windowsHide: true })
  c.unref()
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    const up = await health()
    if (up?.ok) return console.log(`Relay started on 127.0.0.1:${up.port} (pid ${up.pid})`)
  }
  console.error(`Relay did not answer within 10 s; see ${L.logFile(dir)}`)
  process.exitCode = 1
}

// Returns whether the port is free for a new relay. ifIdle: leave a relay that answers a request (exit code 3).
async function stop(withProxy, ifIdle = false) {
  const h = await health()
  if (!h?.ok) {
    console.log('Relay is not running')
    if (withProxy) await stopProxy()
    return true
  }
  if (foreign(h)) return false
  // A relay that is answering a request is left alone. The relay checks again itself; this one covers relays from
  // before /__shutdown knew ifIdle.
  const busy = (n) => {
    console.log(`Relay (pid ${h.pid}) is answering ${n} request(s); not stopped. Run it again without --if-idle to stop it anyway.`)
    process.exitCode = 3
    return false
  }
  if (ifIdle && h.inflight > 0) return busy(h.inflight)
  const r = await request('POST', '/__shutdown', { proxy: withProxy, ifIdle })
  if (r?.busy) return busy(r.busy)
  if (!r?.ok) {
    console.log('Relay is not running')
    if (withProxy) await stopProxy()
    return true
  }
  console.log(`Relay stopped (pid ${r.pid})`)
  // Wait until the port is free so a restart can bind it
  for (let i = 0; i < 20 && (await health())?.ok; i++) await sleep(250)
  // The relay ends only a proxy it started; one from an earlier relay is stopped here
  if (withProxy) await (r.stoppedProxy ? reportProxyExit(r.stoppedProxy, 5000) : stopProxy())
  return true
}

// ---------- the Codex proxy ----------
const isRunning = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

async function reportProxyExit(pid, timeoutMs) {
  const until = Date.now() + timeoutMs
  while (isRunning(pid) && Date.now() < until) await sleep(200)
  if (!isRunning(pid)) return console.log(`Codex proxy stopped (pid ${pid})`)
  console.error(`Codex proxy (pid ${pid}) is still running`)
  process.exitCode = 1
}

// The process listening on `port`, as the system's own tools report it: { pid, name }, or null
function portOwner(port) {
  try {
    if (process.platform === 'win32') {
      const ps = `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p = Get-Process -Id $c.OwningProcess; "$($p.Id) $($p.ProcessName)" }`
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true }).trim()
      const m = /^(\d+) (.+)$/.exec(out)
      return m ? { pid: Number(m[1]), name: m[2] } : null
    }
    // -F: one field a line, p<pid> then c<command>; +c 0: the command name whole
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '+c', '0', '-Fpc'], { encoding: 'utf8' })
    const pid = /^p(\d+)$/m.exec(out)
    const name = /^c(.+)$/m.exec(out)
    return pid && name ? { pid: Number(pid[1]), name: name[1] } : null
  } catch {
    // lsof exits 1 when nothing listens
    return null
  }
}

// Stops the Codex proxy and leaves the relay running. A proxy with `stop` exits once its requests finish; an older one
// is ended by its process id, and only when the process on the port is the proxy.
async function stopProxy() {
  const { proxyPort, proxyCommand } = cfg()
  const asked = await request('POST', '/shutdown', undefined, 5000, proxyPort)
  if (asked?.ok && asked.pid) {
    const grace = Number(asked.graceSeconds) || 10
    console.log(`Codex proxy (pid ${asked.pid}) is stopping; requests in flight get ${grace} s to finish`)
    return reportProxyExit(asked.pid, (grace + 5) * 1000)
  }
  const owner = portOwner(proxyPort)
  if (!owner) return console.log(`Codex proxy is not running on 127.0.0.1:${proxyPort}`)
  const expected = path.parse(proxyCommand).name
  if (owner.name.toLowerCase() !== expected.toLowerCase()) {
    console.error(`127.0.0.1:${proxyPort} is held by ${owner.name} (pid ${owner.pid}), not ${expected}; not stopped`)
    process.exitCode = 1
    return
  }
  process.kill(owner.pid)
  console.log(`Codex proxy (pid ${owner.pid}) has no stop command; its process was ended`)
  return reportProxyExit(owner.pid, 5000)
}

// restart --if-stale: only a relay that runs older code than this copy; a newer one is left alone, so two sessions
// on different plugin versions never take turns restarting it
async function restart() {
  if (has('--if-stale')) {
    const h = await health()
    if (h?.ok && L.compareVersions(h.version || '0', VERSION) >= 0) {
      return console.log(`The relay (pid ${h.pid}) already runs ${h.version}; not restarted.`)
    }
  }
  if (await stop(has('--proxy'), has('--if-idle'))) await start()
}

// A plan has a 5-hour and a weekly window, or only one of them, in either slot: the length names it
const windowText = (w) => {
  const s = w.windowSeconds
  const label = s === 604800 ? 'weekly' : s > 0 && s % 86400 === 0 ? `${s / 86400}d` : s > 0 ? `${Math.round(s / 3600)}h` : 'usage'
  return `${label} ${Math.round(w.usedPercent)}%`
}

async function status(asJson) {
  const h = await health()
  if (asJson) return console.log(JSON.stringify(h ?? { ok: false }, null, 2))
  const c = cfg()
  console.log(`Config: ${CFG_FILE}${readRaw() ? '' : ' (not created, defaults in use)'}`)
  console.log(`Default route for new sessions: ${c.defaultRoute}`)
  if (!h?.ok) {
    console.log(`Relay: not running on 127.0.0.1:${c.port}`)
    process.exitCode = 1
    return
  }
  console.log(`Relay: up on 127.0.0.1:${h.port} (pid ${h.pid}, ${h.version}, ${h.pinnedSessions} pinned sessions)`)
  console.log(`Codex proxy: ${h.proxy.up ? 'up' : 'down'} on 127.0.0.1:${h.proxy.port} (${h.proxy.command})${h.proxy.error ? ` - ${h.proxy.error}` : ''}`)
  if (h.usage) {
    const windows = [h.usage.primary, h.usage.secondary].filter(Boolean).map(windowText)
    console.log(`Codex plan: ${h.usage.plan ?? '?'}, ${windows.join(', ') || 'no usage window'}${h.usage.allowed ? '' : ' (limit reached)'}`)
  } else if (h.usageError) {
    console.log(`Codex usage: ${h.usageError}`)
  } else {
    console.log('Codex usage: loading (run status again in a few seconds)')
  }
}

function writeConfig(patch) {
  let j = {}
  const raw = readRaw()
  if (raw) {
    try {
      j = JSON.parse(raw)
    } catch (e) {
      throw new Error(`${CFG_FILE} is not valid JSON (${e.message}); fix it first`)
    }
  }
  const next = { ...j, ...patch }
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${CFG_FILE}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`)
  fs.renameSync(tmp, CFG_FILE)
}

function setDefault(route) {
  if (route === undefined) return console.log(cfg().defaultRoute)
  if (!L.isRoute(route)) {
    console.error(`expected "claude" or "codex", got "${route}"`)
    process.exitCode = 2
    return
  }
  writeConfig({ defaultRoute: route })
  console.log(`New sessions start on ${route}. Sessions already started keep their route.`)
}

// `auto` drops the setting: the agents take the main conversation's effort again
function setEffort(level) {
  if (level === undefined) return console.log(cfg().agentEffort ?? 'auto')
  if (level !== 'auto' && !L.isEffort(level)) {
    console.error(`expected ${L.EFFORTS.join(', ')} or auto, got "${level}"`)
    process.exitCode = 2
    return
  }
  writeConfig({ agentEffort: level === 'auto' ? undefined : level })
  console.log(level === 'auto' ? "codex-relay:codex agents run at the main conversation's effort." : `codex-relay:codex agents run at ${level} effort.`)
}

const [cmd, ...args] = process.argv.slice(2)
const has = (flag) => args.includes(flag)
try {
  switch (cmd) {
    case 'start':
      await start()
      break
    case 'stop':
      await stop(has('--proxy'))
      break
    case 'stop-proxy':
      await stopProxy()
      break
    case 'restart':
      await restart()
      break
    case 'status':
      await status(has('--json'))
      break
    case 'wait': {
      // Waits up to N seconds (default 10) for the relay to answer; exit 0 once it does
      const until = Date.now() + (Number(args[0]) || 10) * 1000
      let up = await health()
      while (!up?.ok && Date.now() < until) {
        await sleep(300)
        up = await health()
      }
      if (!up?.ok) process.exitCode = 1
      break
    }
    case 'default':
      setDefault(args[0])
      break
    case 'effort':
      setEffort(args[0])
      break
    case 'config':
      console.log(JSON.stringify(cfg(), null, 2))
      break
    default:
      console.log(
        'Usage: node cli.mjs start | stop [--proxy] | stop-proxy | restart [--proxy] [--if-stale] [--if-idle] | status [--json] | default [claude|codex] | effort [low|medium|high|xhigh|max|auto] | config',
      )
      process.exitCode = cmd ? 2 : 0
  }
} catch (e) {
  console.error(e.message)
  process.exitCode = 1
}
