// Pure helpers for the hooks module: no engine calls, so tests run them directly
import type { AgentCodexStats, CodexStats, Health, Route, Subagent, Subagents, Usage, UsageWindow } from '../types'

export type LocalCfg = { port: number; proxyPort: number; proxyCommand: string; agentModel: string; nodePath: string }

const isPort = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 1024 && (n as number) < 65536
const str = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v.trim() : d)

// The hook reads only what it needs to reach the relay and start it; the relay reads the rest itself
export function parseLocalCfg(raw: string | undefined): LocalCfg {
  let j: Record<string, unknown> = {}
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) j = parsed as Record<string, unknown>
  } catch {}
  return {
    port: isPort(j.port) ? j.port : 8960,
    proxyPort: isPort(j.proxyPort) ? j.proxyPort : 8970,
    proxyCommand: str(j.proxyCommand, 'claude-code-proxy'),
    agentModel: str(j.agentModel, 'gpt-5.6-terra'),
    nodePath: str(j.nodePath, 'node'),
  }
}

export const relayUrl = (cfg: LocalCfg) => `http://127.0.0.1:${cfg.port}`

export function parseHealth(text: string): Health | null {
  try {
    const j = JSON.parse(text) as Health
    return j && j.ok === true && j.session && j.proxy ? j : null
  } catch {
    return null
  }
}

export const isRoute = (v: string): v is Route => v === 'claude' || v === 'codex'

// The directory of a relay that answers on our port but serves another config dir; null when it is ours
export function foreignConfigDir(h: Health | null, myDir: string, isWin: boolean): string | null {
  const dirs = [h?.configDir, h?.configDirArg].filter((d): d is string => typeof d === 'string' && d.length > 0)
  if (dirs.length === 0) return null
  const key = (d: string) => {
    const s = d.replace(/\\/g, '/').replace(/\/+$/, '')
    return isWin ? s.toLowerCase() : s
  }
  return dirs.some((d) => key(d) === key(myDir)) ? null : dirs[0]!
}

export const foreignReport = (cfg: LocalCfg, dir: string) =>
  `codex-relay: ${relayUrl(cfg)} 是另一個 config dir (${dir}) 的 relay, 這個視窗直連 Claude. 在 codex-relay.json 為兩邊設定不同的 port.`

// -1, 0 or 1 for dotted numeric versions; a missing part counts as 0
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

// The relay runs older code than this plugin. A newer relay is left alone, so two sessions on different plugin
// versions never take turns restarting it.
export const relayIsStale = (h: Health, pluginVersion: string) =>
  Boolean(h.version && pluginVersion && compareVersions(h.version, pluginVersion) < 0)

export const AGENT_NAME = 'codex'
export const AGENT_TYPE = `codex-relay:${AGENT_NAME}`

export function agentSpec(model: string) {
  return {
    name: AGENT_NAME,
    description: `General-purpose agent that runs on OpenAI Codex (${model}) through codex-relay. Same full toolset as the default Agent tool.`,
    prompt:
      "You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message, use the available tools to complete the task fully and report your findings and changes clearly and concisely.",
    model,
  }
}

// What an Agent row shows after its description. Codex's answer wins over what Claude Code asked for: the proxy may
// map the model to another and override the effort.
export function subagentLabel(s: Subagent | undefined): string {
  if (!s) return ''
  const model = s.codex ? `Codex ${s.codex.resolvedModel || s.codex.requestedModel || ''}`.trim() : s.model
  const effort = s.codex ? s.codex.effort : s.effort
  return [model, effort].filter(Boolean).join(' · ')
}

// `all` itself when nothing changed: each write redraws every Agent row
function patched(all: Subagents, toolUseId: string, patch: Subagent): Subagents {
  const before = all[toolUseId] ?? {}
  const after = { ...before, ...patch }
  return JSON.stringify(after) === JSON.stringify(before) ? all : { ...all, [toolUseId]: after }
}

const rowOf = (all: Subagents, agentId: string) => Object.keys(all).find((id) => all[id]?.agentId === agentId)

