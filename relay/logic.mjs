// Pure helpers for the relay: config, routing decisions and sticky session state. No I/O beyond path math and
// resolving a directory's real path.
import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_PORT = 8960
export const DEFAULT_PROXY_PORT = 8970
export const ROUTES = ['claude', 'codex']
export const STICKY_TTL_MS = 7 * 24 * 3600e3

export const isPort = (n) => Number.isInteger(n) && n > 1024 && n < 65536
export const isRoute = (r) => ROUTES.includes(r)

export function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(env.USERPROFILE || env.HOME || '', '.claude')
}

// Two spellings of one directory (drive-letter case, slashes, symlinks) are the same config dir; the relay, the CLI and
// the hook use this to tell whose relay answers on a port
export function realDir(d) {
  try {
    return fs.realpathSync.native(d)
  } catch {
    return path.resolve(d)
  }
}
const dirKey = (d, win) => (win ? d.replace(/\\/g, '/').toLowerCase() : d)
export const sameDir = (a, b, win = process.platform === 'win32') => dirKey(realDir(a), win) === dirKey(realDir(b), win)

// -1, 0 or 1 for dotted numeric versions; a missing part counts as 0
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

export const configFile = (dir) => path.join(dir, 'codex-relay.json')
export const stateFile = (dir) => path.join(dir, 'codex-relay-state.json')
export const logFile = (dir) => path.join(dir, 'codex-relay.log')

// A missing or broken file is the defaults: the relay must keep routing while someone edits the file
export function parseConfig(raw) {
  let j = {}
  try {
    j = raw ? JSON.parse(raw) : {}
  } catch {
    j = {}
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) j = {}
  const str = (v, d) => (typeof v === 'string' && v.trim() ? v.trim() : d)
  return {
    port: isPort(j.port) ? j.port : DEFAULT_PORT,
    proxyPort: isPort(j.proxyPort) ? j.proxyPort : DEFAULT_PROXY_PORT,
    proxyCommand: str(j.proxyCommand, 'claude-code-proxy'),
    defaultRoute: isRoute(j.defaultRoute) ? j.defaultRoute : 'claude',
    agentModel: str(j.agentModel, 'gpt-5.6-terra'),
    // null leaves the effort to Claude Code
    agentEffort: isEffort(j.agentEffort) ? j.agentEffort : null,
    claudeUrl: str(j.claudeUrl, 'https://api.anthropic.com'),
  }
}

// The levels an agent definition takes, as Claude Code sends them
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const isEffort = (v) => EFFORTS.includes(v)

const stripHint = (model) => String(model || '').replace(/\[1m\]$/i, '')

// Codex model ids reach Codex from any session, which is how a codex-relay:codex subagent runs on Codex
export const isCodexModel = (model) => /^gpt-/i.test(stripHint(model))

// Codex only knows the bare tier aliases and a few Claude ids; any other Claude id is mapped to its tier
export function codexModelFor(model) {
  const bare = stripHint(model)
  if (isCodexModel(bare)) return bare
  const tier = /(haiku|sonnet|opus|fable)/i.exec(bare)
  return tier ? tier[1].toLowerCase() : bare
}

export function isModelCall(method, url) {
  return method === 'POST' && /^\/v1\/messages(?:\/count_tokens)?(?:\?|$)/.test(String(url || ''))
}

// Control paths answer local programs only: the relay's own Host and no browser
const LOCAL_HOST_RE = /^(127\.0\.0\.1|localhost):(\d+)$/i
export function isLocalRequest(headers, port) {
  const m = LOCAL_HOST_RE.exec(String((headers && headers.host) || ''))
  if (!m || Number(m[2]) !== port) return false
  return headers.origin === undefined && headers['sec-fetch-site'] === undefined
}

export function parseState(raw) {
  let j = raw
  if (typeof raw === 'string') {
    try {
      j = JSON.parse(raw)
    } catch {
      j = null
    }
  }
  const sticky = Object.create(null)
  if (j && j.sticky && typeof j.sticky === 'object') {
    for (const [sid, e] of Object.entries(j.sticky)) {
      if (e && isRoute(e.route) && Number.isFinite(e.at)) sticky[sid] = { route: e.route, at: e.at }
    }
  }
  return { sticky }
}

export function pruneSticky(state, now) {
  const sticky = Object.create(null)
  for (const [sid, e] of Object.entries(state.sticky)) {
    if (now - e.at < STICKY_TTL_MS) sticky[sid] = e
  }
  return { ...state, sticky }
}

