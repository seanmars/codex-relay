import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as L from './logic.mjs'
import contract from '../proxy/tests/fixtures/model-contract.mjs'

const cfg = (over = {}) => ({ ...L.parseConfig(''), ...over })

test('parseConfig falls back to defaults for a missing, broken or invalid file', () => {
  for (const raw of ['', '{', '[]', '{"port":80,"defaultRoute":"gemini","proxyCommand":"  "}']) {
    const c = L.parseConfig(raw)
    assert.equal(c.port, L.DEFAULT_PORT, raw)
    assert.equal(c.proxyPort, L.DEFAULT_PROXY_PORT, raw)
    assert.equal(c.defaultRoute, 'claude', raw)
    assert.equal(c.proxyCommand, 'claude-code-proxy', raw)
  }
  const c = L.parseConfig('{"port":9000,"proxyPort":19000,"defaultRoute":"codex","proxyCommand":"C:/bin/ccp.exe"}')
  assert.deepEqual([c.port, c.proxyPort, c.defaultRoute, c.proxyCommand], [9000, 19000, 'codex', 'C:/bin/ccp.exe'])
})

test('agentEffort keeps a known level and leaves anything else to Claude Code', () => {
  assert.equal(L.parseConfig('').agentEffort, null)
  assert.equal(L.parseConfig('{"agentEffort":"xhigh"}').agentEffort, 'xhigh')
  for (const bad of ['"turbo"', '"High"', '3', '""']) assert.equal(L.parseConfig(`{"agentEffort":${bad}}`).agentEffort, null, bad)
})

test("proxyOverrides reads the proxy's forced model and effort, and nothing from a proxy that does not say", () => {
  assert.deepEqual(L.proxyOverrides({ ok: true, codex: { model: 'gpt-6-sol', effort: '' } }), { model: 'gpt-6-sol', effort: null })
  assert.equal(L.proxyOverrides({ ok: true }), null)
  assert.equal(L.proxyOverrides(null), null)
})

test("proxyAuth reads the proxy's sign-in source and the configured one, and nothing from a proxy that does not say", () => {
  const healthz = { ok: true, codex: { model: null, effort: null, authSource: 'codex-cli', configuredAuthSource: 'proxy' } }
  assert.deepEqual(L.proxyAuth(healthz), { source: 'codex-cli', configured: 'proxy' })
  assert.equal(L.proxyAuth({ ok: true, codex: { model: null, effort: null } }), null)
  assert.equal(L.proxyAuth(null), null)
})

test('codexModelFor keeps Codex ids and maps any Claude id to its tier', () => {
  assert.equal(L.codexModelFor('gpt-6-sol[1m]'), 'gpt-6-sol')
  assert.equal(L.codexModelFor('claude-sonnet-4-5-20250929'), 'sonnet')
  assert.equal(L.codexModelFor('claude-opus-5-5[1m]'), 'opus')
  assert.equal(L.codexModelFor('claude-haiku-4-5'), 'haiku')
  assert.equal(L.codexModelFor('claude-fable-5'), 'fable')
  assert.equal(L.codexModelFor('mystery'), 'mystery')
})

test('isModelCall matches messages and count_tokens posts only', () => {
  assert.ok(L.isModelCall('POST', '/v1/messages'))
  assert.ok(L.isModelCall('POST', '/v1/messages?beta=true'))
  assert.ok(L.isModelCall('POST', '/v1/messages/count_tokens?beta=true'))
  assert.ok(!L.isModelCall('GET', '/v1/messages'))
  assert.ok(!L.isModelCall('POST', '/v1/messages/batches'))
  assert.ok(!L.isModelCall('GET', '/v1/models'))
})

test('a new session takes the default and keeps it after the default changes', () => {
  let state = L.parseState(null)
  const first = L.decide(state, cfg({ defaultRoute: 'codex' }), 'sid-a', 'claude-opus-4-8', 1000)
  assert.equal(first.route, 'codex')
  state = first.state
  const later = L.decide(state, cfg({ defaultRoute: 'claude' }), 'sid-a', 'claude-opus-4-8', 2000)
  assert.equal(later.route, 'codex')
  const other = L.decide(later.state, cfg({ defaultRoute: 'claude' }), 'sid-b', 'claude-opus-4-8', 2000)
  assert.equal(other.route, 'claude')
  assert.deepEqual(Object.keys(other.state.sticky).sort(), ['sid-a', 'sid-b'])
})

test('a Codex model id goes to Codex from a Claude session without pinning it', () => {
  const state = L.setSticky(L.parseState(null), 'sid', 'claude', 1)
  const d = L.decide(state, cfg(), 'sid', 'gpt-5.6-terra', 2)
  assert.equal(d.route, 'codex')
  assert.equal(d.state, state)
  assert.equal(L.sessionRoute(d.state, cfg(), 'sid').route, 'claude')
})

