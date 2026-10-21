import { describe, expect, test, tier } from 'claude-code/testing'
import {
  DISPLAY_LIMIT, LEDGER_SAVE_INTERVAL, MARKDOWN_LIMIT, OMITTED, RemoteView, SNAPSHOT_TAIL, compactionRound, earlierItemsNotice, omittedItemsRow, addRows, snapshotBudget, snapshotLimit, toolRunRow, middleTruncate, conversationText, conversationWebLink, isMessageItem, itemAuthor, itemDisplay,
  isDrawnItem, itemFingerprint, itemMarkdown, personParagraphs, removedItemRow, renderItem, type Ledger, type PendingRow, type RowSink,
  commentAction, commentDisplay, commentFingerprint, commentKey, commentQuote, renderComment, type QuotedLine,
} from './conversation'
import type { WatchComment, WatchCommentTarget, WatchItem } from './thread-commands'

tier('user')

describe('conversation', () => {
  test('a message row names its author, kind and item and carries the whole text', () => {
    const row = renderItem(item('Please rename the flag.\nThen run the tests.'), 'thread')!
    for (const part of ['Ada', 'item-1', 'Please rename the flag.\nThen run the tests.']) expect(row).toContain(part)
    expect(renderItem(item('Done.', { kind: 'agent_message', author: { user_id: null, name: 'Claude' } }), 'thread'))
      .toContain('Done.')
    expect(renderItem(item('Now it says this'), 'thread', true))
      .toContain('item-1')
    expect(renderItem(item('Now it says this'), 'thread', true)).toContain('Now it says this')
  })

  test('a tool call row shows its name, status, input, patch and output', () => {
    const row = renderItem(item('', {
      kind: 'tool_call', author: { user_id: null, name: 'Claude' },
      content: {
        toolCallId: 'call-1', name: 'edit', title: 'Edit src/main.rs', status: 'completed',
        rawInput: { path: 'src/main.rs' },
        content: [
          { type: 'diff', path: '/repo/src/main.rs', oldText: 'a', newText: 'b', patch: '@@ -1 +1 @@\n-a\n+b' },
          { type: 'content', content: { type: 'text', text: 'Applied 1 edit' } },
          { type: 'terminal', terminalId: 'term-1' },
        ],
        rawOutput: { ok: true },
      },
    }), 'thread')!
    for (const part of ['Claude', 'Edit src/main.rs', 'completed', 'item-1']) expect(row.split('\n')[0]).toContain(part)
    for (const part of ['Input: {"path":"src/main.rs"}', 'Changed /repo/src/main.rs:\n@@ -1 +1 @@\n-a\n+b',
      'Applied 1 edit', 'Terminal term-1', 'Output:\n{"ok":true}'])
      expect(row).toContain(part)
  })

  test('large sections and rows are truncated at a marker naming the full read', () => {
    const output = 'o'.repeat(50_000)
    const row = renderItem(item('', { kind: 'tool_call', content: {
      sessionUpdate: 'tool_call_update', toolCallId: 'session/call-1',
      title: 'Run command', name: 'Bash', kind: 'execute', status: 'completed',
      rawInput: { command: 'printf output' },
      content: [{ type: 'content', content: { type: 'text', text: output } }],
    } }), 'thread-9')!
    expect(row).toContain('tool call Run command (completed)')
    expect(row).toContain('Input: {"command":"printf output"}')
    expect(row).toContain('o'.repeat(100))
    expect(row.length).toBeLessThan(10_000)
    expect(row).toContain('delta thread show thread-9 --format messages --messages 1-20')
    const message = renderItem(item('m'.repeat(50_000)), 'thread-9')!
    expect(message.length).toBeLessThan(25_000)
    expect(message).toContain('delta thread show thread-9 --format messages --messages 1-20')
  })

  test('other kinds render their fields; unknown kinds and empty content render nothing', () => {
    expect(renderItem(item('', { kind: 'runner_activity', content: { status: 'running', label: 'Cloud runner' } }), 'thread'))
      .toContain('{"status":"running","label":"Cloud runner"}')
    expect(renderItem(item('summary', { kind: 'compaction' }), 'thread')).toContain('summary')
    expect(renderItem(item('anything', { kind: 'unknown' }), 'thread')).toBeUndefined()
    // A remote agent's thinking is for the person, not the model.
    expect(renderItem(item('private reasoning', { kind: 'agent_thought' }), 'thread')).toBeUndefined()
    expect(renderItem(item('  '), 'thread')).toBeUndefined()
    expect(removedItemRow('item-1', item('x'))).toContain('(item item-1)')
    expect(removedItemRow('item-1', item('x'))).toContain('Ada')
  })

  test('a pending author renders a fallback and a resolved re-send adds no correction', async () => {
    const pending = item('Hello', { author: { user_id: null, name: null } })
    expect(itemAuthor(pending).length).toBeGreaterThan(0)
    expect(itemAuthor({ ...pending, kind: 'agent_message' }).length).toBeGreaterThan(0)
    const view = live()
    view.upsert(pending)
    expectModelRows(await texts(view), ['item-1'], ['Hello'])
    // Delta re-sends the same item id once the actor resolves to a user; the pane shows the name.
    view.upsert({ ...pending, author: { user_id: 'user-ada', name: 'Ada' } })
    expect(itemAuthor(view.items.get('item-1')!)).toBe('Ada')
    // Attribution is not content, so the resolved re-send adds no correction row.
    expect(await texts(view)).toEqual([])
  })

  test('thread events are drawn without model-only markup, while context retains the full event', async () => {
    for (const kind of ['subthread_event', 'land_result']) {
      const event = item('Land changes: \n<subthread-event kind="land" event="created" note="Informational, not a task.">\n</subthread-event>', {
        kind,
      })
      expect(isDrawnItem(event)).toBe(true)
      expect(itemMarkdown(event, 'thread')).toBe('Land changes')
      expect(itemDisplay(event, 'thread')).toBe('Delta activity:\nLand changes')
      expect(renderItem(event, 'thread')).toContain('Informational, not a task.')
      const view = live()
      view.upsert(event)
      const row = (await view.nextRow())!
      expect(row.commandItem).toBe(event.id)
      view.commit(row)
      view.reset()
      view.upsert(event)
      view.endSnapshot()
      expect(await view.nextRow()).toBeUndefined()
    }
    const result = item('Landed: Land Changes\nmain 2d867ce6c CI passed', {
      kind: 'subthread_event', content: { text: 'Landed: Land Changes\nmain 2d867ce6c CI passed', event: 'landed' },
    })
    expect(itemMarkdown(result, 'thread')).toBe('Landed: Land Changes\nmain 2d867ce6c CI passed')
    expect(renderItem(result, 'thread')).toContain('"event":"landed"')
    expect(isDrawnItem(item('metadata', { kind: 'model_changed' }))).toBe(false)
  })

  test('the fingerprint follows content, not attribution or position', async () => {
    const base = item('Same text')
    const same = await itemFingerprint(base)
    expect(await itemFingerprint({ ...base, author: { user_id: 'u', name: 'Ada' }, after_id: 'x', turn_id: 't' })).toBe(same)
    expect(await itemFingerprint(item('Other text'))).not.toBe(same)
    expect(await itemFingerprint({ ...base, kind: 'agent_message' })).not.toBe(same)
  })

  test('markdown markers are stripped, because a notice draws them literally', () => {
    const paragraphs = personParagraphs('Not much is going on.\n\n- no diff\n- no staged changes\n\n\n**Done.**')
    expect(paragraphs).toHaveLength(3)
    expect(paragraphs.every((paragraph) => paragraph.trim().length > 0 && !paragraph.includes('**'))).toBe(true)
    expect(itemDisplay(item('  \n\n  '), 'thread')).toBeUndefined()
    const crossAgent = itemDisplay(item('Hello', { kind: 'cross_agent_message', author: { user_id: null, name: null } }), 'thread')!
    expect(crossAgent).toContain('Hello')
    expect(crossAgent).toContain(itemAuthor(item('Hello', { kind: 'cross_agent_message', author: { user_id: null, name: null } })))
    expect(personParagraphs('# Heading\n\n## Smaller\n\nText with **bold**, `code` and _emphasis_.\n\n> quoted'))
      .toEqual(['Heading', 'Smaller', 'Text with bold, code and emphasis.', 'quoted'])
    // An identifier's underscores stay; only emphasis markers go.
    expect(personParagraphs('keep snake_case and file_name.ts'))
      .toEqual(['keep snake_case and file_name.ts'])
  })

  test('a person-visible tool call is one line naming what ran', () => {
    const tool = (content: Record<string, unknown>) => itemDisplay(item('', {
      kind: 'tool_call', author: { user_id: null, name: 'Claude' }, content,
    }), 'thread-9')!
    // A title that already names the input is not repeated; output and patches stay out of the line.
    const edited = tool({
      toolCallId: 'call-1', name: 'edit', title: 'Edit src/main.rs', status: 'completed',
      rawInput: { file_path: 'src/main.rs' },
      content: [{ type: 'diff', path: '/repo/src/main.rs', patch: '@@ -1 +1 @@\n-a\n+b' }],
      rawOutput: 'o'.repeat(5_000),
    })
    expect(edited).toContain('Claude')
    expect(edited).toContain('Edit src/main.rs')
    expect(edited).not.toContain('@@')
    expect(edited).not.toContain('o'.repeat(100))
    // A title naming the input relative to its producer's checkout, or naming a command too long to
    // show whole, still counts as naming it.
    expect(tool({ name: 'Read', title: 'Read src/a.rs', rawInput: { file_path: '/repo/src/a.rs' } }))
      .not.toContain('/repo/')
    const command = `cargo test -p thread ${'external_recording '.repeat(5)}`
    expect(tool({ name: 'Bash', title: command, rawInput: { command } }).match(/cargo test/g)).toHaveLength(1)
    // A multi-line command is flattened, and a status other than completed is named.
    expect(tool({ name: 'Bash', status: 'failed', rawInput: { command: 'cargo test\n  -p thread' } }))
      .toContain('cargo test -p thread')
    expect(tool({ name: 'Bash', status: 'failed', rawInput: { command: 'cargo test\n  -p thread' } })).toContain('failed')
    // A long input keeps its start and its end, so a path still names its file.
    const path = `/Users/ada/delta/checkouts/${'d'.repeat(400)}/src/main.rs`
    const long = tool({ name: 'Read', status: 'failed', rawInput: { file_path: path } })
    expect(long.includes('\n')).toBe(false)
    expect(long.length).toBeLessThanOrEqual(200)
    for (const part of ['Claude', 'Read', '/Users/ada/']) expect(long).toContain(part)
    expect(long).toContain('…')
    expect(long.endsWith('/src/main.rs (failed)')).toBe(true)
  })

  test('middle truncation keeps the start, an ellipsis and the larger end, within the width', () => {
    expect(middleTruncate('short', 10)).toBe('short')
    const cut = middleTruncate('abcdefghijklmnopqrstuvwxyz', 11)
    expect(cut.startsWith('abcd')).toBe(true)
    expect(cut.endsWith('uvwxyz')).toBe(true)
    expect(cut).toContain('…')
    expect(cut.length).toBe(11)
    expect(middleTruncate('abcdef', 2)).toBe('')
    // A surrogate pair is never split at either cut.
    const emoji = middleTruncate('🌳'.repeat(10), 7)
    expect(emoji).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]…|…[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/)
  })

  test('an item keeps its own markdown for a Markdown element, bounded at the element\'s limit', () => {
    expect(itemMarkdown(item('# Title\n\n**bold** and `code`'), 'thread')).toBe('# Title\n\n**bold** and `code`')
    const long = itemMarkdown(item('m'.repeat(MARKDOWN_LIMIT + 5_000)), 'thread-9')
    expect(long.length).toBeLessThanOrEqual(MARKDOWN_LIMIT)
    expect(long).toContain('more characters; read with')
  })

  test('a person-visible thought is labelled, and other or empty kinds show nothing', () => {
    const thought = itemDisplay(item('Weighing options\nmore', { kind: 'agent_thought' }), 'thread')!
    expect(thought).toContain('Ada')
    expect(thought).toContain('Weighing options more')
    expect(thought.split('\n')).toHaveLength(2)
    expect(itemDisplay(item('mystery', { kind: 'unknown' }), 'thread')).toBeUndefined()
    expect(itemDisplay(item('', { kind: 'user_message' }), 'thread')).toBeUndefined()
  })

  test('an oversized message is bounded with a note naming how to read the rest', () => {
    const row = itemDisplay(item('m'.repeat(50_000)), 'thread-9')!
    // The bound is one drawn entry: the transcript draws a `$.ui.log` line's first 2,000 characters.
    for (const entry of row.split('\n')) expect(entry.length).toBeLessThanOrEqual(DISPLAY_LIMIT)
    expect(row).toContain('Ada')
    expect(row).toContain('mmm')
    expect(row).toContain('delta thread show thread-9 --format messages --messages 1-20')
    expect(row.split('\n')).toHaveLength(2)
  })

  test('renders Delta patch markers and terminal controls without corrupting stored text', () => {
    const patch = '\0Apply patch goodbye.txt\r\n@@ -0,0 +1 @@\n+\u001b[32mWritten from Delta\u007f\u0085\t'
    expect(conversationText(patch)).toBe('Apply patch goodbye.txt\n@@ -0,0 +1 @@\n+[32mWritten from Delta\t')
    expect(renderItem(item(patch), 'thread')).not.toContain('\u001b')
  })

  test('web links are safe for the native link element', () => {
    expect(conversationWebLink('https://delta.dev/join/thread_123')).toBe('https://delta.dev/join/thread_123')
    for (const url of ['javascript:alert(1)', 'https://user:password@example.com', 'not a URL'])
      expect(conversationWebLink(url)).toBeUndefined()
  })
})

