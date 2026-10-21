// codex-relay hooks: keep the local relay running, point this session at it, and give /relay, its panel,
// the status line and the codex-relay:codex agent type.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Health, PanelUi, Route } from '../types'
import {
  AGENT_TYPE,
  COMMAND_WORDS,
  HELP,
  type LocalCfg,
  agentSpec,
  foreignConfigDir,
  foreignReport,
  foreignStatusText,
  isRoute,
  parseArgs,
  parseHealth,
  parseLocalCfg,
  relayIsStale,
  relayUrl,
  runText,
  startArgv,
  statusReport,
  statusText,
} from './logic'
import { panelTree, type PanelActions } from './panel'

const panelUi = atom({ plugin: 'codex-relay', key: 'panelUi' } as const, { open: false, confirmingClaude: false, busy: false } satisfies PanelUi)
const health = atom({ plugin: 'codex-relay', key: 'health' } as const, null)

let ticking = false
let lastStart = 0
let startFailedTold = false
let lastStatus = ''
let lastHealthSig = ''
let agentModel = ''
// ANTHROPIC_BASE_URL as it was before this plugin set it, put back when the relay is gone
let savedBaseUrl: { value: string | undefined } | null = null
let pluginVersion: string | null = null
let lastStaleTry = 0
// The config dir of another profile's relay that holds our port, and the last one a toast named
let foreignDir: string | null = null
let foreignTold: string | null = null

async function myVersion($: EngineInterface): Promise<string> {
  if (pluginVersion === null) {
    try {
      pluginVersion = String(JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)).version ?? '')
    } catch {
      pluginVersion = ''
    }
  }
  return pluginVersion
}

async function configDir($: EngineInterface): Promise<string> {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (dir) return dir
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
  return `${home}/.claude`
}

async function isWindows($: EngineInterface): Promise<boolean> {
  return /windows/i.test((await $.env.get('OS')) ?? '')
}

async function readCfg($: EngineInterface): Promise<LocalCfg> {
  const raw = await $.fs.read(`${await configDir($)}/codex-relay.json`).catch(() => undefined)
  return parseLocalCfg(typeof raw === 'string' ? raw : undefined)
}

const cliScript = ($: EngineInterface) => `${$.plugin.root}/relay/cli.mjs`

async function runCli($: EngineInterface, cfg: LocalCfg, args: string[], timeoutMs = 30000) {
  return $.process.run([cfg.nodePath, cliScript($), ...args], { timeoutMs })
}

// The relay's answer, or null when none answers. Another config dir's relay on our port counts as none: this session
// never routes through it, and foreignDir names it.
async function fetchHealth($: EngineInterface, cfg: LocalCfg, sid: string, usage = false): Promise<Health | null> {
  let h: Health | null = null
  try {
    const r = await $.http.fetch(`${relayUrl(cfg)}/__health?sid=${encodeURIComponent(sid)}${usage ? '&usage=1' : ''}`)
    h = r.ok ? parseHealth(r.text) : null
  } catch {}
  foreignDir = foreignConfigDir(h, await configDir($), await isWindows($))
  return foreignDir ? null : h
}

// `plugin update` leaves the old relay running, and tick starts one only when none answers: replace it here, but only
// while it answers nothing, so no session loses a reply. A busy relay is tried again a minute later.
async function replaceStale($: EngineInterface, cfg: LocalCfg, h: Health): Promise<boolean> {
  if (h.inflight > 0 || Date.now() - lastStaleTry < 60000 || !relayIsStale(h, await myVersion($))) return false
  lastStaleTry = Date.now()
  lastStart = Date.now()
  const r = await runCli($, cfg, ['restart', '--if-stale', '--if-idle']).catch(() => null)
  if (r?.exitCode !== 0) return false
  $.ui.toast(`codex-relay: relay 已重啟, 改跑這個 plugin 的版本 (${await myVersion($)}).`)
  return true
}

// Starts the relay detached from this session, then waits for it outside the hook's own time
async function startRelay($: EngineInterface, cfg: LocalCfg, sid: string): Promise<Health | null> {
  lastStart = Date.now()
  const argv = startArgv(cfg.nodePath, `${$.plugin.root}/relay/relay.mjs`, await configDir($), await isWindows($))
  await $.process.run(argv, { timeoutMs: 15000 }).catch(() => undefined)
  await runCli($, cfg, ['wait', '10'], 15000).catch(() => undefined)
  return fetchHealth($, cfg, sid)
}

// This session's model calls go through the relay while it answers, and straight to the old address when it does not
async function pointSession($: EngineInterface, cfg: LocalCfg, up: boolean): Promise<void> {
  const url = relayUrl(cfg)
  const current = await $.env.get('ANTHROPIC_BASE_URL')
  if (up && current !== url) {
    if (!savedBaseUrl) {
      savedBaseUrl = { value: current }
      if (current) $.ui.toast(`codex-relay: ANTHROPIC_BASE_URL 原本是 ${current}, 這個 session 改走 ${url}. Claude 路由會直連 Anthropic.`)
    }
    await $.env.set('ANTHROPIC_BASE_URL', url)
  } else if (!up && current === url) {
    await $.env.set('ANTHROPIC_BASE_URL', savedBaseUrl?.value)
  }
}

