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

test('with the relay up, the session goes through it and the status line shows the Codex session', async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const { env, seen } = world(on, { up: true, baseUrl: 'http://127.0.0.1:8950', contextPercent: 42 })
  await $.session.start(START)

  expect(env.ANTHROPIC_BASE_URL).toBe(RELAY)
  expect(seen.toasts.some((t) => t.includes('http://127.0.0.1:8950'))).toBe(true)
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
  expect(seen.statuses.at(-1)).toBe('⇄ Codex gpt-6-sol · 週 14%')
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
