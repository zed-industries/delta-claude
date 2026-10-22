import { expect, test } from 'claude-code/testing'
import { cliFixture } from '../testing/cli-fixtures'
import { checkoutStillSyncing, reconnectDelay, validateAttachmentReceipt, validatePublicationReceipt } from './command-outcomes'

test('a checkout is still syncing only while the list shows it mounted or restoring at that directory', () => {
  const listed = (state: string, directory = '/repo/.claude/worktrees/agent') => ({
    operation: 'listed',
    worktrees: [{ reference: 'w#t=0', directories: [{ directory, state, error: null, owners: [] }] }],
  })
  expect(checkoutStillSyncing(listed('mounted'), '/repo/.claude/worktrees/agent')).toBe(true)
  expect(checkoutStillSyncing(listed('mounted', 'C:/repo/agent'), String.raw`C:\repo\agent`)).toBe(true)
  expect(checkoutStillSyncing(listed('restoring'), '/repo/.claude/worktrees/agent')).toBe(true)
  for (const state of ['inactive', 'waiting', 'failed'])
    expect(checkoutStillSyncing(listed(state), '/repo/.claude/worktrees/agent')).toBe(false)
  expect(checkoutStillSyncing(listed('mounted', '/repo'), '/repo/.claude/worktrees/agent')).toBe(false)
  expect(checkoutStillSyncing({ operation: 'listed', worktrees: [] }, '/repo')).toBe(false)
  expect(() => checkoutStillSyncing({ operation: 'created' }, '/repo')).toThrow()
})

test('attachment receipts require the intended directory, operation, and usable reference', () => {
  const directory = cliFixture('checkoutMount').directory
  validateAttachmentReceipt(cliFixture('checkoutMount'), directory)
  validateAttachmentReceipt(cliFixture('checkoutMount', { directory: 'C:/repo/delta' }), String.raw`C:\repo\delta`)
  for (const patch of [{ reference: ' ' }, { reference: undefined }, { directory: '/other' }, { directory: undefined }, { operation: 'invalid' }])
    expect(() => validateAttachmentReceipt(cliFixture('checkoutMount', patch), directory)).toThrow()
})

test('publication receipts identify the same thread and carry a safe web link', () => {
  const thread = cliFixture('share').thread_id
  validatePublicationReceipt(cliFixture('share'), thread)
  for (const patch of [{ thread_id: 'other-thread' }, { url: 'javascript:alert(1)' }, { operation: 'invalid' }])
    expect(() => validatePublicationReceipt(cliFixture('share', patch), thread)).toThrow()
})

test('reconnecting uses capped backoff', () => {
  expect([0, 1, 2, 3, 4, 5, 6].map(reconnectDelay)).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000])
})