describe('remote view', () => {
  test('removal knowledge is bounded, survives reconnects, and clears on reappearance', () => {
    const view = new RemoteView('thread', { thread: 'thread', items: {} })
    expect(view.wasRemoved('unknown')).toBe(false)
    for (let index = 0; index < 4097; index++) view.remove(`removed-${index}`)
    expect(view.wasRemoved('removed-0')).toBe(false)
    expect(view.wasRemoved('removed-1')).toBe(true)
    view.reset()
    expect(view.wasRemoved('removed-4096')).toBe(true)
    view.upsert(item('Returned', { id: 'removed-4096' }))
    expect(view.wasRemoved('removed-4096')).toBe(false)
    const restarted = new RemoteView('thread', view.ledger)
    expect(restarted.wasRemoved('removed-1')).toBe(false)
  })

  test('a snapshot yields one quiet row per completed item and skips open and unknown items', async () => {
    const view = new RemoteView('thread', { thread: 'thread', items: {} })
    view.upsert(item('Question', { id: 'a' }))
    view.upsert(item('Still typing', { id: 'b', kind: 'agent_message', open: true }))
    view.upsert(item('mystery', { id: 'c', kind: 'unknown' }))
    view.upsert(item('reasoning', { id: 'd', kind: 'agent_thought' }))
    view.endSnapshot()
    const offered = await rows(view)
    expect(offered).toHaveLength(1)
    expect(offered[0]).toMatchObject({ id: 'a', commandItem: 'a', quiet: true })
    expect(offered[0]?.text).toContain('Question')
    expect(Object.keys(view.ledger.items)).toEqual(['a'])
  })

  test('a live item gets no row while open, then one command row when complete', async () => {
    const view = live()
    view.upsert(item('Working', { id: 's', kind: 'agent_message', open: true }))
    view.appendText('s', ' on it')
    expect(await rows(view)).toEqual([])
    expect(view.items.get('s')?.content.text).toBe('Working on it')
    view.upsert({ ...view.items.get('s')!, content: { text: 'Working on it. Done.' }, open: false })
    const offered = await rows(view)
    expect(offered).toHaveLength(1)
    expect(offered[0]).toMatchObject({ id: 's', commandItem: 's', quiet: false })
    expect(offered[0]?.text).toContain('Working on it. Done.')
    expect(() => view.appendText('missing', 'x')).toThrow('unknown item')
  })

  test('edits and removals of a shown item yield correction rows; moves and unseen items yield nothing', async () => {
    const view = live()
    const question = item('Use port 8080', { id: 'q' })
    view.upsert(question)
    await rows(view)
    view.upsert({ ...question, after_id: 'x', author: { user_id: 'other', name: 'Ada' } })
    expect(await rows(view)).toEqual([])
    view.upsert({ ...question, content: { text: 'Use port 9090' } })
    expectModelRows(await texts(view), ['q'], ['Use port 9090'])
    view.remove('q')
    expectModelRows(await texts(view), ['q'])
    expect(view.ledger.items).toEqual({})
    view.upsert(item('draft', { id: 'open', open: true }))
    view.remove('open')
    expect(await rows(view)).toEqual([])
  })

  test('a reconnect or restart snapshot repeats nothing and corrects what changed while away', async () => {
    const view = live()
    for (const [id, text] of [['a', 'Keep me'], ['b', 'Change me'], ['c', 'Remove me']]) view.upsert(item(text!, { id }))
    await rows(view)
    // A restart rebuilds the view from the saved ledger.
    const restarted = new RemoteView('thread', JSON.parse(JSON.stringify(view.ledger)) as Ledger)
    for (const target of [view, restarted]) {
      target.reset()
      target.upsert(item('Keep me', { id: 'a' }))
      target.upsert(item('Changed while away', { id: 'b' }))
      target.endSnapshot()
      expectModelRows(await texts(target), ['b', 'c'], ['Changed while away'])
      target.reset()
      target.upsert(item('Keep me', { id: 'a' }))
      target.upsert(item('Changed while away', { id: 'b' }))
      target.endSnapshot()
      expect(await rows(target)).toEqual([])
    }
  })

  test('a message and a tool call are drawn as the plugin\'s own command output, never announced', async () => {
    const view = live()
    view.upsert(item('First', { id: 'a' }))
    const message = await view.nextRow()
    // The command row is what the person sees, so nothing about a message is announced separately.
    expect(message?.commandItem).toBe('a')
    expect(message?.announcement).toBeUndefined()
    view.commit(message!)
    // The same content again produces nothing.
    expect(await view.nextRow()).toBeUndefined()
    // Changing it corrects Claude's row without drawing another command row.
    view.upsert(item('Changed', { id: 'a' }))
    const correction = await view.nextRow()
    expect(correction?.text).toContain('(item a)')
    expect(correction?.text).toContain('Changed')
    expect(correction?.commandItem).toBeUndefined()
    expect(correction?.announcement).toBeUndefined()
    // A tool call is drawn the same way, as one line, when it completes live.
    view.upsert(item('', { id: 't', kind: 'tool_call', content: { name: 'Bash', status: 'completed', rawInput: { command: 'ls' } } }))
    const tool = await view.nextRow()
    expect(tool?.commandItem).toBe('t')
    expect(tool?.announcement).toBeUndefined()
  })

  test('an uncommitted row is offered again by the next snapshot', async () => {
    const view = live()
    view.upsert(item('Refused once', { id: 'a' }))
    expect(await view.nextRow()).toBeDefined()
    view.reset()
    view.upsert(item('Refused once', { id: 'a' }))
    view.endSnapshot()
    expectModelRows(await texts(view), ['a'], ['Refused once'])
  })
})

