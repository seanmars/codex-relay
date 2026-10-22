import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Health } from '../types'

const RELAY = 'http://127.0.0.1:8960'

const health = (over: Partial<Health> = {}): Health => ({
  ok: true,
  pid: 42,
  version: '0.1.0',
  port: 8960,
  inflight: 0,
  defaultRoute: 'claude',
  agentModel: 'gpt-5.6-terra',
  pinnedSessions: 1,
  session: {
    sid: 's1',
    route: 'codex',
    pinned: true,
    codex: { model: 'gpt-5.6-terra', effort: null, requests: 3, failures: 0, inputTokens: 12345, outputTokens: 678, lastStatus: 'ok' },
  },
  proxy: { port: 8970, command: 'claude-code-proxy', up: true, startedPid: null, error: null },
  usage: { plan: 'pro', allowed: true, primary: { usedPercent: 23, windowSeconds: 18000, resetAt: 0 }, secondary: { usedPercent: 41, windowSeconds: 604800, resetAt: 0 } },
  usageError: null,
  usageAt: 1,
  ...over,
})

const props = { hasSurvey: false, isWorking: false, maxRows: 40, bodyColumns: 100, scroll: { offset: 0, bodyRows: 39 }, view: {} }
const relayCmd = (args: string) => ({ command: 'relay', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

// The engine and the relay beneath the plugin, recording what the plugin asked of them
function world(on: On, opts: { up: boolean; baseUrl?: string; answer?: () => Health; contextPercent?: number; pluginVersion?: string }) {
  const env: Record<string, string | undefined> = { OS: 'Windows_NT', USERPROFILE: 'C:/Users/u', ANTHROPIC_BASE_URL: opts.baseUrl }
  const seen = { statuses: [] as (string | undefined)[], toasts: [] as string[], posts: [] as unknown[], agents: [] as unknown[], runs: [] as string[][] }
  const clock = mock.clock(on)
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('env.set', (_$, e) => {
    env[e.name] = e.value
    return { value: {} }
  })
  on('session.id', () => ({ value: 's1' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: opts.contextPercent }, rateLimits: [] } }))
  on('fs.read', (_$, e) => ({ value: e.path.endsWith('plugin.json') ? JSON.stringify({ version: opts.pluginVersion ?? '0.1.0' }) : '{}' }))
  on('ui.status', (_$, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'relay' } }))
  on('agent.register', (_$, e) => {
    seen.agents.push(e)
    return { value: { agent: 'codex-relay:codex' } }
  })
  on('process.run', (_$, e) => {
    seen.runs.push([...e.argv])
    return { value: { exitCode: opts.up ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', (_$, e) => {
    if (!opts.up) throw new Error('connection refused')
    if (e.url.includes('/__session')) {
      seen.posts.push(JSON.parse(String(e.init?.body)))
      return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify((opts.answer ?? health)()) } }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  return { env, seen, clock }
}

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

// A label without its colours
const plain = (s: string) => s.replace(/\x1b\[\d+m/g, '')

test('with the relay up, the session goes through it and the status line shows the Codex session', async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const { env, seen } = world(on, { up: true, baseUrl: 'http://127.0.0.1:8950', contextPercent: 42 })
  await $.session.start(START)

  expect(env.ANTHROPIC_BASE_URL).toBe(RELAY)
  expect(seen.toasts.some((t) => t.includes('http://127.0.0.1:8950') && t.includes('settings.json'))).toBe(true)
  expect(seen.statuses.at(-1)).toBe('⇄ Codex gpt-5.6-terra · ctx 42% · 5h 23% · 週 41%')
  expect(seen.agents).toEqual([expect.objectContaining({ name: 'codex', model: 'gpt-5.6-terra' })])
})

test('a plan with only a weekly window, in the primary slot, is labelled by its length', async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  // As a prolite account answered: one window of 7 days, and the monitor's `alias → model`
  const answer = () =>
    health({
      session: {
        sid: 's1',
        route: 'codex',
        pinned: true,
        codex: { model: 'opus → gpt-6-sol', effort: 'high', requests: 1, failures: 0, inputTokens: 18710, outputTokens: 5, lastStatus: 'completed' },
      },
      usage: { plan: 'prolite', allowed: true, primary: { usedPercent: 14, windowSeconds: 604800, resetAt: 0 }, secondary: null },
    })
  const { seen } = world(on, { up: true, answer })
  await $.session.start(START)
  // No context reading yet: the line leaves it out
  expect(seen.statuses.at(-1)).toBe('⇄ Codex gpt-6-sol · high · 週 14%')
})

test('on Claude the status line adds the model and effort Codex last answered its agents with, once there are any', async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  let codex: Health['session']['codex'] = null
  const answer = () => health({ session: { sid: 's1', route: 'claude', pinned: true, codex } })
  const { seen, clock } = world(on, { up: true, answer })
  await $.session.start(START)
  expect(seen.statuses.at(-1)).toBe('⇄ Claude')

  codex = { model: 'gpt-5.6-terra', requestedModel: 'gpt-5.6-terra', resolvedModel: 'gpt-5.6-terra', effort: 'xhigh', requests: 4, failures: 0, inputTokens: 1, outputTokens: 1, lastStatus: 'completed' }
  await clock.advance(10000)
  expect(seen.statuses.at(-1)).toBe('⇄ Claude · Codex agent gpt-5.6-terra · xhigh')
})

