// codex-relay command line. Usage: node cli.mjs <command> [args]
//   start | stop [--proxy] | restart [--proxy] | status [--json] | default [claude|codex] | config | wait [seconds]
// The config directory is $CLAUDE_CONFIG_DIR, or ~/.claude.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
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

function request(method, urlPath, body, timeoutMs = 2000) {
  const { port } = cfg()
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
    r.on('timeout', () => r.destroy())
    r.end(data)
  })
}

const health = (sid = '') => request('GET', `/__health?usage=1&sid=${encodeURIComponent(sid)}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function start() {
  const h = await health()
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

async function stop(withProxy) {
  const r = await request('POST', '/__shutdown', { proxy: withProxy })
  if (!r?.ok) return console.log('Relay is not running')
  console.log(`Relay stopped (pid ${r.pid})${r.stoppedProxy ? `, Codex proxy stopped (pid ${r.stoppedProxy})` : ''}`)
  // Wait until the port is free so a restart can bind it
  for (let i = 0; i < 20 && (await health())?.ok; i++) await sleep(250)
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
    case 'restart':
      await stop(has('--proxy'))
      await start()
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
    case 'config':
      console.log(JSON.stringify(cfg(), null, 2))
      break
    default:
      console.log('Usage: node cli.mjs start | stop [--proxy] | restart [--proxy] | status [--json] | default [claude|codex] | config')
      process.exitCode = cmd ? 2 : 0
  }
} catch (e) {
  console.error(e.message)
  process.exitCode = 1
}