describe('comments', () => {
  test('a comment row names its authors and carries the lines it was made on, in the shape Delta agents read', () => {
    const row = renderComment(comment('Rename <these> & move them.', {
      co_authors: [{ user_id: 'b', name: 'Bob' }], target: fileTarget,
    }), fileTarget, 'thread')!
    expect(row.split('\n')[0]).toBe('[Delta] Ada, Bob, comment (comment c1):')
    for (const part of [
      '<file>src/main.rs</file>', '<context>\n4 + let one = 1;\n5 + let two = 2;\n9 - gone();\n  </context>',
      '<selected>one = 1;</selected>', '<comment from="Ada, Bob">Rename &lt;these&gt; &amp; move them.</comment>',
    ]) expect(row).toContain(part)
    expect(renderComment(comment('   '), null, 'thread')).toBeUndefined()
  })

  test('a reply carries its chain\'s target and the comment it answers; a routed comment says where it went', () => {
    const quote: WatchCommentTarget = { kind: 'transcript', item_id: 'answer', quote: 'use a <map>' }
    const root = comment('who is you?')
    const reply = renderComment(comment('I meant you.', { id: 'c2', chain: 'c1', after_id: 'c1', target: null,
      agent: true, author: { user_id: null, name: 'gpt' } }), quote, 'thread', false, root)!
    expect(reply).toContain('gpt, reply to a comment (comment c2):')
    expect(reply).toContain('<context><quote>use a &lt;map&gt;</quote></context>\n' +
      '  <comment from="Ada">who is you?</comment>\n  <comment from="gpt">I meant you.</comment>\n</comments>')
    const routed = renderComment(comment('Look into it.', { routed_to: 'thread_child' }), quote, 'thread')!
    expect(routed).toContain('It was sent to the Delta subthread thread_child, not to you.')
  })

  test('a heading says what was commented on, or whom a reply answers', () => {
    const root = comment('Why?', { co_authors: [{ user_id: 'b', name: 'Bob' }] })
    const reply = comment('x', { id: 'c2', chain: 'c1', after_id: 'c1' })
    expect(commentAction(root, undefined, fileTarget)).toBe('commented on src/main.rs:4–9')
    expect(commentAction(root, undefined, root.target)).toBe('commented on')
    expect(commentAction(root, undefined, null)).toBe('commented')
    // A reply names the parent's creator alone, and only says it replied when the parent is gone.
    expect(commentAction(reply, root, root.target)).toBe('replied to Ada')
    expect(commentAction(reply, undefined, root.target)).toBe('replied')
    expect(commentDisplay(comment('First.\n\nSecond.'), undefined, fileTarget, 'thread'))
      .toBe('Ada commented on src/main.rs:4–9:\nFirst.\nSecond.')
  })

  test('quoted context is one elided line: the passage in its line, a parent\'s first line, or a file\'s first lines', () => {
    const answer = item('Hey! What can I help you with?\nAnything else?', { id: 'answer', kind: 'agent_message' })
    const items = new Map([['answer', answer]])
    const on = (quote: string, item_id: string | null = 'answer'): WatchCommentTarget => ({ kind: 'transcript', item_id, quote })
    // A short passage is shown in the line it sits in, which is what makes `you` mean something.
    expect(commentQuote(comment('who?'), undefined, on('you'), items, 80))
      .toEqual([quoted('Hey! What can I help ', 'you', ' with?')])
    // A narrow line keeps the passage and gives the rest out at both ends.
    expect(commentQuote(comment('who?'), undefined, on('you'), items, 13))
      .toEqual([quoted('…elp ', 'you', ' wit…')])
    // Without the message, as for Claude's own output, the passage alone; a long one is cut.
    expect(commentQuote(comment('who?'), undefined, on('you', null), items, 80)).toEqual([quoted('', 'you', '')])
    // A passage longer than the line is left for the terminal to cut.
    expect(commentQuote(comment('who?'), undefined, on('a much longer passage than fits', null), items, 10))
      .toEqual([quoted('', 'a much longer passage than fits', '')])
    expect(commentQuote(comment('who?'), undefined, on('two\nlines', null), items, 80)).toEqual([quoted('', 'two …', '')])
    // A reply quotes its parent's first line, however long the chain, not the chain's passage.
    const root = comment('who is you?\n\nreally', { target: on('you') })
    const reply = comment('me', { id: 'c2', chain: 'c1', after_id: 'c1', target: null })
    expect(commentQuote(reply, root, on('you'), items, 80))
      .toEqual([{ before: '', marked: 'who is you? …', after: '', emphasis: false }])
    expect(commentQuote(reply, undefined, on('you'), items, 80)).toEqual([quoted('Hey! What can I help ', 'you', ' with?')])
    // A file comment quotes its first lines and says more were left out.
    expect(commentQuote(comment('x'), undefined, fileTarget, items, 80).map((line) => line.marked))
      .toEqual(['4 + let one = 1;', '5 + let two = 2;', '…'])
  })

  test('the fingerprint follows what Claude read, not who it resolved to, its message, or its passage\'s item', async () => {
    const original = comment('Why?')
    const resolved = { ...original, author: { user_id: 'other', name: 'Ada L.' }, delivered_with: 'moved' }
    expect(await commentFingerprint(resolved, null)).toBe(await commentFingerprint(original, null))
    const inItem: WatchCommentTarget = { kind: 'transcript', item_id: 'answer', quote: 'the parser' }
    expect(await commentFingerprint(original, inItem)).toBe(await commentFingerprint(original, original.target))
    expect(await commentFingerprint({ ...original, text: 'Why not?' }, null)).not.toBe(await commentFingerprint(original, null))
  })

  test('a comment-only send yields only its comments\' rows, each drawn under the comment\'s key', async () => {
    const view = live()
    view.upsert(item('', { id: 'm' }))
    view.upsertComment(comment('Why this?', { delivered_with: 'm' }))
    view.upsertComment(comment('And this.', { id: 'c2', chain: 'c2', delivered_with: 'm', target: fileTarget }))
    const offered = await rows(view)
    expect(offered.map((row) => row.id)).toEqual([commentKey('c1'), commentKey('c2')])
    expect(offered.map((row) => row.commandItem)).toEqual([commentKey('c1'), commentKey('c2')])
    expect(offered[1]?.text).toContain('<file>src/main.rs</file>')
    expect(Object.keys(view.ledger.items)).toEqual([commentKey('c1'), commentKey('c2')])
  })

  test('a shown comment that changes or is withdrawn gets a correction; one never shown gets nothing', async () => {
    const view = live()
    view.upsertComment(comment('Why?'))
    await rows(view)
    view.upsertComment(comment('Why?', { author: { user_id: 'resolved', name: 'Ada' } }))
    expect(await rows(view)).toEqual([])
    view.upsertComment(comment('Why, exactly?'))
    const [edit] = await rows(view)
    expect(edit?.text).toContain('Ada changed an earlier comment (comment c1); it now reads:')
    expect(edit?.commandItem).toBeUndefined()
    view.removeComment('c1')
    expect(view.wasRemoved(commentKey('c1'))).toBe(true)
    expect((await texts(view))).toEqual(['[Delta] An earlier comment (comment c1) from Ada was withdrawn from the shared thread; disregard it.'])
    expect(view.ledger.items).toEqual({})
    view.removeComment('never-shown')
    expect(await rows(view)).toEqual([])
  })

  test('a snapshot draws only its newest comments after one notice, and a restart repeats none', async () => {
    const view = new RemoteView('thread', { thread: 'thread', items: {} })
    view.upsert(item('Look at these.', { id: 'm' }))
    for (let index = 0; index < SNAPSHOT_TAIL + 2; index++)
      view.upsertComment(comment(`Comment ${index}`, { id: `c${index}`, chain: `c${index}` }))
    view.endSnapshot()
    const offered = await rows(view)
    expect(offered).toHaveLength(SNAPSHOT_TAIL + 3)
    expect(offered.filter((row) => row.commandItem).map((row) => row.id))
      .toEqual(Array.from({ length: SNAPSHOT_TAIL }, (_, index) => commentKey(`c${index + 2}`)))
    expect(offered.filter((row) => row.announcement).map((row) => row.announcement))
      .toEqual([earlierItemsNotice(3, 'thread')])

    // A restart's snapshot adds nothing again, and withdraws what went away meanwhile.
    const restarted = new RemoteView('thread', JSON.parse(JSON.stringify(view.ledger)) as Ledger)
    restarted.reset()
    restarted.upsert(item('Look at these.', { id: 'm' }))
    for (let index = 1; index < SNAPSHOT_TAIL + 2; index++)
      restarted.upsertComment(comment(`Comment ${index}`, { id: `c${index}`, chain: `c${index}` }))
    restarted.endSnapshot()
    expect(await texts(restarted)).toEqual(['[Delta] An earlier comment (comment c0) was withdrawn from the shared thread; disregard it.'])
  })
})

