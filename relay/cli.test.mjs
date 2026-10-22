// The relay CLI's stop-proxy against stand-in proxies: child processes the test starts on a port
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const freePort = () =>
  new Promise((resolve) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

const isRunning = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

// A node process on `port`: with `stoppable`, it answers POST /shutdown as the proxy does and exits; without, it
// answers 404 as a proxy older than `stop` does. It is ended after the test, whatever the test did.
async function standIn(t, port, stoppable) {
  const script = `
    const http = require('node:http')
    const server = http.createServer((req, res) => {
      if (${stoppable} && req.method === 'POST' && req.url === '/shutdown') {
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, pid: process.pid, graceSeconds: 1 }), () => process.exit(0))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found', message: 'No route' } }))
    })
    server.listen(${port}, '127.0.0.1', () => console.log('ready'))
  `
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] })
  t.after(() => {
    if (isRunning(child.pid)) child.kill()
  })
  await new Promise((resolve) => child.stdout.once('data', resolve))
  return child
}

// Runs the CLI for a fresh config dir whose proxy is on `proxyPort`, and whose relay port nothing answers on
async function cli(args, cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-relay-cli-'))
  fs.writeFileSync(path.join(dir, 'codex-relay.json'), JSON.stringify({ port: await freePort(), ...cfg }))
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, 'cli.mjs'), ...args], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (out += c))
    child.on('exit', (code) => resolve({ code, out }))
  })
}

test('stop-proxy asks a proxy with /shutdown to stop and waits for its process to end', async (t) => {
  const port = await freePort()
  const proxy = await standIn(t, port, true)
  const r = await cli(['stop-proxy'], { proxyPort: port })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, new RegExp(`Codex proxy stopped \\(pid ${proxy.pid}\\)`))
  assert.equal(isRunning(proxy.pid), false)
})

test('stop --proxy without a relay still stops the proxy', async (t) => {
  const port = await freePort()
  const proxy = await standIn(t, port, true)
  const r = await cli(['stop', '--proxy'], { proxyPort: port })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /Relay is not running/)
  assert.match(r.out, /Codex proxy stopped/)
  assert.equal(isRunning(proxy.pid), false)
})

test('stop-proxy ends an older proxy by its process id, and only when the process is the proxy', async (t) => {
  const port = await freePort()
  const holder = await standIn(t, port, false)
  // The process on the port is node, not claude-code-proxy: left running
  const refused = await cli(['stop-proxy'], { proxyPort: port })
  assert.equal(refused.code, 1, refused.out)
  assert.match(refused.out, /not stopped/)
  assert.equal(isRunning(holder.pid), true)

  // With node as the proxy command, the same process is the proxy
  const ended = await cli(['stop-proxy'], { proxyPort: port, proxyCommand: process.execPath })
  assert.equal(ended.code, 0, ended.out)
  assert.match(ended.out, /its process was ended/)
  assert.equal(isRunning(holder.pid), false)
})

test('stop-proxy with nothing on the port says the proxy is not running', async () => {
  const r = await cli(['stop-proxy'], { proxyPort: await freePort() })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /not running/)
})