export function setSticky(state, sid, route, now) {
  if (!sid || !isRoute(route)) return state
  return { ...state, sticky: Object.assign(Object.create(null), state.sticky, { [sid]: { route, at: now } }) }
}

// The route of a session's model call. A session takes the default on its first call and keeps it, so changing
// the default later never moves a running conversation (and never rebuilds its prompt cache).
// Returns { route, state }: state is new when the call pinned or refreshed the session.
export function decide(state, cfg, sid, model, now) {
  if (isCodexModel(model)) return { route: 'codex', state }
  if (!sid) return { route: cfg.defaultRoute, state }
  const pinned = state.sticky[sid]
  const route = pinned ? pinned.route : cfg.defaultRoute
  return { route, state: setSticky(state, sid, route, now) }
}

export function sessionRoute(state, cfg, sid) {
  const pinned = sid ? state.sticky[sid] : undefined
  return { route: pinned ? pinned.route : cfg.defaultRoute, pinned: Boolean(pinned) }
}

// Picks this session out of the proxy's /monitor answer. `model` is the proxy's display text; the status line
// reads `requestedModel` and `resolvedModel`, which a proxy without them leaves null.
export function sessionStats(monitor, sid) {
  const sessions = monitor && monitor.snapshot && Array.isArray(monitor.snapshot.sessions) ? monitor.snapshot.sessions : []
  const s = sid ? sessions.find((x) => x && x.session_id === sid) : undefined
  if (!s) return null
  return {
    model: s.model || null,
    requestedModel: s.requested_model || null,
    resolvedModel: s.resolved_model || null,
    effort: s.effort || null,
    requests: s.request_count || 0,
    failures: s.failure_count || 0,
    inputTokens: s.input_tokens || 0,
    outputTokens: s.output_tokens || 0,
    lastStatus: s.last_status || null,
  }
}

// This session's subagents out of the proxy's /monitor answer, by the agent id Claude Code sends: the model and effort
// of each one's latest request. The proxy keeps only its latest requests, so an agent quiet for long drops out.
export function agentStats(monitor, sid) {
  const snapshot = monitor && monitor.snapshot
  const list = (key) => (snapshot && Array.isArray(snapshot[key]) ? snapshot[key] : [])
  const agents = Object.create(null)
  if (!sid) return agents
  // Oldest first, so the latest request writes last: `recent` is newest first, `active` oldest first
  for (const r of [...list('recent')].reverse().concat(list('active'))) {
    if (!r || r.session_id !== sid || typeof r.agent_id !== 'string' || !r.agent_id) continue
    const a = (agents[r.agent_id] ??= { requestedModel: null, resolvedModel: null, effort: null, requests: 0 })
    a.requests++
    // The model fields move together so the pair always names one request
    if (r.requested_model || r.resolved_model) {
      a.requestedModel = r.requested_model || null
      a.resolvedModel = r.resolved_model || null
    }
    a.effort = r.effort || a.effort
  }
  return agents
}

// The Codex model and effort the proxy's config forces on every request, out of its /healthz answer; null from a
// proxy that does not say
export function proxyOverrides(healthz) {
  const c = healthz && healthz.codex
  if (!c || typeof c !== 'object') return null
  return { model: c.model || null, effort: c.effort || null }
}

// The sign-in source the running proxy reads and the one its config names now, out of its /healthz answer; null from
// a proxy that does not say. They differ after `codex auth source` until the proxy restarts.
export function proxyAuth(healthz) {
  const c = healthz && healthz.codex
  if (!c || typeof c.authSource !== 'string' || typeof c.configuredAuthSource !== 'string') return null
  return { source: c.authSource, configured: c.configuredAuthSource }
}

// The two plan windows out of `claude-code-proxy codex usage --json`
export function usageSummary(usage) {
  const rl = usage && usage.rate_limit
  if (!rl) return null
  const win = (w) =>
    w ? { usedPercent: Number(w.used_percent) || 0, windowSeconds: w.limit_window_seconds || 0, resetAt: w.reset_at || 0 } : null
  return { plan: usage.plan_type || null, allowed: rl.allowed !== false, primary: win(rl.primary_window), secondary: win(rl.secondary_window) }
}

export function upstreamPath(base, reqUrl) {
  return new URL(base).pathname.replace(/\/$/, '') + reqUrl
}