describe('adding rows', () => {
  test('added rows are recorded, saved and drawn, and the snapshot count is not announced', async () => {
    const view = new RemoteView('thread', { thread: 'thread', items: {} })
    view.upsert(item('first', { id: 'a' }))
    view.upsert(item('second', { id: 'b' }))
    view.endSnapshot()
    const sink = fakeSink()
    await addRows(view, sink)
    expectModelRows(sink.appended, ['a', 'b'], ['first', 'second'])
    expect(sink.drawn).toEqual(['a', 'b'])
    expect(Object.keys(sink.saved.at(-1)!.items)).toEqual(['a', 'b'])
    // How many earlier items Claude received is status: it goes to the debug log, not the transcript.
    expect(sink.announced).toEqual([])
    view.upsert(item('', { id: 'c', kind: 'tool_call', content: { name: 'Read', status: 'completed', rawInput: { file_path: 'a.ts' } } }))
    await addRows(view, sink)
    expect(sink.drawn).toEqual(['a', 'b', 'c'])
    expect(sink.announced).toEqual([])
    expect(Object.keys(sink.saved.at(-1)!.items)).toEqual(['a', 'b', 'c'])
    expect(sink.failures).toEqual([])
  })

  test('a long snapshot reaches Claude whole, but only its newest items are drawn, after a notice', async () => {
    const view = new RemoteView('thread', { thread: 'thread', items: {} })
    const count = SNAPSHOT_TAIL + 7
    for (let index = 0; index < count; index++) view.upsert(item(`item ${index}`, { id: `i${index}` }))
    view.upsert(item('reasoning', { id: 'thought', kind: 'agent_thought' }))
    // Nothing is added while the snapshot arrives, since its newest items are not known yet.
    const sink = fakeSink()
    await addRows(view, sink)
    expect(sink.appended).toEqual([])
    view.endSnapshot()
    await addRows(view, sink)
    expect(sink.appended).toHaveLength(count)
    const ids = Array.from({ length: count }, (_, index) => `i${index}`)
    expect(sink.drawn).toEqual(ids.slice(-SNAPSHOT_TAIL))
    expect(sink.announced).toEqual([earlierItemsNotice(7, 'thread')])
    expect(sink.announced[0]).toContain('delta thread show thread')
    // Live items are drawn as ever, and a reconnect snapshot draws nothing Claude already has.
    view.upsert(item('live', { id: 'live' }))
    await addRows(view, sink)
    expect(sink.drawn.at(-1)).toBe('live')
    view.reset()
    for (const id of [...ids, 'live']) view.upsert(view.ledger.items[id] ? item(id === 'live' ? 'live' : `item ${id.slice(1)}`, { id }) : item(id, { id }))
    view.endSnapshot()
    const drawn = sink.drawn.length
    await addRows(view, sink)
    expect(sink.drawn).toHaveLength(drawn)
    expect(sink.announced).toHaveLength(1)
  })

  test('a short snapshot is drawn whole, with no notice', async () => {
    const view = new RemoteView('thread', { thread: 'thread', items: {} })
    for (let index = 0; index < SNAPSHOT_TAIL; index++) view.upsert(item(`item ${index}`, { id: `i${index}` }))
    view.endSnapshot()
    const sink = fakeSink()
    await addRows(view, sink)
    expect(sink.drawn).toHaveLength(SNAPSHOT_TAIL)
    expect(sink.announced).toEqual([])
  })

  test('a snapshot past the budget gives Claude its newest rows, after one row standing in for the rest', async () => {
    const text = 'x'.repeat(100)
    // Agent messages, since the thread's opening request would be kept.
    const size = renderItem(item(text, { id: 'i0', kind: 'agent_message' }), 'thread')!.length
    const view = new RemoteView('thread', { thread: 'thread', items: {} }, size * 3)
    const ids = Array.from({ length: 10 }, (_, index) => `i${index}`)
    for (const id of ids) view.upsert(item(text, { id, kind: 'agent_message' }))
    view.endSnapshot()
    const sink = fakeSink()
    await addRows(view, sink)
    expect(sink.appended[0]).toBe(omittedItemsRow(7, 'thread'))
    expect(sink.appended[0]).toContain('delta thread show thread')
    expectModelRows(sink.appended.slice(1), ids.slice(7))
    expect(sink.drawn).toEqual(ids.slice(7))
    expect(sink.announced).toEqual([earlierItemsNotice(7, 'thread', 7)])
    expect(sink.saved.at(-1)!.items).toMatchObject(Object.fromEntries(ids.slice(0, 7).map((id) => [id, OMITTED])))
    expect(Object.keys(sink.saved.at(-1)!.items)).toEqual(ids)

    // Claude never read an omitted item, so its edit or removal corrects nothing.
    view.upsert(item('changed', { id: 'i0', kind: 'agent_message' }))
    view.remove('i1')
    await addRows(view, sink)
    expect(sink.appended).toHaveLength(4)
    expect(view.ledger.items.i1).toBeUndefined()
    // A reconnect repeats neither the rows nor the stand-in.
    view.reset()
    for (const id of ids.filter((id) => id !== 'i1')) view.upsert(item(id === 'i0' ? 'changed' : text, { id, kind: 'agent_message' }))
    view.endSnapshot()
    await addRows(view, sink)
    expect(sink.appended).toHaveLength(4)
    expect(sink.announced).toHaveLength(1)
  })

  test('the newest row always reaches Claude, and a refused stand-in leaves the rest for the next snapshot', async () => {
    const view = new RemoteView('thread', { thread: 'thread', items: {} }, 1)
    for (const id of ['a', 'b']) view.upsert(item(id, { id, kind: 'agent_message' }))
    view.endSnapshot()
    const refusing = fakeSink()
    refusing.append = async (row) => row.omits ? { deny: 'policy' } : (refusing.appended.push(row.text), {})
    await addRows(view, refusing)
    expectModelRows(refusing.appended, ['b'])
    expect(view.ledger.items.a).toBeUndefined()
    view.reset()
    for (const id of ['a', 'b']) view.upsert(item(id, { id, kind: 'agent_message' }))
    view.endSnapshot()
    // Claude already has `b`, so `a` is now the newest row it lacks, and reaches it whole.
    const sink = fakeSink()
    await addRows(view, sink)
    expectModelRows(sink.appended, ['a'])
    expect(view.ledger.items.a).not.toBe(OMITTED)
  })

  test('older rows past the budget are summarized, each run of tool calls as one row, and the newest stay whole', async () => {
    const output = 'o'.repeat(5_000)
    const view = new RemoteView('thread', { thread: 'thread', items: {} }, 1_000)
    view.upsert(item('Rename the flag.', { id: 'u0' }))
    view.upsert(call('t1', 'execute', { title: 'Terminal', name: 'Bash', status: 'failed', rawInput: { command: 'npm test' } }))
    view.upsert(call('t2', 'read', { title: 'Read src/a.ts', rawInput: { file_path: '/repo/src/a.ts' } }))
    view.upsert(call('t3', 'edit', { title: 'Edit', rawInput: { file_path: '/repo/src/a.ts' }, rawOutput: output }))
    view.upsert(call('t4', 'edit', { title: 'Edit', content: [{ type: 'diff', path: '/repo/src/b.ts', newText: output }] }))
    view.upsert(item('Renamed it.', { id: 'm5', kind: 'agent_message', author: { user_id: null, name: 'Claude' } }))
    view.upsert(item('Tests pass now.', { id: 'm6', kind: 'agent_message', author: { user_id: null, name: 'Claude' } }))
    view.endSnapshot()
    const sink = fakeSink()
    await addRows(view, sink)
    expect(sink.appended).toHaveLength(4)
    expectModelRows([sink.appended[0]!], ['u0'], ['Rename the flag.'])
    expect(sink.appended[1]).toBe('[Delta] Claude, 4 tool calls, summarized to save room:\n' +
      'ran 1 command, read 1 file; edited /repo/src/a.ts, /repo/src/b.ts; 1 failed: Terminal · npm test')
    expectModelRows(sink.appended.slice(2), ['m5', 'm6'])
    // A summarized call is never drawn or corrected on its own.
    expect(sink.drawn).toEqual(['u0', 'm5', 'm6'])
    expect(sink.saved.at(-1)!.items).toMatchObject({ t1: OMITTED, t2: OMITTED, t3: OMITTED, t4: OMITTED })
    view.upsert(call('t3', 'edit', { title: 'Edit', rawOutput: 'changed' }))
    await addRows(view, sink)
    expect(sink.appended).toHaveLength(4)
  })

  test('a run of tool calls breaks where its author changes, and names only the first few of many', async () => {
    const calls = Array.from({ length: 10 }, (_, index) => call(`e${index}`, 'edit', { title: 'Edit', rawInput: { path: `f${index}.ts` } }))
    expect(toolRunRow(calls)).toContain('edited f0.ts, f1.ts, f2.ts, f3.ts, f4.ts, f5.ts, f6.ts, f7.ts and 2 more')
    expect(toolRunRow([call('x', 'think', {})])).toContain('called 1 other tool')
    const view = new RemoteView('thread', { thread: 'thread', items: {} }, 600)
    view.upsert(call('c1', 'execute', { rawInput: { command: 'ls' }, rawOutput: 'o'.repeat(5_000) }))
    view.upsert(call('c2', 'execute', { rawInput: { command: 'ls' }, rawOutput: 'o'.repeat(5_000) }, 'Ada'))
    view.upsert(item('done', { id: 'last', kind: 'agent_message' }))
    view.endSnapshot()
    const added = await rows(view)
    expect(added.map((row) => row.id)).toEqual(['delta:tools:c1', 'delta:tools:c2', 'last'])
    expect(added[0]!.text).toContain('Claude, 1 tool call, summarized')
    expect(added[1]!.text).toContain('Ada, 1 tool call, summarized')
  })

  test('past the limit, the thread\'s opening request is kept before the row standing in for the rest', async () => {
    const text = 'x'.repeat(100)
    const size = renderItem(item(text, { id: 'a1', kind: 'agent_message' }), 'thread')!.length
    const view = new RemoteView('thread', { thread: 'thread', items: {} }, size * 3, size * 4)
    const ids = Array.from({ length: 9 }, (_, index) => `a${index + 1}`)
    view.upsert(item(text, { id: 'u0' }))
    for (const id of ids) view.upsert(item(text, { id, kind: 'agent_message' }))
    view.endSnapshot()
    const sink = fakeSink()
    await addRows(view, sink)
    expectModelRows([sink.appended[0]!], ['u0'])
    // The request takes the room the newest of the summary would have had.
    expect(sink.appended[1]).toBe(omittedItemsRow(6, 'thread'))
    expectModelRows(sink.appended.slice(2), ['a7', 'a8', 'a9'])
  })

  test('a view that may compact adds the summary past the limit in rounds, compacting after each, then the rest of it and the newest whole', async () => {
    const { view, ids } = longThread()
    const compactions: number[] = []
    const sink = fakeSink({ async compact(instructions) {
      expect(instructions).toContain("opening request")
      compactions.push(sink.appended.length)
      return true
    } })
    await addRows(view, sink)
    expectModelRows(sink.appended, ids)
    // The summary within the limit, `a6`, is added after the last compaction, as it is.
    expect(compactions).toEqual([2, 4, 6])
    // The ledger is saved before each compaction, so a restart repeats nothing compacted.
    expect(Object.keys(sink.saved[0]!.items)).toEqual(ids.slice(0, 2))
    expect(view.settled).toBe(true)
  })

  test('a failed compaction leaves the older history not added yet out, behind one row', async () => {
    const { view, ids } = longThread()
    const sink = fakeSink({ compact: async () => false })
    await addRows(view, sink)
    expectModelRows(sink.appended.slice(0, 2), ids.slice(0, 2))
    expect(sink.appended[2]).toBe(omittedItemsRow(4, 'thread'))
    expectModelRows(sink.appended.slice(3), ids.slice(6))
    expect(sink.saved.at(-1)!.items).toMatchObject(Object.fromEntries(ids.slice(2, 6).map((id) => [id, OMITTED])))
  })

  test('a compaction a turn interrupts waits for the rows to resume', async () => {
    const { view, ids } = longThread()
    let held = false
    let tries = 0
    const sink = fakeSink({
      held: () => held,
      async compact() { tries++; if (tries === 1) { held = true; return false } return true },
    })
    await addRows(view, sink)
    expect(sink.appended).toHaveLength(2)
    expect(view.compactionDue).toBe(true)
    held = false
    await addRows(view, sink)
    expectModelRows(sink.appended, ids)
    expect(tries).toBe(4)
  })

  test('the snapshot budget and limit are shares of the model\'s window, and one compaction reads at most a set amount', () => {
    expect(snapshotBudget(undefined)).toBe(400_000)
    expect(snapshotBudget(200_000)).toBe(180_000)
    expect(snapshotBudget(1_000_000)).toBe(450_000)
    expect(snapshotBudget(10_000)).toBe(60_000)
    expect(snapshotLimit(undefined)).toBe(666_666)
    expect(snapshotLimit(200_000)).toBe(300_000)
    expect(snapshotLimit(1_000_000)).toBe(1_500_000)
    // A small window's floor for the newest rows leaves no room for a summary.
    expect(snapshotLimit(10_000)).toBe(60_000)
    expect(compactionRound(100_000)).toBe(150_000)
    expect(compactionRound(200_000)).toBe(300_000)
    expect(compactionRound(1_000_000)).toBe(300_000)
  })

  test('the person\'s notice says how many undrawn items are not in Claude\'s context either', () => {
    expect(earlierItemsNotice(3, 'thread')).toContain('3 earlier items are in Claude\'s context but not shown here')
    expect(earlierItemsNotice(3, 'thread', 2)).toContain('and 2 of them are not in Claude\'s context either')
    expect(earlierItemsNotice(1, 'thread', 1)).toContain('1 earlier item is not shown here or in Claude\'s context')
  })

  test('a large batch saves as it goes, and a stop mid-row still saves the rows added', async () => {
    const view = live()
    for (let index = 0; index < 45; index++) view.upsert(item(`item ${index}`, { id: `i${index}` }))
    const sink = fakeSink()
    await addRows(view, sink)
    expect(sink.saved.map((ledger) => Object.keys(ledger.items).length)).toEqual([LEDGER_SAVE_INTERVAL, 2 * LEDGER_SAVE_INTERVAL, 45])

    const stopping = live()
    for (const id of ['x', 'y', 'z']) stopping.upsert(item(id, { id }))
    let current = true
    const stopped = fakeSink({ current: () => current })
    stopped.append = async (row) => {
      stopped.appended.push(row.text)
      current = false
      return {}
    }
    await addRows(stopping, stopped)
    expect(stopped.appended).toHaveLength(1)
    expect(stopped.saved.map((ledger) => Object.keys(ledger.items))).toEqual([['x']])
    // A message row is the person-visible drawing, so a stopped watch announces nothing more.
    expect(stopped.announced).toEqual([])
  })

  test('held rows wait, then a released row is drawn in order; failed rows are reported and left for the next snapshot', async () => {
    const view = live()
    view.upsert(item('waiting', { id: 'a' }))
    let holding = true
    const held = fakeSink({ held: () => holding })
    await addRows(view, held)
    expect(held.appended).toEqual([])
    expect(held.drawn).toEqual([])
    // The same view adds the waiting row once the hold lifts.
    holding = false
    await addRows(view, held)
    expectModelRows(held.appended, ['a'], ['waiting'])
    expect(held.drawn).toEqual(['a'])
    const refusing = fakeSink()
    refusing.append = async () => ({ deny: 'policy' })
    const blocked = live()
    blocked.upsert(item('refused', { id: 'b' }))
    await addRows(blocked, refusing)
    expect(refusing.failures).toHaveLength(1)
    expect(refusing.failures[0]).toContain('policy')
    expect(refusing.saved).toEqual([])
    expect(blocked.ledger.items).toEqual({})
  })
})