test('with the relay down and not starting, the session keeps its address and says so', async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const { env, seen } = world(on, { up: false })
  await $.session.start(START)

  expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
  expect(seen.statuses.at(-1)).toBe('⇄ codex-relay 離線: 直連 Claude')
  expect(seen.toasts.some((t) => t.includes('無法啟動'))).toBe(true)
  // It tried: the detached start, then the wait for the relay
  expect(seen.runs[0]?.[0]).toBe('powershell.exe')
  expect(seen.runs[1]?.slice(-2)).toEqual(['wait', '10'])
})

const restartArgs = ['restart', '--if-stale', '--if-idle']
const restarted = (runs: string[][]) => runs.some((argv) => argv.slice(-3).join(' ') === restartArgs.join(' '))

test('a relay older than the plugin is restarted while it answers nothing', async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const { seen } = world(on, { up: true, pluginVersion: '0.2.0' })
  await $.session.start(START)
  expect(restarted(seen.runs)).toBe(true)
  expect(seen.toasts.some((t) => t.includes('已重啟') && t.includes('0.2.0'))).toBe(true)
})

test('a busy, current or newer relay is not restarted; an older one is once it is idle', async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  let answer = health({ inflight: 1 })
  const { seen, clock } = world(on, { up: true, pluginVersion: '0.2.0', answer: () => answer })
  await $.session.start(START)
  answer = health({ version: '0.2.0' })
  await clock.advance(10000)
  answer = health({ version: '0.3.0' })
  await clock.advance(10000)
  expect(restarted(seen.runs)).toBe(false)
  answer = health()
  await clock.advance(10000)
  expect(restarted(seen.runs)).toBe(true)
})

test("another config dir's relay on our port is not used, not restarted and not replaced", async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const { env, seen } = world(on, { up: true, pluginVersion: '0.2.0', answer: () => health({ configDir: 'D:\\other\\.claude', configDirArg: 'D:/other/.claude' }) })
  await $.session.start(START)

  expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
  expect(seen.statuses.at(-1)).toBe('⇄ port 屬於 D:\\other\\.claude 的 relay: 直連 Claude')
  expect(seen.toasts.filter((t) => t.includes('D:\\other\\.claude'))).toHaveLength(1)
  expect(seen.runs).toEqual([])
  expect((await $.command.run(relayCmd('codex'))).text).toContain('另一個 config dir')
  expect((await $.command.run(relayCmd('status'))).text).toContain('另一個 config dir')
  expect(seen.posts).toEqual([])
})

test('our own config dir in another spelling is ours', async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const { env } = world(on, { up: true, answer: () => health({ configDir: 'c:\\users\\u\\.claude\\', configDirArg: 'C:/Users/u/.claude' }) })
  await $.session.start(START)
  expect(env.ANTHROPIC_BASE_URL).toBe(RELAY)
})

test('/relay codex and /relay claude pin this session; /relay status reports it', async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const { seen } = world(on, { up: true })
  await $.session.start(START)

  expect((await $.command.run(relayCmd('claude'))).text).toContain('Claude')
  expect((await $.command.run(relayCmd('codex'))).text).toContain('Codex')
  expect(seen.posts).toEqual([{ sid: 's1', route: 'claude' }, { sid: 's1', route: 'codex' }])

  const report = (await $.command.run(relayCmd('status'))).text ?? ''
  expect(report).toContain('這個視窗: Codex (已固定)')
  expect(report).toContain('新 session 預設: Claude')
  expect(report).toContain('5h 23%')
  expect(report).toContain('週 41%')
  expect((await $.command.run(relayCmd('bogus'))).text).toContain('/relay status')
})

