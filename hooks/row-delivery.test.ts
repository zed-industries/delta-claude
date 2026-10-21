import { expect, test } from 'claude-code/testing'
import { announceThought, DrawnRows, DrawQueue, shownCommandRewrite } from './row-delivery'
import { cliFixture } from './cli-fixtures'
import type { WatchItem } from './thread-commands'

test('unrelated commands and other plugins retain their rows', () => {
  const echo = '<command-name>/delta</command-name><command-args>show a</command-args>'
  const row = { door: 'command', origin: { kind: 'plugin', name: 'delta-plugin' },
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: echo }] } }
  expect(shownCommandRewrite('delta-plugin', row)).toEqual({ content: [], echo: true })
  // A run the transcript kept without its arguments is still the plugin's own.
  expect(shownCommandRewrite('delta-plugin', { ...row, message: {
    ...row.message, content: [{ type: 'text', text: '<command-name>/delta</command-name><command-args></command-args>' }],
  } })).toEqual({ content: [], echo: true })
  for (const origin of [{ kind: 'composer' }, { kind: 'plugin', name: 'other' }])
    expect(shownCommandRewrite('delta-plugin', { ...row, origin })).toBeUndefined()
  for (const text of ['<command-name>/cost</command-name><command-args></command-args>',
    '<command-name>/delta</command-name><command-args>share</command-args>'])
    expect(shownCommandRewrite('delta-plugin', { ...row, message: { ...row.message, content: [{ type: 'text', text }] } }))
      .toBeUndefined()
  const output = (text: string) => ({ ...row, origin: { kind: 'engine' }, message: {
    type: 'system', name: 'local_command', content: [{ type: 'text', text: `<local-command-stdout>${text}</local-command-stdout>` }],
  } })
  const neutral = [{ type: 'text', text: '<local-command-stdout>.</local-command-stdout>' }]
  // The answer names the item it draws, which is read out and stored as the bare placeholder.
  expect(shownCommandRewrite('delta-plugin', output('delta-plugin: . comment:c1'))).toEqual({ content: neutral, item: 'comment:c1' })
  expect(shownCommandRewrite('delta-plugin', output('delta-plugin: .'))).toEqual({ content: neutral })
  expect(shownCommandRewrite('delta-plugin', output('.'))).toEqual({ content: neutral })
  // Another plugin's answer, or a command that printed something else, is left alone.
  for (const text of ['other: . a', '. a', 'delta-plugin: Usage: /delta share'])
    expect(shownCommandRewrite('delta-plugin', output(text))).toBeUndefined()
})

test('a run draws once its output row is stored, and is not drawn when it never is', async () => {
  const tasks: (() => void)[] = []
  const after = (_milliseconds: number, action: () => void) => {
    tasks.push(action)
    return { cancel() {} }
  }
  const queue = new DrawQueue()
  const stored = queue.wait('session', 'a', () => false, after)
  const lost = queue.wait('session', 'b', () => false, after)
  // Both commands ran: neither is waiting for a hook any more.
  queue.shift()
  queue.shift()
  queue.confirm('a')
  expect(await stored).toEqual({})
  for (const task of tasks.splice(0)) task()
  expect((await lost).deny).toBeDefined()
})

test('an item is drawn once across repeated or corrected model-row offers', async () => {
  const rows = new DrawnRows()
  const drawn: string[] = []
  const draw = async () => { drawn.push('a'); return {} }
  await rows.drawOnce('a', draw)
  await rows.drawOnce('a', draw)
  await rows.drawOnce('a', draw)
  expect(drawn).toEqual(['a'])
})

test('a live thought is announced on completion, not while streaming or on re-send', () => {
  const open = { ...cliFixture('item').item, kind: 'agent_thought', open: true } as WatchItem
  const complete = { ...open, open: false }
  expect(announceThought(undefined, open, true)).toBe(false)
  expect(announceThought(open, complete, true)).toBe(true)
  expect(announceThought(complete, complete, true)).toBe(false)
})

test('queued draws wait out a local turn, keep order, and settle once', async () => {
  const tasks: (() => void)[] = []
  const after = (milliseconds: number, action: () => void) => {
    expect(milliseconds).toBe(2000)
    tasks.push(action)
    return { cancel() {} }
  }
  const queue = new DrawQueue()
  let held = true
  const first = queue.wait('session', 'a', () => held, after)
  const second = queue.wait('session', 'b', () => held, after)
  tasks.shift()!()
  expect(queue.length).toBe(2)
  held = false
  const entry = queue.shift()!
  expect(entry.id).toBe('a')
  entry.settle({})
  entry.settle({ deny: 'late refusal' })
  expect(await first).toEqual({})
  expect(queue.shift()!.id).toBe('b')
  // The second draw no longer has a hook capable of answering it.
  tasks.shift()!()
  expect((await second).deny).toBeDefined()
  expect(queue.length).toBe(0)
})
