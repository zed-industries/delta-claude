import { cliFixtureData } from './cli-fixture-data'

const names = {
  status: 'thread-status.granted', recorded: 'thread-append.recorded',
  fenced: 'thread-append.fenced', duplicate: 'thread-append.duplicate', create: 'thread-create',
  share: 'thread-share', attach: 'worktree-attach', mount: 'thread-mount',
  unmount: 'thread-unmount', contract: 'thread-contract', invite: 'thread-invite',
}

export const cliWatchFrames = cliFixtureData['thread-watch.frames'] as Record<string, any>[]
const frames = {
  ready: 'ready', item: 'item', itemAppend: 'item.append', remove: 'remove', live: 'live',
  turn: 'turn', producerTurn: 'producer.turn', presence: 'presence', worktrees: 'worktrees', error: 'error',
  comment: 'comment', commentRemove: 'comment.remove',
}

/** Each test receives an independent response; patches never mutate the JSON example. */
export function cliFixture(name: keyof typeof names | keyof typeof frames, patch: Record<string, unknown> = {}): Record<string, any> {
  const fixture = name in names ? cliFixtureData[names[name as keyof typeof names]]
    : cliWatchFrames.find((frame) => (frame.type ?? (frame.error ? 'error' : undefined)) === frames[name as keyof typeof frames])
  if (!fixture) throw new Error(`Missing CLI fixture ${name}`)
  return { ...structuredClone(fixture), ...patch }
}

export const cliFixtures = Object.fromEntries(
  [...Object.keys(names), ...Object.keys(frames)].map((name) => [name, cliFixture(name as keyof typeof names | keyof typeof frames)]),
) as Record<keyof typeof names | keyof typeof frames, Record<string, any>>
export const cliErrorCodes = cliFixtureData['error-codes']!