test('/relay stop-proxy runs the CLI that stops the proxy alone', async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const { seen } = world(on, { up: true })
  await $.session.start(START)
  await $.command.run(relayCmd('stop-proxy'))
  expect(seen.runs.at(-1)?.slice(-1)).toEqual(['stop-proxy'])
  expect((await $.command.run(relayCmd('help'))).text).toContain('/relay stop-proxy')
})

test('/relay stop is not a command: it runs no CLI', async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const { seen } = world(on, { up: true })
  await $.session.start(START)
  const runs = seen.runs.length
  expect((await $.command.run(relayCmd('stop'))).text).toContain('不認得 "stop"')
  expect(seen.runs.length).toBe(runs)
})

test('the panel switches this window, and leaving Codex for Claude takes a second press', async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const { seen } = world(on, { up: true })
  await $.session.start(START)
  await $.command.run(relayCmd(''))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'codex-relay', surface, component: 'AbovePrompt', props })
    expect(await ui.find({ key: 'to-codex' })).toBeDefined()
    await ui.press({ key: 'to-claude' })
    expect(await ui.find({ key: 'confirm-claude' })).toBeDefined()
    await ui.press({ key: 'cancel-claude' })
    expect(await ui.find({ key: 'confirm-claude' })).toBeUndefined()
    await ui.unmount()
  }
  expect(seen.posts).toEqual([])

  const ui = await $.ui.mount({ plugin: 'codex-relay', surface: 'terminal', component: 'AbovePrompt', props })
  await ui.press({ key: 'to-claude' })
  await ui.press({ key: 'confirm-claude' })
  expect(seen.posts).toEqual([{ sid: 's1', route: 'claude' }])
  // A switch that took closes the panel: the engine draws its own again
  expect(await ui.find({ key: 'to-codex' })).toBeUndefined()
  await ui.unmount()
})

test('the panel offers to start a relay that does not answer', async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  world(on, { up: false })
  await $.session.start(START)
  await $.command.run(relayCmd(''))
  const ui = await $.ui.mount({ plugin: 'codex-relay', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await ui.find({ key: 'start' })).toBeDefined()
  expect(await ui.find({ key: 'to-codex' })).toBeUndefined()
  await ui.unmount()
})

test('an Agent row shows its model, then the model and effort Codex answered with', async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  let answer = health()
  const { clock } = world(on, { up: true, answer: () => answer })
  const spawned: string[] = []
  const tasks: string[] = []
  on('agent.spawn', (_$, e) => {
    spawned.push(e.tool_use_id)
    tasks.push(plain(e.description))
    return { model: e.model ?? 'claude-haiku-4-5', agentId: 'agent-1' }
  })
  const drawn: unknown[] = []
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const description = (e.props.input as { description?: unknown }).description
    drawn.push(typeof description === 'string' ? plain(description) : description)
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  await $.session.start(START)
  await $.agent.spawn({
    tool_use_id: 'tu-1',
    prompt: 'look',
    description: 'Find the bug',
    subagentType: 'codex-relay:codex',
    provider: { plugin: 'codex-relay', tier: 'user' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })

  // The task under the prompt gains the model; the row's input, as the model sent it, gains it once at drawing
  expect(tasks).toEqual(['Find the bug · gpt-5.6-terra'])
  const id = spawned[0]!
  const row = { tool_use_id: id, tool: 'Agent', input: { description: 'Find the bug', prompt: 'look' }, isRunning: true, isErrored: false, isInterrupted: false }
  const ui = await $.ui.mount({ plugin: 'codex-relay', surface: 'terminal', component: 'ToolUse', props: row, requestId: id })
  expect(drawn.at(-1)).toBe('Find the bug · gpt-5.6-terra')

  const agents = { 'agent-1': { requestedModel: 'gpt-5.6-terra', resolvedModel: 'gpt-5.6-sol', effort: 'high', requests: 2 } }
  answer = health({ session: { ...health().session, agents } })
  await clock.advance(10000)
  expect(drawn.at(-1)).toBe('Find the bug · Codex gpt-5.6-sol · high')
  await ui.unmount()

  // Another tool's row, and an Agent row this session never spawned, are drawn as they came
  for (const props of [{ ...row, tool: 'Bash', input: { command: 'ls' } }, { ...row, tool_use_id: 'other' }]) {
    const other = await $.ui.mount({ plugin: 'codex-relay', surface: 'terminal', component: 'ToolUse', props, requestId: props.tool_use_id })
    expect(drawn.at(-1)).toBe(props.tool === 'Bash' ? undefined : 'Find the bug')
    await other.unmount()
  }
})

