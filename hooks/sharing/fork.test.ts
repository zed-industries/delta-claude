import { describe, expect, test } from 'claude-code/testing'
import { forkedMessages, forkOriginOf, forkPoints } from './fork'

describe('forked conversations', () => {
  test("a fork names the session it was copied from, as /fork's and /branch's transcripts each say", () => {
    expect(forkOriginOf([
      { type: 'agent-name', agentName: 'Parser fix ⑂ try the lexer' },
      { type: 'derived-from', sessions: [{ type: 'claude_code_session', id: 'parent', via: 'background' }] },
      user('a', 'Fix the parser'),
    ])).toEqual({ parent: 'parent', name: 'Parser fix ⑂ try the lexer' })
    expect(forkOriginOf([{ ...user('a', 'Fix the parser'), forkedFrom: { sessionId: 'parent', messageUuid: 'a' } }]))
      .toEqual({ parent: 'parent' })
    expect(forkOriginOf([user('a', 'Fix the parser'), assistant('b', [text('Done')])])).toBeUndefined()
    // `claude --bg` names the session that launched it, which it copied nothing from.
    expect(forkOriginOf([
      { type: 'derived-from', sessions: [{ type: 'claude_code_session', id: 'launcher', via: 'launch' }] },
      user('a', 'Fix the parser'),
    ])).toBeUndefined()
  })

  test('fork points are the shared rows, latest first, named as recording names their last record', () => {
    const rows = [
      user('a', 'Fix the parser'),
      assistant('b', [text('Reading it'), { type: 'tool_use', id: 'call-1', name: 'Read', input: {} }]),
      user('c', [{ type: 'tool_result', tool_use_id: 'call-1', content: 'source' }]),
      { ...user('d', 'framing the model reads'), isMeta: true },
      { type: 'system', uuid: 'e', content: 'turn took 2s' },
      assistant('f', [text('Fixed')]),
      user('g', 'Now the lexer'),
    ]
    expect(forkPoints(rows, new Set(['a', 'b', 'c', 'd', 'e', 'f'])))
      .toEqual(['f:message:0', 'call-1', 'call-1', 'a:message:0'])
  })

  test("the fork's own messages are what follows the shared history, without framing nobody wrote", () => {
    const rows = [
      user('a', 'Fix the parser'),
      assistant('b', [text('Fixed')]),
      user('c', '<local-command-stdout>.</local-command-stdout>'),
      user('d', 'Now the lexer'),
      assistant('e', [text('On it')]),
    ]
    expect(forkedMessages(rows, new Set(['a', 'b'])).map(({ uuid }) => uuid)).toEqual(['d', 'e'])
  })
})

function text(value: string) {
  return { type: 'text', text: value }
}

function user(uuid: string, content: string | object[]) {
  return { type: 'user', uuid, message: { role: 'user', content } }
}

function assistant(uuid: string, content: object[]) {
  return { type: 'assistant', uuid, message: { role: 'assistant', content } }
}
