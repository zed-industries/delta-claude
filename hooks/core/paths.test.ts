import { expect, test } from 'claude-code/testing'
import { isWithin } from './paths'

test('a path is within a directory it equals or lies under, never one its name merely starts with', () => {
  expect(isWithin('/repo', '/repo')).toBe(true)
  expect(isWithin('/repo/.delta/worktrees/a/repo', '/repo')).toBe(true)
  expect(isWithin('/repo/.delta', '/repo/')).toBe(true)
  expect(isWithin('/repository', '/repo')).toBe(false)
  expect(isWithin('/repo', '/repo/sub')).toBe(false)
  // Windows paths compare by separators only.
  expect(isWithin('C:\\work\\repo\\.delta\\worktrees\\a', 'C:/work/repo')).toBe(true)
})