const spawnArgs = (subagentType: string) => ({
  tool_use_id: 'tu-1',
  prompt: 'look',
  description: 'Find the bug',
  subagentType,
  provider: { plugin: 'codex-relay', tier: 'user' as const },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
})

test("a configured effort goes into the agent type and a Codex agent's task; other agents' tasks stay as they came", async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const { seen } = world(on, { up: true, answer: () => health({ agentEffort: 'xhigh' }) })
  const tasks: string[] = []
  on('agent.spawn', (_$, e) => {
    tasks.push(e.description)
    return { model: e.model ?? 'claude-haiku-4-5', agentId: 'agent-1' }
  })
  await $.session.start(START)
  expect(seen.agents).toEqual([expect.objectContaining({ name: 'codex', model: 'gpt-5.6-terra', effort: 'xhigh' })])

  await $.agent.spawn(spawnArgs('codex-relay:codex'))
  await $.agent.spawn(spawnArgs('general-purpose'))
  expect(tasks[0]).toBe('Find the bug · \x1b[36mgpt-5.6-terra\x1b[39m · \x1b[35mxhigh\x1b[39m')
  expect(tasks[1]).toBe('Find the bug')
})

test("without agentEffort a Codex agent takes the main conversation's effort, shows it, and sends it on every request", async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  world(on, { up: true })
  const tasks: string[] = []
  const models: (string | undefined)[] = []
  let nextId = 0
  on('agent.spawn', (_$, e) => {
    tasks.push(plain(e.description))
    models.push(e.model)
    return { model: e.model ?? 'claude-haiku-4-5', agentId: `agent-${++nextId}` }
  })
  const sent: { agentId?: string; effort?: unknown }[] = []
  on('turn.step', async function* (_$, e) {
    sent.push({ agentId: e.agentId, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  const step = async (effort: 'high' | 'xhigh', agentId?: string) => {
    const s = $.turn.step({ turnId: 't', index: 0, model: 'm', effort, messageCount: 1, ...(agentId ? { agentId } : {}) })
    for await (const _ of s);
    return s.result
  }
  await $.session.start(START)

  await step('high')
  // The call's Codex model is kept; a Claude model is replaced by agentModel
  await $.agent.spawn({ ...spawnArgs('codex-relay:codex'), model: 'gpt-6-sol' })
  await $.agent.spawn({ ...spawnArgs('codex-relay:codex'), model: 'sonnet' })
  expect(models).toEqual(['gpt-6-sol', 'gpt-5.6-terra'])
  expect(tasks).toEqual(['Find the bug · gpt-6-sol · high', 'Find the bug · gpt-5.6-terra · high'])

  await step('xhigh', 'agent-1')
  await step('xhigh')
  expect(sent).toEqual([{ effort: 'high' }, { agentId: 'agent-1', effort: 'high' }, { effort: 'xhigh' }])
})

test("a Codex agent's task shows the model and effort the proxy's config forces", async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const overrides = { model: 'gpt-6-sol', effort: 'max' }
  world(on, { up: true, answer: () => health({ agentEffort: 'low', proxy: { ...health().proxy, overrides } }) })
  const tasks: string[] = []
  on('agent.spawn', (_$, e) => {
    tasks.push(plain(e.description))
    return { model: e.model ?? 'claude-haiku-4-5', agentId: 'agent-1' }
  })
  await $.session.start(START)
  await $.agent.spawn(spawnArgs('codex-relay:codex'))
  expect(tasks).toEqual(['Find the bug · gpt-6-sol · max'])
})

test('/relay effort sets the level through the CLI and reports the current one', async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  let answer = health()
  const { seen } = world(on, { up: true, answer: () => answer })
  await $.session.start(START)

  expect((await $.command.run(relayCmd('effort'))).text).toContain('auto (與主對話相同)')
  answer = health({ agentEffort: 'high' })
  await $.command.run(relayCmd('effort High'))
  expect(seen.runs.some((argv) => argv.slice(-2).join(' ') === 'effort high')).toBe(true)
  // The tick after the command registers the agent type with the new level
  expect(seen.agents.at(-1)).toEqual(expect.objectContaining({ effort: 'high' }))
  expect((await $.command.run(relayCmd('effort'))).text).toBe('codex-relay:codex agent 的 effort: high')
  expect((await $.command.run(relayCmd('help'))).text).toContain('/relay effort')
})