test('a call without a session id follows the default and pins nothing', () => {
  const state = L.parseState(null)
  const d = L.decide(state, cfg({ defaultRoute: 'codex' }), '', 'sonnet', 1)
  assert.equal(d.route, 'codex')
  assert.equal(d.state, state)
})

test('sticky entries expire after the TTL and bad entries are dropped', () => {
  const state = L.parseState({ sticky: { old: { route: 'codex', at: 0 }, new: { route: 'claude', at: L.STICKY_TTL_MS }, bad: { route: 'x', at: 1 } } })
  assert.deepEqual(Object.keys(state.sticky).sort(), ['new', 'old'])
  assert.deepEqual(Object.keys(L.pruneSticky(state, L.STICKY_TTL_MS + 1).sticky), ['new'])
})

test('isLocalRequest wants the relay port and no browser headers', () => {
  assert.ok(L.isLocalRequest({ host: '127.0.0.1:8960' }, 8960))
  assert.ok(L.isLocalRequest({ host: 'localhost:8960' }, 8960))
  assert.ok(!L.isLocalRequest({ host: '127.0.0.1:8950' }, 8960))
  assert.ok(!L.isLocalRequest({ host: 'evil.test:8960' }, 8960))
  assert.ok(!L.isLocalRequest({ host: '127.0.0.1:8960', origin: 'https://evil.test' }, 8960))
})

test('sameDir compares real paths, ignoring case and slashes on Windows only', () => {
  const tmp = fs.realpathSync.native(os.tmpdir())
  assert.ok(L.sameDir(tmp, `${tmp}${path.sep}`))
  assert.ok(L.sameDir(tmp.toUpperCase().replace(/\\/g, '/'), tmp, true))
  assert.ok(!L.sameDir(tmp, path.join(tmp, 'other'), true))
  assert.ok(!L.sameDir('/a/B', '/a/b', false))
})

test('compareVersions orders dotted versions, a missing part counting as 0', () => {
  assert.equal(L.compareVersions('0.1.0', '0.2.0'), -1)
  assert.equal(L.compareVersions('0.10.0', '0.9.9'), 1)
  assert.equal(L.compareVersions('1.0', '1.0.0'), 0)
})

test('sessionStats and usageSummary read the proxy answers', () => {
  const monitor = { version: 1, snapshot: { sessions: [{ session_id: 'sid', model: 'gpt-6-sol', request_count: 3, input_tokens: 1200, output_tokens: 80, last_status: 'ok' }] } }
  assert.deepEqual(L.sessionStats(monitor, 'sid'), {
    model: 'gpt-6-sol',
    requestedModel: null,
    resolvedModel: null,
    effort: null,
    requests: 3,
    failures: 0,
    inputTokens: 1200,
    outputTokens: 80,
    lastStatus: 'ok',
  })
  assert.equal(L.sessionStats(monitor, 'other'), null)
  assert.equal(L.sessionStats(null, 'sid'), null)
  const usage = L.usageSummary({
    plan_type: 'pro',
    rate_limit: { allowed: true, primary_window: { used_percent: 23.4, limit_window_seconds: 18000, reset_at: 5 }, secondary_window: null },
  })
  assert.deepEqual(usage, { plan: 'pro', allowed: true, primary: { usedPercent: 23.4, windowSeconds: 18000, resetAt: 5 }, secondary: null })
  assert.equal(L.usageSummary({}), null)
})

test('sessionStats turns the monitor model fields of the shared contract into its session.codex fields', () => {
  // The proxy and hook tests pin the two ends of the same file, so a renamed field fails a test
  const stats = L.sessionStats(contract.monitor, contract.sessionId)
  assert.deepEqual({ model: stats.model, requestedModel: stats.requestedModel, resolvedModel: stats.resolvedModel }, contract.codex)
})

test('agentStats turns the subagent requests of the shared contract into session.agents', () => {
  assert.deepEqual({ ...L.agentStats(contract.agents.monitor, contract.agents.sessionId) }, contract.agents.stats)
})

test('agentStats leaves out the main conversation, other sessions and a proxy without agent ids', () => {
  const req = (over) => ({ session_id: 's1', agent_id: 'a1', requested_model: 'opus', resolved_model: 'gpt-6-sol', effort: 'low', ...over })
  const monitor = {
    snapshot: {
      recent: [req({ agent_id: null }), req({ session_id: 's2' }), req({ effort: null }), req({ effort: 'xhigh', requested_model: null, resolved_model: null })],
      active: [],
    },
  }
  // A request without a model or effort keeps the earlier one's
  assert.deepEqual({ ...L.agentStats(monitor, 's1') }, { a1: { requestedModel: 'opus', resolvedModel: 'gpt-6-sol', effort: 'xhigh', requests: 2 } })
  assert.deepEqual({ ...L.agentStats(monitor, '') }, {})
  assert.deepEqual({ ...L.agentStats(null, 's1') }, {})
  assert.deepEqual({ ...L.agentStats({ snapshot: { recent: [{ session_id: 's1', model: 'opus' }] } }, 's1') }, {})
})
