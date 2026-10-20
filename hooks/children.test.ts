import { describe, expect, test as kitTest, tier, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { CHECKOUT, MOUNTS, childActor, fakeThreads, prompt, remoteItem, sessionStart, testsWithHeldClockWait, turnComplete, turnStart } from './fake-thread-commands'

tier('user')

const test = testsWithHeldClockWait(kitTest)

describe('subagents', () => {
  test('a subagent is its own child thread, prompted by its parent, with turns of its own', async ($, on) => {
    const fake = await sharedSession($, on)
    await mainTurn($, 'main')
    const agentId = await spawn($)
    await $.session.append(childPrompt(agentId))
    await fake.clock.settle()
    // Its first turn says whose checkout it works in, so its thread waits for that turn.
    expect(fake.server.subagents.has(agentId)).toBe(false)
    await $.turn.start({ ...turnStart('child-turn', 'Inspect the parser'), agentId } as never)
    await $.session.append({ agentId, door: 'response', uuid: 'child-answer', message: {
      type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Parser looks fine' }] } } as never)
    await $.turn.complete({ ...turnComplete('child-turn'), agentId } as never)
    await fake.clock.settle()

    // Working in the session's checkout, its thread shares the session's worktree.
    expect(fake.server.subagents.get(agentId)).toMatchObject({
      parent: fake.threadId, name: 'Inspect the parser', sharedWorktrees: true,
    })
    expect(fake.server.subagents.get(agentId)?.detached).toBeUndefined()
    const records = fake.childRecords(agentId)
    expect(records.map((record) => [record.update?.sessionUpdate, record.update?.state, record.turnSequence])).toEqual([
      ['state_update', 'running', 1], ['user_message', undefined, 1], ['agent_message', undefined, 1],
      ['state_update', 'idle', 1],
    ])
    // The parent's agent sent the prompt; the child's own output is only on the child's thread.
    expect(records[1]!.update?._meta?.delta?.sender).toEqual({ external_id: fake.session })
    expect(JSON.stringify(fake.records())).not.toContain('Parser looks fine')
    fake.expectClean()
  })

  test("a subagent's hooks that run before its spawn resolves are recorded once it does", async ($, on) => {
    const fake = await sharedSession($, on)
    await mainTurn($, 'main')
    let release!: () => void
    fake.holdSpawn = new Promise<void>((resolve) => { release = resolve })
    const spawned = $.agent.spawn(spawnInput() as never)
    await fake.clock.settle()
    // The host names the agent only after its first turn already started.
    await $.turn.start({ ...turnStart('early-turn', 'Inspect the parser'), agentId: 'agent1' } as never)
    await $.session.append(childPrompt('agent1'))
    release()
    await spawned
    await $.turn.complete({ ...turnComplete('early-turn'), agentId: 'agent1' } as never)
    await fake.clock.settle()
    expect(fake.childRecords('agent1').map((record) => record.update?.sessionUpdate))
      .toEqual(['state_update', 'user_message', 'state_update'])
    fake.expectClean()
  })

  test('a prompt that arrives while its resolved spawn is still being registered is recorded', async ($, on) => {
    const fake = await sharedSession($, on)
    await mainTurn($, 'main')
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    fake.holdStoreGet = (key) => key.startsWith('child:') ? held : undefined
    const spawned = $.agent.spawn(spawnInput() as never)
    await fake.clock.settle()
    await $.session.append(childPrompt('agent1'))
    fake.holdStoreGet = undefined
    release()
    await spawned
    await $.turn.start({ ...turnStart('late-turn', 'Inspect the parser'), agentId: 'agent1' } as never)
    await $.turn.complete({ ...turnComplete('late-turn'), agentId: 'agent1' } as never)
    await fake.clock.settle()
    expect(fake.childRecords('agent1').map((record) => record.update?.sessionUpdate))
      .toEqual(['state_update', 'user_message', 'state_update'])
    fake.expectClean()
  })

  test('a Delta that cannot record subagents leaves them to Claude', async ($, on) => {
    const fake = fakeThreads(on)
    fake.contractRange = { min: 1, max: 6 }
    await $.session.start(sessionStart)
    await fake.share($)
    await mainTurn($, 'main')
    const agentId = await spawn($)
    await childRun($, agentId, 'child-turn', 'Parser looks fine')
    await fake.clock.settle()
    expect(fake.server.subagents.size).toBe(0)
    fake.expectClean()
  })

  test('forks and teammates are not recorded, nor is anything their own agents spawn', async ($, on) => {
    const fake = await sharedSession($, on)
    await mainTurn($, 'main')
    const fork = await spawn($, { fork: true })
    const teammate = await spawn($, { isTeammate: true })
    const grandchild = await spawn($, { parentAgentId: teammate })
    for (const agentId of [fork, teammate, grandchild]) await childRun($, agentId, `${agentId}-turn`, 'done')
    await fake.clock.settle()
    expect(fake.server.subagents.size).toBe(0)
    expect(fake.operations().filter((operation) => operation === 'create')).toHaveLength(1)
    fake.expectClean()
  })

  test('a subagent in a worktree of its own records that checkout until its run ends', async ($, on) => {
    const fake = await sharedSession($, on)
    await mainTurn($, 'main')
    const agentId = await spawn($)
    const worktree = `${CHECKOUT}/.claude/worktrees/agent-${agentId}`
    fake.cwd = worktree
    await childRun($, agentId, 'isolated-turn', 'Edited in the worktree')
    fake.cwd = CHECKOUT
    // Claude may remove the worktree once the run's completion hook returns, so it is detached by then.
    const child = fake.server.subagents.get(agentId)!
    expect(child.sharedWorktrees).toBe(false)
    expect(child.detached?.directory).toBe(worktree)
    expect(child.checkout).toBeUndefined()
    await fake.clock.settle()
    // The session's own checkout stays attached to the session's thread.
    expect(fake.server.mount?.directory).toBe(CHECKOUT)
    fake.expectClean()
  })

  test('an isolated subagent works in a fork of its parent\'s worktrees in Delta, released when Claude removes it', async ($, on) => {
    const fake = await sharedSession($, on)
    await mainTurn($, 'main')
    // Claude asks for the subagent's isolated worktree while its spawn is in flight.
    let release!: () => void
    fake.holdSpawn = new Promise<void>((resolve) => { release = resolve })
    const spawning = $.agent.spawn(spawnInput({ description: 'Fix the lexer' }) as never) as Promise<{ agentId: string }>
    await fake.clock.settle()
    const created = await $.classic.WorktreeCreate({
      session_id: fake.session, cwd: CHECKOUT, hook_event_name: 'WorktreeCreate', name: 'agent-agent1',
    } as never) as { worktreePath?: string }
    release()
    const { agentId } = await spawning
    const child = fake.server.subagents.get(agentId)!
    expect(child).toMatchObject({ isolatedWorktrees: true, sharedWorktrees: false, name: 'Fix the lexer' })
    expect(created.worktreePath).toBe(`${MOUNTS}/${child.mountedFor}`)

    // It records as any subagent does, and Claude's checkout is never attached to its thread.
    fake.cwd = created.worktreePath!
    await childRun($, agentId, 'forked-turn', 'Fixed the lexer')
    fake.cwd = CHECKOUT
    await fake.clock.settle()
    expect(fake.childRecords(agentId).map((record) => record.update?.state ?? record.update?.content?.[0]?.text))
      .toEqual(['running', 'Inspect the parser', 'Fixed the lexer', 'idle'])
    expect(child.checkout ?? child.detached).toBeUndefined()
    // Its fork has no git branch here, so the parent is told how to merge it.
    await $.turn.complete(turnComplete('main'))
    await fake.clock.settle()
    expect(notes(fake).at(-1)).toContain(`thread merge ${child.reference} --into ${fake.threadId}`)

    // Claude removing the worktree releases Delta's checkout; the fork stays in the thread.
    await $.classic.WorktreeRemove({
      session_id: fake.session, cwd: CHECKOUT, hook_event_name: 'WorktreeRemove', worktree_path: created.worktreePath,
    } as never)
    expect(child.mountedFor).toBeUndefined()
    fake.expectClean()
  })

  test("a nested subagent's thread is under its parent subagent's, which prompts it, and shares that parent's checkout", async ($, on) => {
    const fake = await sharedSession($, on)
    await mainTurn($, 'main')
    const parent = await spawn($)
    const worktree = `${CHECKOUT}/.claude/worktrees/agent-${parent}`
    fake.cwd = worktree
    await $.session.append(childPrompt(parent))
    await $.turn.start({ ...turnStart('parent-turn', 'Inspect the parser'), agentId: parent } as never)
    const nested = await spawn($, { parentAgentId: parent, description: 'Check the lexer' })
    await childRun($, nested, 'nested-turn', 'Lexer is fine')
    await fake.clock.settle()
    const parentThread = fake.server.subagents.get(parent)!
    expect(parentThread).toMatchObject({ sharedWorktrees: false, checkout: { directory: worktree } })
    // The nested child works in its parent's worktree, so it attaches no checkout of its own.
    const child = fake.server.subagents.get(nested)!
    expect([child.parent, child.sharedWorktrees, child.checkout, child.detached])
      .toEqual([parentThread.reference, true, undefined, undefined])
    expect(fake.childRecords(nested)[1]!.update?._meta?.delta?.sender).toEqual({ external_id: parent })
    await $.turn.complete({ ...turnComplete('parent-turn'), agentId: parent } as never)
    fake.cwd = CHECKOUT
    await fake.clock.settle()
    fake.expectClean()
  })

  for (const foreground of [false, true]) {
    test(`a ${foreground ? 'foreground' : 'background'} subagent someone takes over in Delta is stopped`, async ($, on) => {
      const fake = await sharedSession($, on)
      await mainTurn($, 'main')
      const agentId = await spawn($, { background: !foreground })
      fake.fenceChildTurns.add(1)
      await $.turn.start({ ...turnStart('fenced-turn', 'Inspect the parser'), agentId } as never)
      await $.session.append(childPrompt(agentId))
      await fake.clock.settle()
      if (foreground) {
        expect(fake.aborts).toEqual(['main'])
        expect(fake.taskStops).toEqual([])
      } else {
        expect(fake.taskStops).toEqual([agentId])
        expect(fake.aborts).toEqual([])
      }
      fake.expectClean()
    })
  }

  test('a subagent queues while Delta is unreachable and is delivered on retry', async ($, on) => {
    const fake = await sharedSession($, on)
    await mainTurn($, 'main')
    fake.childAppendOffline = true
    const agentId = await spawn($)
    await childRun($, agentId, 'offline-turn', 'Queued answer')
    await fake.clock.settle()
    expect(fake.childRecords(agentId)).toEqual([])
    fake.childAppendOffline = false
    await fake.clock.advance(60_000)
    await fake.clock.settle()
    expect(fake.childRecords(agentId)).toHaveLength(4)
    fake.expectClean()
  })

  test('sharing records the subagents that already ran, and a running one once its run ends', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('delegate')] })
    await $.session.start(sessionStart)
    fake.agents = [
      { id: 'earlier', description: 'Read the docs', type: 'general-purpose', status: 'completed' },
      { id: 'running', description: 'Run the tests', type: 'general-purpose', status: 'running' },
      { id: 'mate', description: 'Teammate', type: 'teammate', status: 'idle', teammateId: 'mate@team' } as never,
    ]
    // A finished foreground agent is no longer listed; only its call's result names it.
    fake.summaries = [{ role: 'assistant', text: '', toolUses: [{
      tool_use_id: 'call', tool: 'Agent', input: { description: 'Check the lexer', subagent_type: 'general-purpose' },
      result: { status: 'completed', agentId: 'vanished' },
    }, {
      // Its isolated worktree may already be gone, so its thread neither shares nor attaches one.
      tool_use_id: 'isolated-call', tool: 'Agent',
      input: { description: 'Fix the lexer', subagent_type: 'general-purpose', isolation: 'worktree' },
      result: { status: 'completed', agentId: 'isolated' },
    }, {
      // A worktree Claude kept, because its agent changed something, is attached and detached again.
      tool_use_id: 'kept-call', tool: 'Agent',
      input: { description: 'Rename the lexer', subagent_type: 'general-purpose', isolation: 'worktree' },
      result: { status: 'completed', agentId: 'kept', worktreePath: `${CHECKOUT}/.claude/worktrees/agent-kept` },
    }] }]
    fake.agentMessages.set('kept', [text('Rename the lexer'), answer('Renamed')])
    fake.agentMessages.set('isolated', [text('Fix the lexer'), answer('Lexer fixed')])
    fake.agentMessages.set('earlier', [text('Read the docs'), answer('Docs read')])
    fake.agentMessages.set('running', [text('Run the tests'), answer('Tests pass')])
    fake.agentMessages.set('vanished', [text('Check the lexer'), answer('Lexer is fine')])
    await fake.share($)
    await fake.clock.settle()
    expect([...fake.server.subagents.keys()].sort()).toEqual(['earlier', 'isolated', 'kept', 'running', 'vanished'])
    expect(Object.fromEntries([...fake.server.subagents].map(([id, child]) => [id, child.sharedWorktrees]))).toEqual({
      earlier: true, isolated: false, kept: false, running: true, vanished: true,
    })
    expect(fake.server.subagents.get('isolated')?.detached).toBeUndefined()
    expect(fake.server.subagents.get('kept')?.detached?.directory).toBe(`${CHECKOUT}/.claude/worktrees/agent-kept`)
    expect(fake.server.subagents.get('vanished')?.name).toBe('Check the lexer')
    expect(fake.childRecords('vanished')).toHaveLength(2)
    const earlier = fake.childRecords('earlier')
    expect(earlier.map((record) => [record.update?.sessionUpdate, record.turnSequence])).toEqual([
      ['user_message', undefined], ['agent_message', undefined],
    ])
    expect(earlier[0]!.update?._meta?.delta?.sender).toEqual({ external_id: fake.session })
    // The running agent shows as running at once; its live rows are left to the read of its whole
    // transcript when it ends, which is recorded in that turn.
    const turn = (agentId: string) => fake.childRecords(agentId)
      .map((record) => [record.update?.state ?? record.update?.content?.[0]?.text, record.turnSequence])
    expect(turn('running')).toEqual([['running', 1]])
    await $.session.append({ agentId: 'running', door: 'response', uuid: 'live', message: {
      type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Tests pass' }] } } as never)
    await $.turn.complete({ ...turnComplete('running-turn'), agentId: 'running' } as never)
    await fake.clock.settle()
    expect(turn('running')).toEqual([['running', 1], ['Run the tests', 1], ['Tests pass', 1], ['idle', 1]])
    fake.expectClean()
  })

  test('a subagent running when sharing starts stops when Delta takes it over, and its own checkout reaches Delta', async ($, on) => {
    const fake = fakeThreads(on, { messages: [text('delegate')] })
    await $.session.start(sessionStart)
    fake.agents = [{ id: 'apart', description: 'Fix the lexer', type: 'general-purpose', status: 'running' }]
    fake.summaries = [{ role: 'assistant', text: '', toolUses: [{
      tool_use_id: 'apart-call', tool: 'Agent',
      input: { description: 'Fix the lexer', subagent_type: 'general-purpose', isolation: 'worktree', run_in_background: true },
      result: { status: 'async_launched', agentId: 'apart', description: 'Fix the lexer' },
    }] }]
    fake.agentMessages.set('apart', [text('Fix the lexer'), answer('Lexer fixed')])
    await fake.share($)
    await fake.clock.settle()
    expect(fake.server.subagents.get('apart')?.sharedWorktrees).toBe(false)

    // Someone takes it over in Delta: its running turn is superseded, and Claude stops it.
    fake.supersedeChild('apart')
    await fake.clock.settle()
    expect(fake.taskStops).toEqual(['apart'])

    // Its run ends in its isolated worktree, which is attached before the run's detach.
    const worktree = `${CHECKOUT}/.claude/worktrees/agent-apart`
    fake.cwd = worktree
    await $.turn.complete({ ...turnComplete('apart-turn'), agentId: 'apart' } as never)
    fake.cwd = CHECKOUT
    await fake.clock.settle()
    expect(fake.server.subagents.get('apart')?.detached?.directory).toBe(worktree)
    fake.expectClean()
  })

  test('a restart delivers what a subagent queued and closes the turn it left open', async ($, on) => {
    const fake = await sharedSession($, on)
    await mainTurn($, 'main')
    fake.childAppendOffline = true
    const agentId = await spawn($)
    await $.turn.start({ ...turnStart('interrupted', 'Inspect the parser'), agentId } as never)
    await fake.clock.settle()
    await $.session.end({ reason: 'other', sessionId: fake.session, resume: { id: fake.session } } as never)
    fake.childAppendOffline = false
    await $.session.start(sessionStart)
    await fake.clock.settle()
    expect(fake.childRecords(agentId).map((record) => [record.update?.state, record.update?.stopReason]))
      .toEqual([['running', undefined], ['idle', 'cancelled']])
    fake.expectClean()
  })
})

describe('Delta threads as subagents', () => {
  test('a message to a thread of the conversation runs it here, recorded on that thread, and the parent hears its reply', async ($, on) => {
    const fake = await sharedSession($, on)
    fake.server.worktrees = [{ reference: 'worktree-1#t=1', name: 'repo' }]
    fake.live()!.frame({ type: 'worktrees', worktrees: fake.server.worktrees })
    await mainTurn($, 'main')
    await $.turn.complete(turnComplete('main'))
    fake.server.threads.set('root#s=notes', {
      thread: 'notes-thread', name: 'Release notes', worktrees: [{ reference: 'worktree-1#t=1', name: 'repo' }],
      items: [remoteItem('We should ship release notes', { id: 'ask' })],
    })
    fake.child({ thread_id: 'notes-thread', reference: 'root#s=notes', kind: 'subthread', name: 'Release notes', status: 'inactive' })
    await fake.clock.settle()
    expect(notes(fake).join('\n')).toContain('"Release notes" (inactive)')

    const creates = fake.operations().filter((operation) => operation === 'create').length
    // Claude starts the subagent's turn and stores its prompt before the spawn resolves.
    let release!: () => void
    fake.holdSpawn = new Promise<void>((resolve) => { release = resolve })
    const sending = $.session.send({ to: 'Release notes', text: 'Write RELEASE.md' } as never)
    await fake.clock.settle()
    await $.turn.start({ ...turnStart('notes-turn'), agentId: 'agent1' } as never)
    await $.session.append({ agentId: 'agent1', door: 'prompt', uuid: 'adopted-prompt', message: {
      type: 'user', role: 'user', content: [{ type: 'text', text: 'the history, then Write RELEASE.md' }] } } as never)
    release()
    expect(await sending).toEqual({ isDelivered: true })
    // The plugin ran the thread itself: Claude delivered nothing, and the subagent starts from the
    // thread's history in the session's checkout, whose worktrees the thread shares.
    expect(fake.sends).toEqual([])
    const [run] = fake.spawned
    expect(run!.agentId).toBe('agent1')
    expect(run!.cwd).toBe(CHECKOUT)
    expect(run!.prompt.indexOf('We should ship release notes')).toBeLessThan(run!.prompt.indexOf('Write RELEASE.md'))
    await $.session.append({ agentId: run!.agentId, door: 'response', uuid: 'notes-answer', message: {
      type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Wrote RELEASE.md' }] } } as never)
    fake.agentSummaries.set(run!.agentId, [{ role: 'assistant', text: 'Wrote RELEASE.md', toolUses: [] }])
    await $.turn.complete({ ...turnComplete('notes-turn'), agentId: run!.agentId } as never)
    await fake.clock.settle()

    // Its turn is recorded on the existing thread, prompted with the message alone; no thread was created.
    const recorded = fake.server.subagents.get(run!.agentId)!
    expect(recorded.thread).toBe('notes-thread')
    expect(fake.operations().filter((operation) => operation === 'create')).toHaveLength(creates)
    const records = fake.childRecords(run!.agentId)
    expect(records.map((record) => [record.update?.sessionUpdate, record.update?.content?.[0]?.text ?? record.update?.state]))
      .toEqual([['state_update', 'running'], ['user_message', 'Write RELEASE.md'], ['agent_message', 'Wrote RELEASE.md'], ['state_update', 'idle']])
    expect(records[1]!.update?._meta?.delta?.sender).toEqual({ external_id: fake.session })
    expect(fake.entered.at(-1)?.text).toBe('The Delta thread "Release notes" finished its turn. Its reply:\n\nWrote RELEASE.md')
    fake.expectClean()
  })

  test('Claude takes over a thread someone else is running only when the person agrees', async ($, on) => {
    const fake = await sharedSession($, on)
    fake.server.worktrees = [{ reference: 'worktree-1#t=1', name: 'repo' }]
    fake.live()!.frame({ type: 'worktrees', worktrees: fake.server.worktrees })
    fake.server.threads.set('root#s=notes', {
      thread: 'notes-thread', name: 'Release notes', worktrees: [{ reference: 'worktree-1#t=1', name: 'repo' }],
      items: [remoteItem('We should ship release notes', { id: 'ask' })], runningBy: 'Antonio',
    })
    fake.child({ thread_id: 'notes-thread', reference: 'root#s=notes', kind: 'subthread', name: 'Release notes', status: 'running' })
    await fake.clock.settle()
    const send = () => $.session.send({ to: 'Release notes', text: 'Write RELEASE.md' } as never)

    // A session no one can answer leaves the thread alone without asking.
    fake.questions.length = 0
    fake.surfaces = []
    expect(await send()).toMatchObject({ isDelivered: false, reason: expect.stringContaining('running in Delta (Antonio)') })
    expect(fake.questions).toHaveLength(0)

    // Asked, the person may leave it running.
    fake.surfaces = ['terminal']
    const answer = (choice: string) => (question: any) => ({ result: { answers: { [question.questions[0].question]: choice } } })
    fake.answerQuestion = answer('Leave it running')
    expect(await send()).toMatchObject({ isDelivered: false })
    expect(fake.questions.at(-1)?.questions[0].question).toBe('Claude wants to take over "Release notes", which Antonio is running in Delta. Take it over?')
    expect(fake.spawned).toHaveLength(0)

    // Or let Claude take it over.
    fake.answerQuestion = answer('Take it over')
    expect(await send()).toEqual({ isDelivered: true })
    expect(fake.spawned).toHaveLength(1)
  })

  test('a subagent resumed by a message hears what happened in Delta since it last ran, and its message is recorded', async ($, on) => {
    const fake = await sharedSession($, on)
    await mainTurn($, 'main')
    const agentId = await spawn($)
    await childRun($, agentId, 'first-turn', 'Parser looks fine')
    await fake.clock.settle()
    const child = fake.server.subagents.get(agentId)!
    fake.server.threads.set(child.reference, {
      thread: child.thread, name: child.name, worktrees: [],
      items: [
        remoteItem('Parser looks fine', { id: 'own', kind: 'agent_message', turn_id: '1', author: { user_id: null, name: 'Claude Code', actor_id: childActor(agentId) } }),
        remoteItem('Also check the lexer', { id: 'ask' }),
        remoteItem('The lexer is fine too', { id: 'delta', kind: 'agent_message', turn_id: 'delta-turn', author: { user_id: null, name: 'Delta agent' } }),
      ],
    })
    fake.child({ thread_id: child.thread, reference: child.reference, kind: 'subthread', name: child.name, status: 'inactive' })
    await fake.clock.settle()

    expect(await $.session.send({ to: 'Inspect the parser', text: 'Summarize both' } as never)).toEqual({ isDelivered: true })
    // Claude's own delivery resumes it, readdressed to the agent and told what it missed.
    const [sent] = fake.sends
    expect(sent!.to).toBe(agentId)
    for (const part of ['Also check the lexer', 'The lexer is fine too', 'Summarize both']) expect(sent!.text).toContain(part)
    expect(sent!.text).not.toContain('Parser looks fine')
    await $.agent.spawn(spawnInput({ resume: { agentId }, prompt: sent!.text }) as never)
    await $.turn.start({ ...turnStart('second-turn'), agentId } as never)
    await $.turn.complete({ ...turnComplete('second-turn'), agentId } as never)
    await fake.clock.settle()
    const prompts = fake.childRecords(agentId).filter((record) => record.update?.sessionUpdate === 'user_message')
    expect(prompts.map((record) => [record.update?.content?.[0]?.text, record.turnSequence]))
      .toEqual([['Inspect the parser', 1], ['Summarize both', 5]])

    // Delta reports the resumed turn's end too; it was Claude's own, so the parent hears nothing of it.
    const reports = () => notes(fake).filter((note) => note.includes('ran a turn in the thread'))
    fake.server.threads.get(child.reference)!.items.push(
      remoteItem('Both are fine', { id: 'own-2', kind: 'agent_message', turn_id: '3', author: { user_id: null, name: 'Claude Code', actor_id: childActor(agentId) } }))
    fake.child({ thread_id: child.thread, reference: child.reference, kind: 'subthread', name: child.name, status: 'running' })
    fake.child({ thread_id: child.thread, reference: child.reference, kind: 'subthread', name: child.name, status: 'inactive' })
    await fake.clock.settle()
    expect(reports()).toEqual([])
    fake.expectClean()
  })

  test("a takeover in Delta stops a running subagent at once, and the parent hears Delta's reply, then later Delta turns as context", async ($, on) => {
    const fake = await sharedSession($, on)
    await mainTurn($, 'main')
    const agentId = await spawn($)
    await $.session.append(childPrompt(agentId))
    await $.turn.start({ ...turnStart('long-tool', 'Inspect the parser'), agentId } as never)
    await fake.settleUntil(() => fake.childRecords(agentId).some((record) =>
      record.update?.sessionUpdate === 'state_update' && record.update.state === 'running') &&
      fake.childWatches.has(agentId))
    const appends = fake.operations().filter((operation) => operation === 'append').length
    // The child is inside a long tool call, so nothing it records would carry the fence; its watch does.
    fake.supersedeChild(agentId)
    await fake.settleUntil(() => fake.taskStops.includes(agentId))
    expect(fake.taskStops).toEqual([agentId])
    expect(fake.operations().filter((operation) => operation === 'append')).toHaveLength(appends)
    // Claude ends the stopped run; its watch closes with the turn, and it is stopped only once.
    await $.turn.complete({ ...turnComplete('long-tool'), agentId, isAborted: true } as never)
    await $.turn.complete(turnComplete('main'))
    await fake.clock.settle()
    expect(fake.childWatches.get(agentId)?.closed).toBe(true)
    expect(fake.taskStops).toEqual([agentId])

    const child = fake.server.subagents.get(agentId)!
    const items = [remoteItem('Inspect the parser', { id: 'prompt', author: null })]
    fake.server.threads.set(child.reference, { thread: child.thread, name: child.name, worktrees: [], items })
    const status = (value: string) =>
      fake.child({ thread_id: child.thread, reference: child.reference, kind: 'subthread', name: child.name, status: value })
    status('running')
    items.push(remoteItem('The parser is fine', { id: 'reply', kind: 'agent_message', turn_id: 'delta-1', author: { user_id: null, name: 'Delta agent' } }))
    status('inactive')
    await fake.clock.settle()
    // The parent waited on that turn, so its reply starts a turn of the parent's own.
    expect(fake.entered.at(-1)?.text).toContain('Delta agent ran a turn in the thread "Inspect the parser" in Delta')
    expect(fake.entered.at(-1)?.text).toContain('The parser is fine')
    const entered = fake.entered.length

    status('running')
    items.push(remoteItem('Check the lexer too', { id: 'ask-2' }))
    items.push(remoteItem('The lexer is fine', { id: 'reply-2', kind: 'agent_message', turn_id: 'delta-2', author: { user_id: null, name: 'Delta agent' } }))
    status('inactive')
    await fake.clock.settle()
    // Nobody waits on this one: it is context for the parent's next turn, reported from where the last report ended.
    expect(fake.entered).toHaveLength(entered)
    const report = notes(fake).at(-1)!
    expect(report).toContain('The lexer is fine')
    expect(report).not.toContain('The parser is fine')
    fake.expectClean()
  })
})

/** The rows the plugin added to Claude's context. */
function notes(fake: ReturnType<typeof fakeThreads>): string[] {
  return fake.stored.filter((row) => row.origin?.kind === 'plugin').flatMap((row) =>
    row.content.flatMap((block) => block.type === 'text' ? [block.text] : []))
}

const text = (value: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text: value }] })
const answer = (value: string) => ({ role: 'assistant' as const, content: [{ type: 'text' as const, text: value }] })

/** A session shared before the test's subagents run. */
async function sharedSession($: Engine, on: On) {
  const fake = fakeThreads(on)
  await $.session.start(sessionStart)
  await fake.share($)
  return fake
}

async function mainTurn($: Engine, turnId: string) {
  await $.prompt.submit(prompt('delegate'))
  await $.turn.start(turnStart(turnId))
}

function spawnInput(fields: Record<string, unknown> = {}) {
  return {
    tool_use_id: 'agent-call', prompt: 'Inspect the parser', description: 'Inspect the parser',
    subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'test-model',
    background: true, fork: false, ...fields,
  }
}

/** Spawn a subagent as the Agent tool does and return the agent ID the host gave it. */
async function spawn($: Engine, fields: Record<string, unknown> = {}): Promise<string> {
  const result = await $.agent.spawn(spawnInput(fields) as never) as { agentId?: string }
  return result.agentId!
}

function childPrompt(agentId: string) {
  return { agentId, door: 'prompt', uuid: `${agentId}-prompt`, message: {
    type: 'user', role: 'user', content: [{ type: 'text', text: 'Inspect the parser' }] } } as never
}

/** One run of a subagent: its prompt, its turn, and its answer. */
async function childRun($: Engine, agentId: string, turnId: string, reply: string) {
  await $.session.append(childPrompt(agentId))
  await $.turn.start({ ...turnStart(turnId, 'Inspect the parser'), agentId } as never)
  await $.session.append({ agentId, door: 'response', uuid: `${turnId}-answer`, message: {
    type: 'assistant', role: 'assistant', content: [{ type: 'text', text: reply }] } } as never)
  await $.turn.complete({ ...turnComplete(turnId), agentId } as never)
}
