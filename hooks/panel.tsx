// The AbovePrompt panel of /relay. A pure view: elements, what to show and the actions come in as arguments.
import type { EngineInterface } from 'claude-code'
import type { Health, PanelUi, Route } from '../types'
import { statusText } from './logic'

type Elements = ReturnType<EngineInterface['ui']['resolve']>

export type PanelActions = {
  switchTo: (route: Route) => void
  askClaude: (ask: boolean) => void
  setDefault: (route: Route) => void
  refresh: () => void
  start: () => void
  close: () => void
}

const ACCENT = 'cyan'

const fit = (text: string, cells: number) => (text.length > cells ? `${text.slice(0, Math.max(1, cells - 1))}…` : text)

const routeName = (r: Route) => (r === 'codex' ? 'Codex' : 'Claude')

// `h` is the JSX factory here, so the relay's answer is `health`
export function panelTree(ui: Elements, health: Health | null, v: PanelUi, columns: number, act: PanelActions) {
  const { Box, Text, Button } = ui
  const inner = Math.max(32, columns - 4)

  const header = (
    <Box>
      <Box flexGrow={1}>
        <Text color={ACCENT} bold>codex-relay</Text>
        <Text dimColor> · 這個視窗走哪裡</Text>
      </Box>
      <Button key="refresh" label={v.busy ? '更新中…' : '重新整理 [r]'} hotkey="r" onPress={act.refresh} />
      <Button key="close" label="關閉" role="dismiss" dimColor onPress={act.close} />
    </Box>
  )

  const note = v.note ? <Text color={v.note.ok ? 'green' : 'yellow'}>{fit(v.note.text, inner)}</Text> : null
  const keys = <Text dimColor>{fit('鍵盤: 先按 ctrl+x tab, 再按按鈕上標的鍵', inner)}</Text>

  if (!health) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
        {header}
        <Text color="yellow">{fit('Relay 沒有回應: 這個視窗目前直連 Claude.', inner)}</Text>
        {note}
        <Box marginTop={1}>
          <Button key="start" label="啟動 relay [s]" hotkey="s" variant="primary" onPress={act.start} />
        </Box>
        {keys}
      </Box>
    )
  }

  const here = health.session.route
  const other: Route = health.defaultRoute === 'codex' ? 'claude' : 'codex'
  const routeButtons = v.confirmingClaude
    ? [
        <Text key="warn" color="yellow">切回 Claude 會重送整段對話並重建 prompt cache. </Text>,
        <Button key="confirm-claude" label="確定切回 Claude" variant="primary" onPress={() => act.switchTo('claude')} />,
        <Button key="cancel-claude" label="取消" onPress={() => act.askClaude(false)} />,
      ]
    : [
        <Button key="to-codex" label={here === 'codex' ? 'Codex (目前)' : 'Codex'} hotkey="1" variant={here === 'codex' ? 'primary' : undefined} onPress={() => act.switchTo('codex')} />,
        <Button
          key="to-claude"
          label={here === 'claude' ? 'Claude (目前)' : 'Claude'}
          hotkey="2"
          variant={here === 'claude' ? 'primary' : undefined}
          // Leaving Codex for Claude rebuilds a long chat's cache: it takes a second press
          onPress={() => (here === 'codex' ? act.askClaude(true) : act.switchTo('claude'))}
        />,
      ]

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
      {header}
      <Text>{fit(statusText(health), inner)}</Text>
      {health.proxy.error ? <Text color="yellow">{fit(`Proxy: ${health.proxy.error}`, inner)}</Text> : null}
      {note}
      <Box marginTop={1}>
        <Text>這個視窗: </Text>
        {routeButtons}
      </Box>
      <Box>
        <Text dimColor>{`新 session 預設: ${routeName(health.defaultRoute)} `}</Text>
        <Button key="default" label={`改為 ${routeName(other)} [d]`} hotkey="d" onPress={() => act.setDefault(other)} />
      </Box>
      {keys}
    </Box>
  )
}
