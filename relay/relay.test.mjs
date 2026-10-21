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

const anthropic = fakeServer('anthropic')
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

before(async () => {
  const anthropicPort = await listen(anthropic.server)
  const proxyPort = await listen(proxy.server)
  relayPort = await freePort()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-relay-test-'))
  fs.writeFileSync(
    path.join(dir, 'codex-relay.json'),
    JSON.stringify({ port: relayPort, proxyPort, claudeUrl: `http://127.0.0.1:${anthropicPort}`, proxyCommand: path.join(dir, 'missing-proxy') }),
  )
  relay = spawn(process.execPath, [path.join(here, 'relay.mjs'), dir], { stdio: 'ignore' })
  for (let i = 0; i < 50; i++) {
    const up = await call(relayPort, 'GET', '/__health').catch(() => null)
    if (up?.json?.ok) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('relay did not start')
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
})

test('a codex call with the proxy down and no proxy command answers 502 with the reason', async () => {
  proxy.server.close()
  await new Promise((r) => setTimeout(r, 100))
  const r = await call(relayPort, 'POST', '/v1/messages', { body: message('opus'), headers: sidHeaders('sid-codex') })
  assert.equal(r.status, 502)
  assert.equal(r.json.type, 'error')
  assert.match(r.json.error.message, /cannot start/)
})

test('pinned sessions are saved for the next relay', async () => {
  await call(relayPort, 'POST', '/__shutdown', { body: {} })
  await new Promise((r) => setTimeout(r, 300))
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'codex-relay-state.json'), 'utf8'))
  assert.equal(saved.sticky['sid-codex'].route, 'codex')
  assert.equal(saved.sticky['sid-claude'].route, 'claude')
})
