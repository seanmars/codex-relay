export type Route = 'claude' | 'codex'

export type CodexStats = {
  model: string | null
  effort: string | null
  requests: number
  failures: number
  inputTokens: number
  outputTokens: number
  lastStatus: string | null
}

export type UsageWindow = { usedPercent: number; windowSeconds: number; resetAt: number }

export type Usage = { plan: string | null; allowed: boolean; primary: UsageWindow | null; secondary: UsageWindow | null }

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
  pinnedSessions: number
  session: { sid: string; route: Route; pinned: boolean; codex: CodexStats | null }
  proxy: { port: number; command: string; up: boolean; startedPid: number | null; error: string | null }
  usage: Usage | null
  usageError: string | null
  usageAt: number | null
}

export type PanelNote = { text: string; ok: boolean }

export type PanelUi = { open: boolean; confirmingClaude: boolean; busy: boolean; note?: PanelNote }

declare module 'claude-code' {
  interface PluginState {
    'codex-relay': { panelUi: PanelUi; health: Health | null }
  }
}