// The agent type follows the relay's agentModel; registering again replaces it
async function syncAgent($: EngineInterface, model: string): Promise<void> {
  if (model === agentModel) return
  const done = await $.agent.register(agentSpec(model)).then(() => true, () => false)
  if (done) agentModel = model
}

// The context fill as the engine counts it; read only on Codex, where the line shows it
async function contextPercent($: EngineInterface, h: Health | null): Promise<number | undefined> {
  if (h?.session.route !== 'codex') return undefined
  return (await $.session.usage().catch(() => undefined))?.context.percent
}

async function publish($: EngineInterface, h: Health | null): Promise<void> {
  const text = foreignDir ? foreignStatusText(foreignDir) : statusText(h, await contextPercent($, h))
  if (text !== lastStatus) {
    lastStatus = text
    $.ui.status(text)
  }
  // Only a changed answer is written: every write redraws an open panel
  const sig = JSON.stringify(h)
  if (sig !== lastHealthSig) {
    lastHealthSig = sig
    await update($, health, () => h)
  }
}

async function tick($: EngineInterface): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const cfg = await readCfg($)
    const sid = await $.session.id()
    let h = await fetchHealth($, cfg, sid)
    if (h && (await replaceStale($, cfg, h))) h = await fetchHealth($, cfg, sid)
    if (foreignDir && foreignDir !== foreignTold) {
      foreignTold = foreignDir
      $.ui.toast(foreignReport(cfg, foreignDir))
    }
    // A port another config dir's relay holds is not ours to start a relay on
    if (!h && !foreignDir && Date.now() - lastStart > 15000) {
      h = await startRelay($, cfg, sid)
      if (!h && !startFailedTold) {
        startFailedTold = true
        $.ui.toast(`codex-relay: relay 無法啟動, 這個 session 直連 Claude. 查看 ${await configDir($)}/codex-relay.log`)
      }
    }
    if (h) startFailedTold = false
    await pointSession($, cfg, Boolean(h))
    await publish($, h)
    if (h) await syncAgent($, h.agentModel)
  } finally {
    ticking = false
  }
}

async function refresh($: EngineInterface, usage = false): Promise<Health | null> {
  const cfg = await readCfg($)
  const h = await fetchHealth($, cfg, await $.session.id(), usage)
  await publish($, h)
  return h
}

