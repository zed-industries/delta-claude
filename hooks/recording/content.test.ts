import { describe, expect, test, tier } from 'claude-code/testing'
import { capturedMessage, messageUpdates, resultDiff, resultUpdate, type Update } from './content'

tier('user')

describe('content', () => {
  test('captures only bash-mode command content as readable user rows', () => {
    const input = { type: 'user', role: 'user' as const, content: [
      { type: 'text', text: '<bash-input>ls</bash-input>' },
    ] }
    expect(capturedMessage(input, 'command'))
      .toEqual({ role: 'user', content: [{ type: 'text', text: 'Ran `ls`' }] })
    const output = { ...input, content: [
      { type: 'text', text: '<local-command-caveat>framing</local-command-caveat>' },
      { type: 'text', text: '<bash-stdout>Applications</bash-stdout><bash-stderr></bash-stderr>' },
    ] }
    expect(capturedMessage(output, 'command'))
      .toEqual({ role: 'user', content: [{ type: 'text', text: '```\nApplications\n```' }] })
    expect(capturedMessage({ ...input, content: [{ type: 'text', text: 'Explain <bash-input> in prose.' }] }, 'command'))
      .toBeUndefined()
  })

  test('filters metadata by row provenance while preserving literal lookalike human messages', () => {
    const content = [{ type: 'text', text: '<system-reminder>literal example</system-reminder>\n<command-name>/delta</command-name>' }]
    const human = { type: 'user', role: 'user' as const, content }
    expect(capturedMessage(human, 'prompt')).toEqual({ role: 'user', content })
    expect(capturedMessage(human, 'delivery')).toEqual({ role: 'user', content })
    for (const door of ['command', 'attachment', 'hook-context', 'notice', 'compaction', 'note'])
      expect(capturedMessage(human, door)).toBeUndefined()
    expect(capturedMessage({ ...human, isMeta: true }, 'prompt')).toBeUndefined()
    expect(capturedMessage({ ...human, type: 'attachment' }, 'hook-context')).toBeUndefined()
    expect(capturedMessage({ type: 'assistant', role: 'assistant', content }, 'response')).toEqual({ role: 'assistant', content })
    expect(capturedMessage({ type: 'assistant', role: 'assistant', content }, 'command')).toBeUndefined()
  })

  test('keeps tool results but not neighboring model-only framing', () => {
    const result = { type: 'tool_result', tool_use_id: 't1', content: 'real output' }
    const row = { type: 'user', role: 'user' as const, isMeta: true as const,
      content: [{ type: 'text', text: 'internal framing' }, result] }
    expect(capturedMessage(row, 'tool-result')).toEqual({ role: 'user', content: [result] })
    expect(capturedMessage({ ...row, content: [{ type: 'text', text: 'framing only' }] }, 'tool-message')).toBeUndefined()
  })

  test("titles and kinds tool calls as Claude's ACP adapter does, with paths relative to the root", () => {
    const call = (name: string, input: unknown) => messageUpdates({ role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name, input },
    ] }, 'm1', undefined, { root: '/repo/' })[0]
    expect(call('Read', { file_path: '/repo/src/a.rs', offset: 10, limit: 5 }))
      .toMatchObject({ name: 'Read', title: 'Read src/a.rs (10 - 14)', kind: 'read' })
    expect(call('Read', { file_path: '/elsewhere/b.rs' })).toMatchObject({ title: 'Read /elsewhere/b.rs' })
    expect(call('Bash', { command: 'cargo test \\\n  -p thread' }))
      .toMatchObject({ title: 'cargo test \\ -p thread', kind: 'execute' })
    expect(call('Grep', { pattern: 'fn main', path: '/repo/src', output_mode: 'files_with_matches', '-i': true }))
      .toMatchObject({ title: 'grep -i -l "fn main" src', kind: 'search' })
    expect(call('Task', { description: 'Explore tools' })).toMatchObject({ title: 'Explore tools', kind: 'think' })
    expect(call('mcp__linear__get_issue', {})).toMatchObject({ title: 'mcp__linear__get_issue', kind: 'other' })
  })

  test('leaves plan approvals and their results out of the transcript', () => {
    expect(messageUpdates({ role: 'assistant', content: [
      { type: 'text', text: 'Here is the plan.' },
      { type: 'tool_use', id: 'plan', name: 'ExitPlanMode', input: { plan: 'Do it' } },
    ] }, 'm1')).toEqual([
      { sessionUpdate: 'agent_message', messageId: 'm1:message:0', content: [{ type: 'text', text: 'Here is the plan.' }] },
    ])
    expect(messageUpdates({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'plan', content: 'approved' },
    ] }, 'm2', undefined, { omitted: new Set(['plan']) })).toEqual([])
  })

  test("records a TodoWrite as the turn's plan, as Claude's ACP adapter does, leaving malformed todos out", () => {
    const todos = { todos: [
      { content: 'Read it', activeForm: 'Reading it', status: 'completed' },
      { content: 'Fix it', activeForm: 'Fixing it', status: 'in_progress' },
      { content: 'Ship it', status: 'in_progress' },
      { content: 'Unknown', status: 'blocked' },
      'not a todo',
    ] }
    const todoCall = (input: unknown) =>
      ({ role: 'assistant' as const, content: [{ type: 'tool_use', id: 'todos', name: 'TodoWrite', input }] })
    const call = todoCall(todos)
    expect(messageUpdates(call, 'm1', undefined, { plans: true })).toEqual([{
      sessionUpdate: 'plan_update',
      plan: { type: 'items', planId: 'plan', entries: [
        { content: 'Read it', priority: 'medium', status: 'completed' },
        { content: 'Fixing it', priority: 'medium', status: 'in_progress' },
        { content: 'Ship it', priority: 'medium', status: 'in_progress' },
      ] },
    }])
    // Without plans the call stays a tool call; with them, input that is no todo list records nothing.
    expect(messageUpdates(call, 'm1')[0]).toMatchObject({ sessionUpdate: 'tool_call_update', toolCallId: 'todos' })
    expect(messageUpdates(todoCall({}), 'm1', undefined, { plans: true })).toEqual([])
  })

  test('preserves interleaved complete segments and opaque thought metadata', () => {
    const rows = messageUpdates({ role: 'assistant', content: [
      { type: 'text', text: 'before' },
      { type: 'thinking', thinking: 'reason', signature: 'opaque-signature' },
      { type: 'text', text: 'middle' },
      { type: 'tool_use', id: 't1', name: 'Edit', input: {} },
      { type: 'redacted_thinking', data: 'opaque-redacted' },
      { type: 'text', text: 'after' },
    ] }, 'm1')
    expect(rows).toEqual([
      { sessionUpdate: 'agent_message', messageId: 'm1:message:0', content: [{ type: 'text', text: 'before' }] },
      { sessionUpdate: 'agent_thought', messageId: 'm1:thought:1', content: [{ type: 'text', text: 'reason' }],
        _meta: { claudeCode: { block: { type: 'thinking', thinking: 'reason', signature: 'opaque-signature' } } } },
      { sessionUpdate: 'agent_message', messageId: 'm1:message:2', content: [{ type: 'text', text: 'middle' }] },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', name: 'Edit', title: 'Edit', kind: 'edit',
        status: 'in_progress', rawInput: {} },
      { sessionUpdate: 'agent_thought', messageId: 'm1:thought:4',
        content: [{ type: 'text', text: '[redacted thinking]' }],
        _meta: { claudeCode: { block: { type: 'redacted_thinking', data: 'opaque-redacted' } } } },
      { sessionUpdate: 'agent_message', messageId: 'm1:message:5', content: [{ type: 'text', text: 'after' }] },
    ])
  })

  test('skips blank text and signature-only thoughts while preserving redacted and nonblank content', () => {
    for (const role of ['user', 'assistant'] as const)
      expect(messageUpdates({ role, content: [
        { type: 'text', text: '' }, { type: 'text', text: ' \n\t ' },
      ] }, 'blank')).toEqual([])
    expect(messageUpdates({ role: 'assistant', content: [
      { type: 'thinking', thinking: '', signature: 'signature-only' },
      { type: 'text', text: ' \n ' },
      { type: 'thinking', thinking: '\t\n', signature: 'whitespace-only' },
      { type: 'text', text: ' kept ' },
      { type: 'thinking', thinking: '', signature: 'another-signature' },
      { type: 'text', text: 'also kept' },
      { type: 'redacted_thinking', data: 'opaque-redacted' },
    ] }, 'm')).toEqual([
      { sessionUpdate: 'agent_message', messageId: 'm:message:3',
        content: [{ type: 'text', text: ' kept ' }, { type: 'text', text: 'also kept' }] },
      { sessionUpdate: 'agent_thought', messageId: 'm:thought:6',
        content: [{ type: 'text', text: '[redacted thinking]' }],
        _meta: { claudeCode: { block: { type: 'redacted_thinking', data: 'opaque-redacted' } } } },
    ])
  })

  test('wraps MCP tool result content in ACP v2 variants and preserves payloads', () => {
    const result = [
      { type: 'text', text: 'changed' },
      { type: 'image', data: 'AA==', mimeType: 'image/png' },
      { type: 'image', source: { type: 'base64', data: 'AQ==', media_type: 'image/jpeg' } },
      { type: 'image', source: { type: 'url', url: 'https://example.org/a.png' } },
      { type: 'audio', data: 'Ag==', mimeType: 'audio/wav' },
      { type: 'resource', resource: { uri: 'file:///doc', text: 'body',
        mimeType: 'text/plain', _meta: { origin: 'mcp' } } },
      { type: 'resource', resource: { uri: 'file:///blob', blob: 'Aw==' } },
      { type: 'resource_link', name: 'doc', uri: 'https://example.org/doc', title: 'Guide',
        description: 'details', size: 7, mimeType: 'text/plain', _meta: { origin: 'mcp' } },
    ]
    expect(messageUpdates({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: result },
    ] }, 'm2')).toEqual([{
      sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: result,
      content: [
        { type: 'content', content: { type: 'text', text: 'changed' } },
        { type: 'content', content: { type: 'image', data: 'AA==', mimeType: 'image/png' } },
        { type: 'content', content: { type: 'image', data: 'AQ==', mimeType: 'image/jpeg' } },
        { type: 'content', content: { type: 'resource_link', name: 'https://example.org/a.png',
          uri: 'https://example.org/a.png' } },
        { type: 'content', content: { type: 'audio', data: 'Ag==', mimeType: 'audio/wav' } },
        { type: 'content', content: { type: 'resource', resource: { uri: 'file:///doc', text: 'body',
          mimeType: 'text/plain', _meta: { origin: 'mcp' } } } },
        { type: 'content', content: { type: 'resource', resource: { uri: 'file:///blob', blob: 'Aw==' } } },
        { type: 'content', content: { type: 'resource_link', name: 'doc', uri: 'https://example.org/doc',
          title: 'Guide', description: 'details', size: 7, mimeType: 'text/plain',
          _meta: { origin: 'mcp' } } },
      ],
    }])
    expect(messageUpdates({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'failed', is_error: true },
    ] }, 'm3')[0]).toEqual({ sessionUpdate: 'tool_call_update', toolCallId: 't1',
      status: 'failed', rawOutput: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'failed' } }] })
  })

  test('keeps input-only rows open and closes with source result content and a recorded diff', () => {
    const diff = resultDiff('Edit', { filePath: '/repo/a' })
    const recorded = new Map<string, Update>([['t1', {
      sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed',
      rawOutput: { filePath: '/repo/a' }, content: diff,
    }]])
    expect(messageUpdates({ role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'Edit', input: {} },
    ] }, 'm4', recorded)[0]?.status).toBe('in_progress')
    expect(messageUpdates({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'updated /repo/a' },
    ] }, 'm5', recorded)).toEqual([{
      sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed',
      rawOutput: { filePath: '/repo/a' },
      content: [{ type: 'content', content: { type: 'text', text: 'updated /repo/a' } }, ...diff],
    }])
  })

  test('a cached final status never closes an input-only row, including failed and empty results', () => {
    for (const status of ['completed', 'failed']) {
      const recorded = new Map<string, Update>([['t1', {
        sessionUpdate: 'tool_call_update', toolCallId: 't1', status, rawOutput: '',
      }]])
      expect(messageUpdates({ role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
      ] }, 'input', recorded)).toEqual([{
        sessionUpdate: 'tool_call_update', toolCallId: 't1', name: 'Bash', title: 'Terminal', kind: 'execute',
        status: 'in_progress', rawInput: {},
      }])
      expect(messageUpdates({ role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: '' },
      ] }, 'output', recorded)).toEqual([{
        sessionUpdate: 'tool_call_update', toolCallId: 't1', status, rawOutput: '',
        content: [{ type: 'content', content: { type: 'text', text: '' } }],
      }])
    }
  })

  test('records file changes without invented locations unless a structured patch exists', () => {
    expect(resultDiff('Edit', { filePath: '/repo/a' })).toEqual([
      { type: 'diff', changes: [{ operation: 'modify', path: '/repo/a' }] },
    ])
    expect(resultDiff('Write', { type: 'create', filePath: '/repo/new' })).toEqual([
      { type: 'diff', changes: [{ operation: 'add', path: '/repo/new' }] },
    ])
    expect(resultDiff('Edit', {
      filePath: '/repo/a', structuredPatch: [
        { oldStart: 12, oldLines: 2, newStart: 12, newLines: 2, lines: [' line', '-old', '+new'] },
      ],
    })).toEqual([{
      type: 'diff', changes: [{ operation: 'modify', path: '/repo/a' }],
      patch: { format: 'git_patch',
        text: 'diff --git a/repo/a b/repo/a\n--- a/repo/a\n+++ b/repo/a\n@@ -12,2 +12,2 @@\n line\n-old\n+new\n' },
    }])
    expect(resultDiff('Bash', {})).toEqual([])
    expect(resultDiff('Edit', { filePath: 'relative' })).toEqual([])
    expect(resultDiff('Edit', 'old string not found')).toEqual([])
    expect(resultDiff('Edit', undefined)).toEqual([])
  })

  test('an edit records its patch relative to the checkout in place of its raw result', () => {
    const result = { filePath: '/repo/src/a.rs', originalFile: 'whole file', oldString: 'old', newString: 'new',
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }] }
    const update = resultUpdate('t1', 'Edit', result, false, '/repo')
    expect(update).toEqual({
      sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: null,
      content: [{ type: 'diff', changes: [{ operation: 'modify', path: '/repo/src/a.rs' }], patch: { format: 'git_patch',
        text: 'diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1,1 +1,1 @@\n-old\n+new\n' } }],
    })
    const [row] = messageUpdates({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'updated' },
    ] }, 'm1', new Map([['t1', update]]))
    expect(row?.rawOutput).toBeNull()
    expect(JSON.stringify(row)).not.toContain('whole file')
    // A failed edit has no diff, so its raw result still explains what went wrong.
    expect(resultUpdate('t2', 'Edit', 'old string not found', true, '/repo'))
      .toMatchObject({ status: 'failed', rawOutput: 'old string not found' })
  })

  test('retains malformed optional data as opaque text instead of invalid ACP', () => {
    for (const block of [
      { type: 'text', text: 'ok', annotations: { audience: ['bogus'] } },
      { type: 'resource_link', uri: 'docs://a', size: 'large' },
      { type: 'resource_link', uri: 'docs://a', icons: [{ src: 1 }] },
      { type: 'text', text: 'ok', _meta: 'not an object' },
    ]) {
      const updates = messageUpdates({ role: 'user', content: [block] }, 'invalid')
      expect(updates[0]?.content).toEqual([{ type: 'text', text: JSON.stringify(block) }])
    }
  })
})
