// End-to-end: a real relay process between a fake Anthropic and a fake Codex proxy
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

function fakeServer(name, extra = () => false) {
  const seen = []
  const server = http.createServer((req, res) => {
    const ch = []
    req.on('data', (c) => ch.push(c))
    req.on('end', () => {
      const body = Buffer.concat(ch).toString('utf8')
      if (extra(req, res)) return
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ from: name }))
    })
  })
  return { server, seen }
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
const freePort = async () => {
  const s = http.createServer()
  const port = await listen(s)
  await new Promise((r) => s.close(r))
  return port
}

function call(port, method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const r = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      const ch = []
      res.on('data', (c) => ch.push(c))
      res.on('end', () => {
        const text = Buffer.concat(ch).toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        } catch {}
        resolve({ status: res.statusCode, json, text })
      })
    })
    r.on('error', reject)
    r.end(data)
  })
}

// GET /slow is answered only when the test calls releaseSlow, so it stays in flight until then
let releaseSlow = () => {}
const anthropic = fakeServer('anthropic', (req, res) => {
  if (req.url !== '/slow') return false
  releaseSlow = () => res.end('{}')
  res.writeHead(200, { 'content-type': 'application/json' })
  return true
})
const monitorSessions = []
const proxy = fakeServer('proxy', (req, res) => {
  if (req.url !== '/monitor') return false
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ version: 1, snapshot: { sessions: monitorSessions } }))
  return true
})
let dir
let relayPort
let relay

// Starts a relay for a config dir with this config, and waits until it answers
async function startRelay(configDir, cfg, cwd) {
  fs.writeFileSync(path.join(configDir, 'codex-relay.json'), JSON.stringify(cfg))
  const child = spawn(process.execPath, [path.join(here, 'relay.mjs'), configDir], { stdio: 'ignore', cwd })
  for (let i = 0; i < 50; i++) {
    const up = await call(cfg.port, 'GET', '/__health').catch(() => null)
    if (up?.json?.ok) return child
    await new Promise((r) => setTimeout(r, 100))
  }
  child.kill()
  throw new Error('relay did not start')
}

before(async () => {
  const anthropicPort = await listen(anthropic.server)
  const proxyPort = await listen(proxy.server)
  relayPort = await freePort()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-relay-test-'))
  relay = await startRelay(dir, { port: relayPort, proxyPort, claudeUrl: `http://127.0.0.1:${anthropicPort}`, proxyCommand: path.join(dir, 'missing-proxy') })
})

