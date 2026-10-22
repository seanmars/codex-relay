import { expect, test } from 'claude-code/testing'
import type { CodexStats } from '../types'
import { answeringModel, subagentLabel, withCodex, withSpawn, withStep } from './logic'
// The proxy and relay tests pin the other end of this file: the status line reads what they produce
import contract from '../proxy/tests/fixtures/model-contract.mjs'

const stats = (over: Partial<CodexStats>): CodexStats => ({
  model: null,
  effort: null,
  requests: 1,
  failures: 0,
  inputTokens: 0,
  outputTokens: 0,
  lastStatus: null,
  ...over,
})

test('the answering model comes from the structured fields of the shared contract', () => {
  expect(answeringModel(stats(contract.codex))).toBe(contract.answeringModel)
  // The display text does not count when the structured fields are there
  expect(answeringModel(stats({ ...contract.codex, model: 'display text in another format' }))).toBe(contract.answeringModel)
})

test('a request the proxy has not resolved yet shows the model it asked for', () => {
  expect(answeringModel(stats({ model: 'opus', requestedModel: 'opus', resolvedModel: null }))).toBe('opus')
})

test('an older relay or proxy without the structured fields falls back to the display text', () => {
  expect(answeringModel(stats({ model: 'opus → gpt-6-sol' }))).toBe('gpt-6-sol')
  expect(answeringModel(stats({ model: 'gpt-6-sol', requestedModel: null, resolvedModel: null }))).toBe('gpt-6-sol')
  expect(answeringModel(stats({}))).toBe('')
  expect(answeringModel(null)).toBe('')
})

test('an Agent row shows what Claude Code asked for until Codex answers, then what Codex answered with', () => {
  let all = withSpawn({}, 'tu1', 'a1', 'gpt-5.6-terra')
  expect(subagentLabel(all.tu1)).toBe('gpt-5.6-terra')
  all = withStep(all, 'a1', 'gpt-5.6-terra', 'medium')
  expect(subagentLabel(all.tu1)).toBe('gpt-5.6-terra · medium')
  all = withCodex(all, { a1: contract.agents.stats['agent-contract'] })
  expect(subagentLabel(all.tu1)).toBe('Codex gpt-5.6-terra · high')
  expect(subagentLabel(withCodex(all, { a1: { requestedModel: 'sonnet', resolvedModel: null, effort: null, requests: 1 } }).tu1)).toBe('Codex sonnet')
  expect(subagentLabel(undefined)).toBe('')
})

test('an unchanged step, a step or report of an unknown agent, and an absent report change nothing', () => {
  const all = withStep(withSpawn({}, 'tu1', 'a1', 'claude-haiku-4-5'), 'a1', 'claude-haiku-4-5', 'low')
  expect(withStep(all, 'a1', 'claude-haiku-4-5', 'low')).toBe(all)
  expect(withStep(all, 'a2', 'claude-haiku-4-5', 'high')).toBe(all)
  expect(withCodex(all, { a2: { requestedModel: 'opus', resolvedModel: 'gpt-6-sol', effort: 'high', requests: 1 } })).toBe(all)
  expect(withCodex(all, undefined)).toBe(all)
  // A spawn without an agent id keeps its model, and no step can find it
  const lone = withSpawn({}, 'tu2', undefined, 'claude-haiku-4-5')
  expect(withStep(lone, 'a1', 'x', 'high')).toBe(lone)
  expect(subagentLabel(lone.tu2)).toBe('claude-haiku-4-5')
})