function fakeSink(overrides: Partial<RowSink> = {}) {
  const sink = {
    appended: [] as string[], drawn: [] as string[], saved: [] as Ledger[], announced: [] as string[], failures: [] as string[],
    async append(row: PendingRow) {
      sink.appended.push(row.text)
      if (row.commandItem !== undefined) sink.drawn.push(row.commandItem)
      return {} as { deny?: string }
    },
    async save(ledger: Ledger) { sink.saved.push(structuredClone(ledger)) },
    held: () => false,
    current: () => true,
    announce(text: string) { sink.announced.push(text) },
    debug() {},
    fail(reason: string) { sink.failures.push(reason) },
    ...overrides,
  }
  return sink
}

/** A view whose first snapshot is complete. */
function live(): RemoteView {
  const view = new RemoteView('thread', { thread: 'thread', items: {} })
  view.endSnapshot()
  return view
}

/** Every row the view needs now, each committed as if added; fingerprints omitted. */
async function rows(view: RemoteView) {
  const result = []
  for (let row = await view.nextRow(); row; row = await view.nextRow()) {
    view.commit(row)
    const { fingerprint: _, ...shown } = row
    result.push(Object.fromEntries(Object.entries(shown).filter(([, value]) => value !== undefined)))
  }
  return result
}