async function switchRoute($: EngineInterface, route: Route): Promise<{ ok: boolean; text: string }> {
  const cfg = await readCfg($)
  const sid = await $.session.id()
  await fetchHealth($, cfg, sid)
  if (foreignDir) return { ok: false, text: foreignReport(cfg, foreignDir) }
  try {
    const r = await $.http.fetch(`${relayUrl(cfg)}/__session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sid, route }),
    })
    if (!r.ok) return { ok: false, text: `切換失敗: ${r.text.slice(0, 200)}` }
  } catch {
    return { ok: false, text: 'Relay 沒有回應, 無法切換. 先執行 /relay start.' }
  }
  await pointSession($, cfg, true)
  await refresh($, route === 'codex')
  return {
    ok: true,
    text: route === 'codex' ? '這個視窗改走 Codex.' : '這個視窗改走 Claude. 下一輪會重送整段對話並重建 prompt cache.',
  }
}

async function setDefault($: EngineInterface, route: Route): Promise<string> {
  const r = await runCli($, await readCfg($), ['default', route]).catch((e: Error) => ({ exitCode: 1, stdout: '', stderr: e.message }))
  await refresh($)
  return runText(r)
}

// Login and logout run Codex CLI, which can wait on a browser: its output reaches the transcript as it comes
async function streamProxyCli($: EngineInterface, cfg: LocalCfg, args: string[]): Promise<string> {
  try {
    const run = $.process.spawn({ argv: [cfg.proxyCommand, ...args] })
    let last = ''
    while (true) {
      const step = await run.next()
      if (step.done) return step.value.code === 0 ? `完成: ${cfg.proxyCommand} ${args.join(' ')}` : `失敗 (exit ${step.value.code}): ${last}`
      const text = step.value.text.trim()
      if (text) {
        last = text.split('\n').at(-1) ?? text
        $.ui.log(text)
      }
    }
  } catch (e) {
    return `無法執行 ${cfg.proxyCommand}: ${(e as Error).message}. 先用 cargo install --path proxy 安裝.`
  }
}

async function runProxyCli($: EngineInterface, cfg: LocalCfg, args: string[]): Promise<string> {
  const r = await $.process.run([cfg.proxyCommand, ...args], { timeoutMs: 60000 }).catch((e: Error) => ({
    exitCode: 1,
    stdout: '',
    stderr: `無法執行 ${cfg.proxyCommand}: ${e.message}. 先用 cargo install --path proxy 安裝.`,
  }))
  return runText(r)
}

function panelActions($: EngineInterface): PanelActions {
  const note = (text: string, ok: boolean) => update($, panelUi, (u) => ({ ...u, busy: false, note: { text, ok } }))
  return {
    switchTo: async (route) => {
      await update($, panelUi, (u) => ({ ...u, busy: true, confirmingClaude: false }))
      const r = await switchRoute($, route)
      if (r.ok) {
        $.ui.toast(r.text)
        await update($, panelUi, () => ({ open: false, confirmingClaude: false, busy: false }))
      } else {
        await note(r.text, false)
      }
    },
    askClaude: (ask) => void update($, panelUi, (u) => ({ ...u, confirmingClaude: ask })),
    setDefault: async (route) => {
      await update($, panelUi, (u) => ({ ...u, busy: true }))
      await note(await setDefault($, route), true)
    },
    refresh: async () => {
      await update($, panelUi, (u) => ({ ...u, busy: true }))
      const h = await refresh($, true)
      await note(h ? '已更新' : 'Relay 沒有回應', Boolean(h))
    },
    start: async () => {
      await update($, panelUi, (u) => ({ ...u, busy: true }))
      lastStart = 0
      await tick($)
      const h = await refresh($)
      await note(h ? 'Relay 已啟動' : foreignDir ? foreignReport(await readCfg($), foreignDir) : 'Relay 無法啟動, 查看 codex-relay.log', Boolean(h))
    },
    close: () => void update($, panelUi, () => ({ open: false, confirmingClaude: false, busy: false })),
  }
}

async function runCommand($: EngineInterface, args: string): Promise<string> {
  const { cmd, rest } = parseArgs(args)
  const cfg = await readCfg($)
  switch (cmd) {
    case '':
    case 'panel':
      await refresh($, true)
      await update($, panelUi, () => ({ open: true, confirmingClaude: false, busy: false }))
      return '已開啟 codex-relay 面板.'
    case 'codex':
    case 'claude':
      return (await switchRoute($, cmd)).text
    case 'default': {
      const route = rest[0]
      if (!route) {
        const h = await refresh($)
        return `新 session 預設: ${h?.defaultRoute ?? (await runCli($, cfg, ['default'])).stdout.trim()}`
      }
      return isRoute(route) ? setDefault($, route) : `預設只能是 codex 或 claude, 收到 "${route}".`
    }
    case 'status': {
      const h = await refresh($, true)
      return foreignDir ? foreignReport(cfg, foreignDir) : statusReport(h, cfg, Math.floor(Date.now() / 1000))
    }
    case 'usage':
      return runProxyCli($, cfg, ['codex', 'usage'])
    case 'models':
      return runProxyCli($, cfg, ['models', ...rest.filter((arg) => arg === '--full')])
    case 'auth': {
      const sub = (rest[0] ?? 'status').toLowerCase()
      if (sub === 'status') return runProxyCli($, cfg, ['codex', 'auth', 'status'])
      if (sub === 'login' || sub === 'device' || sub === 'logout') return streamProxyCli($, cfg, ['codex', 'auth', sub])
      return '用法: /relay auth [status|login|device|logout]'
    }
    case 'monitor':
      return [
        'Monitor 是全螢幕 TUI, 請在另一個終端機執行:',
        `  ${cfg.proxyCommand} monitor --url http://127.0.0.1:${cfg.proxyPort}`,
        '這個視窗的摘要用 /relay status 查看.',
      ].join('\n')
    case 'start':
    case 'stop':
    case 'restart': {
      const r = await runCli($, cfg, [cmd, ...rest.filter((a) => a === '--proxy')]).catch((e: Error) => ({ exitCode: 1, stdout: '', stderr: e.message }))
      if (cmd !== 'stop') lastStart = Date.now()
      await tick($)
      return runText(r)
    }
    case 'help':
      return HELP
    default:
      return `不認得 "${cmd}".\n${HELP}`
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'relay',
      description: 'codex-relay: 切換這個視窗走 Codex 或 Claude (不帶參數開面板, /relay help 看全部指令)',
      argumentHint: `[${COMMAND_WORDS.join('|')}]`,
    })
    await tick($).catch(() => {})
    $.clock.every(10000, () => {
      void tick($).catch(() => {})
    })
    return next(e)
  })

  // An explicit `model` on the Agent call would replace the agent type's own: Codex agents keep the Codex model
  on('agent.spawn', ($, e, next) => {
    if (e.fork || e.resume || e.subagentType !== AGENT_TYPE || !agentModel) return next(e)
    return next({ ...e, model: agentModel })
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'codex-relay agent.spawn failed' }))

  on('command.run', { command: 'relay' }, async ($, e) => ({ text: await runCommand($, e.args) })).catch(() => ({
    text: '/relay 執行失敗',
  }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const ui = await read($, panelUi)
    if (!ui.open || e.props.hasSurvey) return next(e)
    const h = await read($, health)
    return panelTree($.ui.resolve(e), h, ui, e.props.bodyColumns, panelActions($))
  })
}