after(async () => {
  relay.kill()
  anthropic.server.close()
  proxy.server.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const message = (model) => ({ model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] })
const sidHeaders = (sid) => ({ 'x-claude-code-session-id': sid, authorization: 'Bearer claude-oauth', host: `127.0.0.1:${relayPort}` })

test('a session on the default route reaches Anthropic unchanged, credentials included', async () => {
  const r = await call(relayPort, 'POST', '/v1/messages?beta=true', { body: message('claude-opus-4-8'), headers: sidHeaders('sid-claude') })
  assert.equal(r.json.from, 'anthropic')
  const last = anthropic.seen.at(-1)
  assert.equal(last.url, '/v1/messages?beta=true')
  assert.equal(last.headers.authorization, 'Bearer claude-oauth')
  assert.equal(last.body.model, 'claude-opus-4-8')
})

test('a session switched to codex reaches the proxy with a tier model and no Claude credentials', async () => {
  const set = await call(relayPort, 'POST', '/__session', { body: { sid: 'sid-codex', route: 'codex' } })
  assert.equal(set.json.session.route, 'codex')
  const r = await call(relayPort, 'POST', '/v1/messages', { body: message('claude-sonnet-4-5-20250929'), headers: sidHeaders('sid-codex') })
  assert.equal(r.json.from, 'proxy')
  const last = proxy.seen.at(-1)
  assert.equal(last.body.model, 'sonnet')
  assert.equal(last.headers.authorization, undefined)
  const counted = await call(relayPort, 'POST', '/v1/messages/count_tokens', { body: message('claude-sonnet-4-5'), headers: sidHeaders('sid-codex') })
  assert.equal(counted.json.from, 'proxy')
})

test('a Codex model id reaches the proxy from a Claude session, which stays on Claude', async () => {
  const r = await call(relayPort, 'POST', '/v1/messages', { body: message('gpt-5.6-terra'), headers: sidHeaders('sid-claude') })
  assert.equal(r.json.from, 'proxy')
  assert.equal(proxy.seen.at(-1).body.model, 'gpt-5.6-terra')
  const h = await call(relayPort, 'GET', '/__health?sid=sid-claude')
  assert.equal(h.json.session.route, 'claude')
})

test('requests that are not model calls go to Anthropic even for a codex session', async () => {
  const r = await call(relayPort, 'GET', '/v1/models', { headers: sidHeaders('sid-codex') })
  assert.equal(r.json.from, 'anthropic')
  assert.equal(anthropic.seen.at(-1).url, '/v1/models')
})

test('health reports the session route and its Codex usage from the proxy monitor', async () => {
  monitorSessions.push({ session_id: 'sid-codex', model: 'gpt-5.6-terra', request_count: 2, input_tokens: 900, output_tokens: 40 })
  const h = await call(relayPort, 'GET', '/__health?sid=sid-codex')
  assert.equal(h.json.session.route, 'codex')
  assert.equal(h.json.session.pinned, true)
  assert.equal(h.json.proxy.up, true)
  assert.equal(h.json.session.codex.inputTokens, 900)
  assert.equal(h.json.session.codex.model, 'gpt-5.6-terra')
})

test('a browser or another host is refused', async () => {
  const foreign = await call(relayPort, 'GET', '/__health', { headers: { host: 'evil.test' } })
  assert.equal(foreign.status, 403)
  const browser = await call(relayPort, 'GET', '/__health', { headers: { origin: 'https://evil.test' } })
  assert.equal(browser.status, 403)
  const before = anthropic.seen.length
  const absolute = await call(relayPort, 'POST', 'http://evil.test/v1/messages', { body: message('claude-opus-4-8'), headers: sidHeaders('sid-claude') })
  assert.equal(absolute.status, 403)
  assert.equal(anthropic.seen.length, before)
})

test('health names the config dir, and a shutdown asked to wait for idle refuses while a request is in flight', async () => {
  const h = await call(relayPort, 'GET', '/__health')
  assert.equal(h.json.configDirArg, dir)
  assert.equal(h.json.configDir, fs.realpathSync.native(dir))
  const slow = call(relayPort, 'GET', '/slow')
  await new Promise((r) => setTimeout(r, 200))
  const busy = await call(relayPort, 'POST', '/__shutdown', { body: { ifIdle: true } })
  assert.equal(busy.status, 409)
  assert.equal(busy.json.busy, 1)
  releaseSlow()
  await slow
  assert.equal((await call(relayPort, 'GET', '/__health')).json.ok, true)
})

test('a codex call with the proxy down and no proxy command answers 502 with the reason', async () => {
  proxy.server.close()
  await new Promise((r) => setTimeout(r, 100))
  const r = await call(relayPort, 'POST', '/v1/messages', { body: message('opus'), headers: sidHeaders('sid-codex') })
  assert.equal(r.status, 502)
  assert.equal(r.json.type, 'error')
  assert.match(r.json.error.message, /cannot start/)
})

test('a second relay on a taken port exits quietly for the same config dir and names the other dir otherwise', async () => {
  const exitCode = (configDir) =>
    new Promise((resolve) => spawn(process.execPath, [path.join(here, 'relay.mjs'), configDir], { stdio: 'ignore' }).on('exit', resolve))
  assert.equal(await exitCode(dir), 0)
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-relay-other-'))
  try {
    fs.writeFileSync(path.join(other, 'codex-relay.json'), JSON.stringify({ port: relayPort }))
    assert.equal(await exitCode(other), 1)
    assert.ok(fs.readFileSync(path.join(other, 'codex-relay.log'), 'utf8').includes(fs.realpathSync.native(dir)))
  } finally {
    fs.rmSync(other, { recursive: true, force: true })
  }
})

test('a codex call whose caller left while the proxy was starting never reaches the proxy', async () => {
  const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-relay-left-'))
  // The relay runs `<proxyCommand> serve --port N`: with node as the command, this file is the proxy. It opens its
  // port after 1.5 s, records every model call it gets, and quits by itself.
  fs.writeFileSync(
    path.join(cdir, 'serve'),
    `const http = require('http'), fs = require('fs'), path = require('path')
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
setTimeout(() => http.createServer((req, res) => {
  if (req.method === 'POST') fs.appendFileSync(path.join(__dirname, 'seen.txt'), req.url + '\\n')
  res.end('{}')
}).listen(port, '127.0.0.1'), 1500)
setTimeout(() => process.exit(0), 5000)
`,
  )
  const port = await freePort()
  const left = await startRelay(cdir, { port, proxyPort: await freePort(), proxyCommand: process.execPath }, cdir)
  try {
    await new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json' } })
      r.on('error', resolve)
      r.end(JSON.stringify(message('gpt-5.6-terra')))
      setTimeout(() => (r.destroy(), resolve()), 300)
    })
    await new Promise((r) => setTimeout(r, 3000))
    assert.equal(fs.existsSync(path.join(cdir, 'seen.txt')), false)
  } finally {
    await call(port, 'POST', '/__shutdown', { body: { proxy: true } }).catch(() => null)
    left.kill()
    if (left.exitCode === null && left.signalCode === null) await new Promise((r) => left.once('exit', r))
    // Windows keeps a directory that is still a process's working directory
    for (let i = 0; i < 40; i++) {
      try {
        fs.rmSync(cdir, { recursive: true, force: true })
        break
      } catch {
        await new Promise((r) => setTimeout(r, 250))
      }
    }
  }
})

test('pinned sessions are saved for the next relay', async () => {
  await call(relayPort, 'POST', '/__shutdown', { body: {} })
  await new Promise((r) => setTimeout(r, 300))
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'codex-relay-state.json'), 'utf8'))
  assert.equal(saved.sticky['sid-codex'].route, 'codex')
  assert.equal(saved.sticky['sid-claude'].route, 'claude')
})