async function texts(view: RemoteView) {
  return (await rows(view)).map((row) => row.text)
}

function item(text: string, fields: Partial<WatchItem> = {}): WatchItem {
  return {
    id: 'item-1', kind: 'user_message', after_id: null, turn_id: null, author: { user_id: 'u', name: 'Ada' },
    created_at: 1, open: false, content: { text }, ...fields,
  }
}

/** Ten agent messages past a budget of three and a limit of four, in a view that compacts every two of its older ones. */
function longThread() {
  const text = 'x'.repeat(100)
  const size = renderItem(item(text, { id: 'a0', kind: 'agent_message' }), 'thread')!.length
  const view = new RemoteView('thread', { thread: 'thread', items: {} }, size * 3, size * 4, size * 2.5)
  const ids = Array.from({ length: 10 }, (_, index) => `a${index}`)
  for (const id of ids) view.upsert(item(text, { id, kind: 'agent_message' }))
  view.endSnapshot()
  return { view, ids }
}

function call(id: string, kind: string, content: Record<string, unknown>, author = 'Claude'): WatchItem {
  return item('', { id, kind: 'tool_call', author: { user_id: null, name: author }, content: { toolCallId: id, kind, status: 'completed', ...content } })
}

function expectModelRows(actual: string[], ids: string[], contents: string[] = []) {
  expect(actual).toHaveLength(ids.length)
  ids.forEach((id, index) => expect(actual[index]).toContain(`(item ${id})`))
  contents.forEach((text, index) => expect(actual[index]).toContain(text))
}

const fileTarget: WatchCommentTarget = {
  kind: 'file', worktree: 'history#t=timeline', path: 'src/main.rs', view: 'diff', selected: 'one = 1;',
  regions: [
    { first_line: 4, last_line: 5, status: 'added', text: 'let one = 1;\nlet two = 2;' },
    { first_line: 9, last_line: 9, status: 'deleted', text: 'gone();' },
  ],
}

function comment(text: string, fields: Partial<WatchComment> = {}): WatchComment {
  return {
    id: 'c1', chain: 'c1', after_id: null, delivered_with: 'm', routed_to: null, author: { user_id: 'u', name: 'Ada' },
    co_authors: [], agent: false, created_at: 1, text, target: { kind: 'transcript', item_id: null, quote: 'the parser' },
    ...fields,
  }
}

function quoted(before: string, marked: string, after: string): QuotedLine {
  return { before, marked, after, emphasis: true }
}
