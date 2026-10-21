import { expect, test } from 'claude-code/testing'
import type { CodexStats } from '../types'
import { answeringModel } from './logic'
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