// A spawn names the row's agent and the model Claude Code started it on
export function withSpawn(all: Subagents, toolUseId: string, agentId: string | undefined, model: string): Subagents {
  return patched(all, toolUseId, agentId ? { agentId, model } : { model })
}

// Each model request of the agent's loop: the model and effort Claude Code sends
export function withStep(all: Subagents, agentId: string, model: string, effort: string | number | undefined): Subagents {
  const id = rowOf(all, agentId)
  return id ? patched(all, id, effort === undefined ? { model } : { model, effort: String(effort) }) : all
}

// The relay's session.agents: what Codex answered each agent with. An agent the relay no longer reports keeps its last.
export function withCodex(all: Subagents, agents: Record<string, AgentCodexStats> | undefined): Subagents {
  let next = all
  for (const [agentId, codex] of Object.entries(agents ?? {})) {
    const id = rowOf(next, agentId)
    if (id) next = patched(next, id, { codex })
  }
  return next
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1e6) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1e6).toFixed(1)}M`
}

const pct = (w: UsageWindow) => `${Math.round(w.usedPercent)}%`

// A plan has a 5-hour and a weekly window, or only one of them, in either slot: the length names it
export function windowLabel(w: UsageWindow): string {
  const s = w.windowSeconds
  if (s === 604800) return '週'
  if (s > 0 && s % 86400 === 0) return `${s / 86400}d`
  if (s > 0) return `${Math.round(s / 3600)}h`
  return '用量'
}

const usageWindows = (u: Usage) => [u.primary, u.secondary].filter((w): w is UsageWindow => w !== null)

// The model that answered this session, or the one it asked for until the proxy resolves it. A relay or proxy
// without the structured fields sends only the display text `opus → gpt-6-sol`, whose last part answered.
export function answeringModel(c: CodexStats | null): string {
  if (!c) return ''
  const structured = c.resolvedModel || c.requestedModel
  if (structured) return structured
  return c.model ? (c.model.split('→').at(-1) ?? c.model).trim() : ''
}

function resetIn(w: UsageWindow, nowSec: number): string {
  if (!w.resetAt) return ''
  const s = Math.max(0, w.resetAt - nowSec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h >= 24 ? `${Math.floor(h / 24)}d${h % 24}h` : h > 0 ? `${h}h${m}m` : `${m}m`
}

export const RELAY_ICON = '⇄'

// One line under the prompt: where this window goes and, on Codex, how full its context is and what the plan has used
export function statusText(h: Health | null, contextPercent?: number): string {
  return `${RELAY_ICON} ${statusBody(h, contextPercent)}`
}

export const foreignStatusText = (dir: string) => `${RELAY_ICON} port 屬於 ${dir} 的 relay: 直連 Claude`

function statusBody(h: Health | null, contextPercent?: number): string {
  if (!h) return 'codex-relay 離線: 直連 Claude'
  if (h.session.route === 'claude') return h.defaultRoute === 'codex' ? 'Claude (此視窗) · 新 session 預設 Codex' : 'Claude'
  if (h.proxy.error && !h.proxy.up) return `Codex: proxy 無法啟動 (${h.proxy.error.slice(0, 60)})`
  const c = h.session.codex
  const parts = [`Codex ${answeringModel(c)}`.trim()]
  if (contextPercent !== undefined) parts.push(`ctx ${Math.round(contextPercent)}%`)
  if (h.usage) {
    const windows = usageWindows(h.usage).map((w) => `${windowLabel(w)} ${pct(w)}`)
    if (windows.length) parts.push(windows.join(' · '))
    if (!h.usage.allowed) parts.push('已達上限')
  }
  return parts.join(' · ')
}

// The text answer of /relay status
export function statusReport(h: Health | null, cfg: LocalCfg, nowSec: number): string {
  if (!h) {
    return [
      `Relay: 沒有回應 (${relayUrl(cfg)}), 這個視窗直連 Claude.`,
      `執行 /relay start 啟動, 或查看 ~/.claude/codex-relay.log.`,
    ].join('\n')
  }
  const lines = [
    `這個視窗: ${h.session.route === 'codex' ? 'Codex' : 'Claude'}${h.session.pinned ? ' (已固定)' : ' (尚未送出 request, 將使用預設)'}`,
    `新 session 預設: ${h.defaultRoute === 'codex' ? 'Codex' : 'Claude'}`,
    `Relay: ${relayUrl(cfg)} (pid ${h.pid}, ${h.version}, 固定的 session: ${h.pinnedSessions})`,
    `Codex proxy: ${h.proxy.up ? '執行中' : '未執行'} 127.0.0.1:${h.proxy.port} (${h.proxy.command})${h.proxy.error ? `\n  錯誤: ${h.proxy.error}` : ''}`,
  ]
  const c = h.session.codex
  if (c) {
    lines.push(
      `這個視窗的 Codex 用量: ${c.model ?? '?'}${c.effort ? ` (${c.effort})` : ''}, ${c.requests} 個 request, ${fmtTokens(c.inputTokens)} in / ${fmtTokens(c.outputTokens)} out${c.failures ? `, ${c.failures} 個失敗` : ''}`,
    )
  }
  if (h.usage) {
    const u = h.usage
    const windows = usageWindows(u).map((w) => `${windowLabel(w)} ${pct(w)} (${resetIn(w, nowSec) || '-'} 後重置)`)
    lines.push(`Codex 方案: ${u.plan ?? '?'}, ${windows.join(', ') || '沒有用量視窗'}${u.allowed ? '' : ', 已達上限'}`)
  } else if (h.usageError) {
    lines.push(`Codex 方案: 讀取失敗 (${h.usageError})`)
  } else {
    lines.push('Codex 方案: 讀取中, 稍後再執行一次 /relay status')
  }
  return lines.join('\n')
}

export const HELP = [
  '/relay                      開啟面板',
  '/relay codex | claude       切換這個視窗 (只影響這個 session)',
  '/relay default [codex|claude]  查看或設定新 session 的預設路由',
  '/relay status               顯示路由, proxy 與 Codex 用量',
  '/relay usage                顯示 Codex 方案的用量上限',
  '/relay models [--full]      列出帳號可用的 Codex model 與 proxy 支援狀況',
  '/relay auth [status|login|device|logout]  Codex 登入 (login 開啟瀏覽器, device 用裝置碼登入)',
  '/relay monitor              說明如何開啟 proxy 的 monitor TUI',
  '/relay start | restart [--proxy]  啟動或重啟 relay (restart 加 --proxy 也停止 proxy)',
  '/relay stop-proxy           只停止 proxy, relay 繼續執行',
  '/relay help                 列出所有指令',
].join('\n')

export const COMMAND_WORDS = ['panel', 'codex', 'claude', 'default', 'status', 'usage', 'models', 'auth', 'monitor', 'start', 'restart', 'stop-proxy', 'help']

export function parseArgs(args: string): { cmd: string; rest: string[] } {
  const [cmd = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  return { cmd: cmd.toLowerCase(), rest }
}

// Detaches the relay so it outlives the command that starts it, on Windows and POSIX
export function startArgv(nodePath: string, script: string, configDir: string, isWin: boolean): string[] {
  if (isWin) {
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`
    return [
      'powershell.exe',
      '-NoProfile',
      '-Command',
      `Start-Process -WindowStyle Hidden -FilePath ${q(nodePath)} -ArgumentList @(${q(`"${script}"`)}, ${q(`"${configDir}"`)})`,
    ]
  }
  const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  return ['sh', '-c', `nohup ${sh(nodePath)} ${sh(script)} ${sh(configDir)} >/dev/null 2>&1 &`]
}

// Output of a CLI run, trimmed for a command answer
export function runText(r: { exitCode: number; stdout: string; stderr: string }): string {
  const out = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n')
  return out || (r.exitCode === 0 ? '完成' : `失敗 (exit ${r.exitCode})`)
}
