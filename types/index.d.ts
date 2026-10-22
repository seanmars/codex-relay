export type Route = 'claude' | 'codex'

export type CodexStats = {
  // Display text, `opus → gpt-6-sol` when an alias resolves to another model
  model: string | null
  // The model the session asked for and the model that answered; absent from a relay before these fields
  requestedModel?: string | null
  resolvedModel?: string | null
  effort: string | null
  requests: number
  failures: number
  inputTokens: number
  outputTokens: number
  lastStatus: string | null
}

// One subagent's latest Codex request, as the proxy answered it
export type AgentCodexStats = { requestedModel: string | null; resolvedModel: string | null; effort: string | null; requests: number }

export type UsageWindow = { usedPercent: number; windowSeconds: number; resetAt: number }

export type Usage = { plan: string | null; allowed: boolean; primary: UsageWindow | null; secondary: UsageWindow | null }

export type ProxyOverrides = { model: string | null; effort: string | null }

// The relay's GET /__health answer
export type Health = {
  ok: true
  pid: number
  version: string
  // The config dir the relay serves, as it resolves it and as it was given; absent on 0.1.0 (configDir only)
  configDir?: string
  configDirArg?: string
  port: number
  inflight: number
  defaultRoute: Route
  agentModel: string
  // null leaves it to Claude Code; absent from a relay before it
  agentEffort?: string | null
  pinnedSessions: number
  // `agents` is keyed by the subagent's id; absent from a relay before it
  session: { sid: string; route: Route; pinned: boolean; codex: CodexStats | null; agents?: Record<string, AgentCodexStats> }
  // `overrides`: what the proxy's config forces on every Codex request; null from a proxy that does not say, absent
  // from a relay before it
  proxy: { port: number; command: string; up: boolean; startedPid: number | null; error: string | null; overrides?: ProxyOverrides | null }
  usage: Usage | null
  usageError: string | null
  usageAt: number | null
}

export type PanelNote = { text: string; ok: boolean }

// What an Agent row shows of its subagent: Claude Code's model and effort, and Codex's once the proxy answered
export type Subagent = { agentId?: string; model?: string; effort?: string; codex?: AgentCodexStats }

// By the Agent tool call's tool_use_id, the row's requestId
export type Subagents = Record<string, Subagent>

export type PanelUi = { open: boolean; confirmingClaude: boolean; busy: boolean; note?: PanelNote }

declare module 'claude-code' {
  interface PluginState {
    'codex-relay': { panelUi: PanelUi; health: Health | null; subagents: Subagents }
  }
}
