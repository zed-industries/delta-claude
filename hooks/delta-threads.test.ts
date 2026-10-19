import { describe, expect, test, tier } from 'claude-code/testing'
import {
  adoptionPrompt, deltaTurnReport, historyText, itemsSince, looksLikeThreadLink, namedThread, resumePrompt,
} from './delta-threads'
import type { WatchChild, WatchItem } from './thread-commands'

tier('user')

describe('Delta threads as subagents', () => {
  test('a SendMessage names a thread by its name, id or reference, and a name two threads share names neither', () => {
    const threads = [child('t1', 'Release notes'), child('t2', 'Fix the parser'), child('t3', 'Fix the parser')]
    expect(namedThread(' release NOTES ', threads)?.thread_id).toBe('t1')
    expect(namedThread('t2', threads)?.thread_id).toBe('t2')
    expect(namedThread('root#s=t3', threads)?.thread_id).toBe('t3')
    expect(namedThread('Fix the parser', threads)).toBeUndefined()
    expect(namedThread('researcher', threads)).toBeUndefined()
  })

  test('links and references are told apart from agent names', () => {
    for (const to of ['https://delta.dev/join/abc', 'thread_01m526jsd8sjcwyhdtvjbcf1dq#s=knUgtWHK',
      'ksQQPUcOLentSY6K1KLaW694V5LNDHaSAcQQWINB9t_GTg-2ufnDFe88fA'])
      expect(looksLikeThreadLink(to)).toBe(true)
    for (const to of ['researcher', 'Release notes', 'a356982e2100cf03e', 'main'])
      expect(looksLikeThreadLink(to)).toBe(false)
  })

  test("what happened since a subagent last ran is everything after its own last item", () => {
    const own = (item: WatchItem): WatchItem => ({ ...item, author: { ...item.author!, actor_id: 'actor-own' } })
    const items = [
      message('prompt', 'user_message', null, 'Map the repo'),
      own(message('own-1', 'agent_message', '1', 'Mapped.', false, 'Claude Code')),
      message('ask', 'user_message', null, 'Now add a line three', false, 'Nathan', 'user-nathan'),
      // Another Claude's output is not this subagent's, though Delta shows the same name.
      { ...message('other-claude', 'agent_message', '2', 'Added three.', false, 'Claude Code'), author: { user_id: null, name: 'Claude Code', actor_id: 'actor-other' } },
      message('open', 'agent_message', '2', 'Still typing', true, 'zed.dev/gpt-6.1-sol'),
    ]
    expect(itemsSince(items, 'actor-own').map((item) => item.id)).toEqual(['ask', 'other-claude'])
    // Without its own actor, nothing is the subagent's own.
    expect(itemsSince(items, undefined).map((item) => item.id)).toEqual(['prompt', 'own-1', 'ask', 'other-claude'])
  })

  test("a thread's history keeps its newest items within the budget and says how to read the rest", () => {
    const items = Array.from({ length: 5 }, (_, index) => message(`m${index}`, 'agent_message', 'x', `${index}`.repeat(200)))
    const text = historyText(items, 'thread-ref', 700)
    expect(text).toContain('4'.repeat(200))
    expect(text).not.toContain('0'.repeat(200))
    expect(text).toMatch(/earlier items? left out; read them with `delta thread show thread-ref --format summarize`/)
  })

  test("a run's prompt with no history is the message alone", () => {
    expect(adoptionPrompt('Release notes', '', 'Write it')).toBe('Write it')
    expect(resumePrompt('Release notes', ' ', 'Write it')).toBe('Write it')
  })

  test("a Delta turn's report names who ran it, its messages and its tool calls, and nothing is reported without a message", () => {
    const report = deltaTurnReport('Note writer', [
      message('ask', 'user_message', null, 'Add three', false, 'Nathan'),
      { ...message('tool', 'tool_call', 'kg', ''), content: { title: 'Edit note.txt' } },
      message('reply', 'agent_message', 'kg', 'Added three.', false, 'zed.dev/gpt-6.1-sol'),
    ], 'ref')!
    expect(report).toContain('zed.dev/gpt-6.1-sol ran a turn in the thread "Note writer" in Delta, with 1 tool call')
    for (const part of ['Add three', 'Added three.', 'SendMessage']) expect(report).toContain(part)
    expect(deltaTurnReport('Note writer', [{ ...message('tool', 'tool_call', 'kg', ''), content: { title: 'Edit' } }], 'ref')).toBeUndefined()
  })
})

function child(thread_id: string, name: string): WatchChild {
  return { thread_id, name, kind: 'subthread', status: 'inactive', reference: `root#s=${thread_id}` }
}

function message(id: string, kind: string, turn: string | null, text: string, open = false, author?: string, user: string | null = null): WatchItem {
  return {
    id, kind, after_id: null, turn_id: turn, author: author ? { user_id: user, name: author } : null,
    created_at: null, open, content: { text },
  }
}
