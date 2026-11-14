import { expect, test } from 'claude-code/testing'
import { isWithin, samePath } from './paths'

test('a path is within a directory it equals or lies under, never one its name merely starts with', () => {
  expect(isWithin('/repo', '/repo')).toBe(true)
  expect(isWithin('/repo/.delta/worktrees/a/repo', '/repo')).toBe(true)
  expect(isWithin('/repo/.delta', '/repo/')).toBe(true)
  expect(isWithin('/repository', '/repo')).toBe(false)
  expect(isWithin('/repo', '/repo/sub')).toBe(false)
  // Windows paths compare by separators only.
  expect(isWithin('C:\\work\\repo\\.delta\\worktrees\\a', 'C:/work/repo')).toBe(true)
})

test("Windows paths compare without the \\\\?\\ prefix Delta's canonical paths carry and Claude drops", () => {
  expect(samePath(String.raw`\\?\C:\Users\a\thread-mounts\x`, String.raw`C:\Users\a\thread-mounts\x`)).toBe(true)
  expect(samePath(String.raw`\\?\UNC\server\share\x`, String.raw`\\server\share\x`)).toBe(true)
  expect(isWithin(String.raw`C:\Users\a\x\src`, String.raw`\\?\C:\Users\a\x`)).toBe(true)
  expect(samePath(String.raw`\\?\C:\a`, String.raw`C:\b`)).toBe(false)
})
