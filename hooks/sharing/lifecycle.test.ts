import { expect, test } from 'claude-code/testing'
import {
  activeBackgroundAgents, hasInteractiveSurface, joinPreflight, missingJoinCommands, promptGate,
  releasesMounts, sessionDirectories, worktreeChanges,
} from './lifecycle'
import { cliFixture } from '../testing/cli-fixtures'
import type { MountedThread, ThreadMount, ThreadState } from '../cli/thread-commands'

test('only exit reasons release session mounts', () => {
  for (const reason of ['prompt_input_exit', 'logout', 'other']) expect(releasesMounts(reason)).toBe(true)
  for (const reason of ['clear', 'resume']) expect(releasesMounts(reason)).toBe(false)
})

test('terminal and desktop are interactive, while headless hosts are not', () => {
  expect(hasInteractiveSurface(['terminal'])).toBe(true)
  expect(hasInteractiveSurface(['desktop'])).toBe(true)
  expect(hasInteractiveSurface([])).toBe(false)
  expect(hasInteractiveSurface(['sdk', 'print'])).toBe(false)
})

test('join checks every required built-in, not commands with matching plugin names', () => {
  for (const missing of ['clear', 'cd']) {
    const commands = ['clear', 'cd'].map((name) => ({ name, source: name === missing ? 'plugin' : 'builtin' }))
    expect(missingJoinCommands(['clear', 'cd'], commands)).toEqual([missing])
  }
  expect(missingJoinCommands(['cd'], [{ name: 'cd', source: 'builtin' }])).toEqual([])
})

test('only completed, failed, or killed background agents permit joining', () => {
  for (const status of ['completed', 'failed', 'killed']) expect(activeBackgroundAgents([{ status }])).toBe(false)
  for (const status of ['running', 'pending']) expect(activeBackgroundAgents([{ status }])).toBe(true)
  expect(activeBackgroundAgents([])).toBe(false)
})

test('join preflight refuses empty worktrees and unauthenticated access before clearing', () => {
  const status = cliFixture('status') as ThreadState
  expect(joinPreflight(status)).toBe('empty')
  expect(joinPreflight({ ...status, access: { state: 'local_only', is_owner: null } })).toBe('access')
})

test('pending share and join operations hold prompts until the operation ends', () => {
  expect(promptGate({ joining: true })).toBe('joining')
  expect(promptGate({ sharing: true })).toBe('sharing')
  expect(promptGate({})).toBeUndefined()
})

test('a joined session works in its first checkout and adds the rest, except in the thread folder', () => {
  const mounted = (...names: string[]) => ({ ...cliFixture('mount'), directory: '/folder',
    worktrees: names.map((name) => ({ reference: name, name, directory: `/checkout/${name}`, state: 'mounted' })) }) as MountedThread
  expect(sessionDirectories(mounted('delta', 'zed', 'web'), false))
    .toEqual(directories('/checkout/delta', '/checkout/zed', '/checkout/web'))
  expect(sessionDirectories(mounted('delta', 'zed'), true)).toEqual(directories('/folder'))
  expect(sessionDirectories(mounted(), false)).toEqual(directories('/folder'))
})

test('worktree changes add new checkouts in place and move only when the first worktree changes', () => {
  const tree = (name: string) => ({ reference: name, name, directory: `/checkout/${name}`, state: 'mounted' }) as ThreadMount
  const [delta, zed, web] = [tree('delta'), tree('zed'), tree('web')]
  for (const [previous, directory, next, folder, added, removed, update] of [
    [[delta], '/checkout/delta', [delta, zed], false, ['zed'], [], directories('/checkout/delta', '/checkout/zed')],
    [[delta, zed], '/checkout/delta', [delta, zed, web], false, ['web'], [], directories('/checkout/delta', '/checkout/web')],
    [[delta, zed, web], '/checkout/delta', [delta, web], false, [], ['zed'], undefined],
    // The session leaves a removed first worktree and adds every remaining other again.
    [[delta, zed, web], '/checkout/delta', [zed, web], false, [], ['delta'], directories('/checkout/zed', '/checkout/web')],
    [[delta], '/checkout/delta', [], false, [], ['delta'], directories('/folder')],
    // A session that joined in the thread folder moves to its first checkout at the next change.
    [[delta], '/folder', [delta, zed], false, ['zed'], [], directories('/checkout/delta', '/checkout/zed')],
    [[delta], '/folder', [delta, zed], true, ['zed'], [], undefined],
  ] as const) {
    const result = worktreeChanges(previous, directory,
      { ...cliFixture('mount'), directory: '/folder', worktrees: [...next] } as MountedThread, folder)
    expect(result.added.map((tree) => tree.name)).toEqual([...added])
    expect(result.removed.map((tree) => tree.name)).toEqual([...removed])
    expect(result.update).toEqual(update)
  }
  const mount = { ...delta, directory: String.raw`\\?\C:\checkout\delta` }
  expect(worktreeChanges([mount], 'C:/checkout/delta',
    { ...cliFixture('mount'), directory: 'C:/folder', worktrees: [mount] } as MountedThread, false))
    .toEqual({ added: [], removed: [] })
})

function directories(workingDirectory: string, ...additionalDirectories: string[]) {
  return { workingDirectory, additionalDirectories }
}
