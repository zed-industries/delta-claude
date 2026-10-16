import { describe, expect, test as kitTest, tier, type Engine } from 'claude-code/testing'
import { CHECKOUT, CONFIG, FOLDERS, LIVE, MOUNTS, abovePrompt, bash, fakeThreads, prompt, remoteItem, sessionEnd, sessionStart, shareCommand, testsWithHeldClockWait, turnComplete, turnStart } from './fake-thread-commands'
import { itemFingerprint } from './conversation'
import { cliFixture } from './cli-fixtures'
import { HANDOFF_ACKNOWLEDGEMENT, HANDOFF_EXPIRY_MS, HANDOFF_PROMPT, newSessionLink } from './handoff'

tier('user')

/** Keeps a clock wait held, so stepping the mock clock does not wait out a settle budget. */
const test = testsWithHeldClockWait(kitTest)

describe('joining', () => {
  test('Windows mixed separators join and allow subdirectories but not sibling checkouts', async ($, on) => {
    const fake = sharedThread(on, $)
    const directory = String.raw`C:\Workspace\zed\delta\.delta\worktrees\rn4eercbxvfw\delta`
    const reported = String.raw`C:\Workspace\zed\delta\.delta\worktrees\rn4eercbxvfw/delta`
    fake.mountReply = (owner) => {
      fake.root = reported
      fake.worktreeItems = [{ reference: REFERENCE, checkouts: [
        { directory: reported, state: 'detached', active: true },
      ] }]
      return cliFixture('mount', { thread_id: fake.threadId, owner, directory,
        worktrees: [{ reference: REFERENCE, name: 'delta', directory, state: 'mounted' }] })
    }
    await $.session.start(sessionStart)
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    await finishJoin(fake)
    expect(fake.store.get(`session:${fake.session}`)).toMatchObject({ joined: true, snapshot: true, directory })
    fake.cwd = `${directory}\\src`
    expect((await $.prompt.submit(prompt('inside the checkout'))).drop).toBeUndefined()
    fake.cwd = `${directory}-other`
    expect((await $.prompt.submit(prompt('outside the checkout'))).drop).toBeDefined()
    await $.session.end(sessionEnd(fake.session))
  })

  for (const locator of [{ code: 'invalid_reference' }, { code: 'invalid_reference', reason: 'invalid_worktree_reference' }] as const) test(`an invalid join locator (${locator.reason ?? locator.code}) suggests the share link, not the same locator`, async ($, on) => {
    const fake = sharedThread(on, $)
    const address = 'unsupported-thread-address'
    fake.commandFault = { operation: 'status', ...locator, message: 'unsupported locator' }
    const previousSession = fake.session
    await $.session.start(sessionStart)
    await $.command.run({ ...shareCommand, args: `join ${address}` })
    await finishJoin(fake)
    const text = fake.logs.join('\n')
    expect(text).toContain("Use the thread's share link with /delta-join")
    expect(text).not.toContain(`Retry /delta-join ${address}`)
    expect(fake.session).toBe(previousSession)
    expect(fake.sessionCommands).toEqual([])
    await $.session.end(sessionEnd(fake.session))
  })

  test('a join waits out a Delta daemon that is still connecting', async ($, on) => {
    const fake = sharedThread(on, $)
    const previousSession = fake.session
    fake.commandFault = { operation: 'status', code: 'failed', reason: 'remote', message: 'disconnected', retryable: true }
    await $.session.start(sessionStart)
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    await finishJoin(fake)
    expect(await bandText($)).toContain('Waiting for Delta to connect')
    expect(fake.session).toBe(previousSession)
    fake.commandFault = undefined
    await fake.clock.advance(2000)
    expect(fake.session).not.toBe(previousSession)
    expect(fake.store.get(`session:${fake.session}`)).toMatchObject({ thread: fake.threadId, joined: true })
    await $.session.end(sessionEnd(fake.session))
  })

  test('a join stops waiting for Delta after its retry budget and leaves the session as it was', async ($, on) => {
    const fake = sharedThread(on, $)
    const previousSession = fake.session
    fake.commandFault = { operation: 'status', code: 'failed', reason: 'remote', message: 'disconnected', retryable: true }
    await $.session.start(sessionStart)
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    await finishJoin(fake)
    for (const wait of [2000, 4000, 8000, 16_000]) await fake.clock.advance(wait)
    expect(fake.logs.join('\n')).toContain('disconnected. The previous session and folder were preserved.')
    expect(fake.session).toBe(previousSession)
    expect(fake.sessionCommands).toEqual([])
    await $.session.end(sessionEnd(fake.session))
  })

  for (const surface of ['terminal'] as const) test(`${surface} joins in a fresh session and separate exact mount without exporting, attaching, publishing, or executing`, async ($, on) => {
    const fake = sharedThread(on, $)
    fake.contractRange = { min: 1, max: 3 }
    fake.cliMissing = true
    fake.authReplies = [
      { status: 'signed_out' },
      { status: 'pending', login_id: 'join-login', url: 'https://example.com/login', expires_at: '2099-01-01T00:15:00Z' },
      { status: 'signed_in', account: { account_id: 'user' } },
    ]
    fake.surfaces = [surface]
    const previousSession = fake.session
    const old = { session: previousSession, snapshot: false, next: 1, pending: [] }
    fake.store.set(`session:${previousSession}`, old)
    fake.files.set(`${CHECKOUT}/precious.txt`, 'untouched')
    fake.upsert(remoteItem('A remote fact'))
    await $.session.start({ ...sessionStart, surface })
    // A redraw is the hook context the plugin answers its own command in, as a live host's is.
    await $.ui.render(abovePrompt)
    const response = await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    // The band reports the running join, which replaced the pane that used to be opened.
    expect(await bandText($)).toContain('Checking access')
    expect(response.text).toBeUndefined()
    expect(fake.sessionCommands).toEqual([])
    await finishJoin(fake)
    expect(fake.cliSetups).toEqual(['discover', 'install'])
    expect(fake.authCalls.map((argv) => argv.slice(2))).toEqual([
      ['auth', 'status'], ['auth', 'login', '--no-wait'], ['auth', 'wait', 'join-login'],
    ])
    const binding = fake.store.get(`session:${fake.session}`) as any
    expect(fake.session).not.toBe(previousSession)
    expect(await bandText($)).toContain(LIVE)
    expect(fake.sessionCommands).toEqual([{ command: 'clear', args: '' }, { command: 'cd', args: `${MOUNTS}/${fake.session}/delta` }])
    // Claude's trust prompt names only a path, so the transcript says what it is and which answer joins.
    expect(fake.logs.some((line) => line.includes('Yes, move here'))).toBe(true)
    // A thread with one worktree is worked in at that worktree's own checkout.
    const directory = `${MOUNTS}/${fake.session}/delta`
    expect(binding).toMatchObject({
      session: fake.session, thread: fake.threadId, locator: link(fake), joined: true, owner: fake.session,
      directory, mounts: [{ reference: REFERENCE, name: 'delta', directory, state: 'mounted' }],
      snapshot: true, next: 1, pending: [],
    })
    expect(fake.cwd).toBe(directory)
    expect(fake.delta().filter((argv) => argv[3] === 'mount')).toEqual([
      ['/selected/delta', '--json', 'thread', 'mount', link(fake), '--owner', fake.session, '--join']])
    expect(fake.cliIntegrations.filter((call) => call.operation === 'mount')).toEqual([
      { operation: 'mount', integration: 'claude_code', commandForm: 'delta_subcommand' },
    ])
    // Delta places the checkouts: the plugin chooses no directory and keeps nothing under its config.
    expect([...fake.files.keys()].filter((path) => path.includes('checkouts'))).toEqual([])
    expect(fake.commands.some((argv) => argv[0] === 'pwd')).toBe(false)
    expect(fake.server.mount).toEqual({ thread: fake.threadId, directory: CHECKOUT, reference: REFERENCE })
    expect(fake.files.get(`${CHECKOUT}/precious.txt`)).toBe('untouched')
    // The previous session is left as it was, apart from the end marker bounded cleanup reads.
    expect(fake.store.get(`session:${previousSession}`)).toEqual({ ...old, endedAt: expect.any(Number) })
    expect(fake.exports).toBe(0)
    expect(fake.records()).toEqual([])
    expect(fake.entered).toEqual([])
    expect(fake.rows.length).toBe(1)
    expect(fake.operations().some((operation) => ['create', 'attach', 'share', 'append'].includes(operation!))).toBe(false)
    for (const argv of fake.delta().filter((argv) => ['watch', 'status'].includes(argv[3]!)))
      expect(argv[4]).toBe(link(fake))
    fake.expectClean()
    await $.session.end(sessionEnd(fake.session))
  })

  test("a Desktop tab hands the join to a new session in the thread's folder, changing nothing here", async ($, on) => {
    const fake = desktopTab(on, $)
    const before = fake.session
    const offer = await offerFromDesktopTab($, fake)
    expect(fake.session).toBe(before)
    expect(fake.sessionCommands).toEqual([])
    // A one-worktree thread asks for its thread folder, which Desktop opens as a plain folder.
    expect(fake.mountRequests).toEqual([{ owner: offer.owner, folder: true, join: true }])
    expect(fake.opened).toEqual([newSessionLink(offer.folder, HANDOFF_PROMPT)])
    expect(JSON.parse(fake.files.get(offer.record)!)).toMatchObject({
      owner: offer.owner, thread: fake.threadId, locator: link(fake), directory: offer.folder,
    })
    expect(await bandText($)).toContain('Press Enter in the new Claude Code Desktop session to join “Fix the parser”')
    expect(fake.watches.length).toBe(0)
    expect(fake.unmounts).toEqual([])
    fake.expectClean()
    await $.session.end(sessionEnd(fake.session))
  })

  test("the session started in the thread's folder joins before its opening line, which becomes a one-word turn the thread never records", async ($, on) => {
    const fake = desktopTab(on, $)
    fake.contractRange = { min: 1, max: 3 }
    const offer = await offerFromDesktopTab($, fake)
    await startInThreadFolder($, fake, offer.folder)
    // Claude delivers the first prompt once session.start returns, so the join is done by then.
    expect(fake.store.get('session:opened-from-link')).toMatchObject({
      joined: true, snapshot: true, owner: offer.owner, directory: offer.folder, locator: link(fake),
    })
    // The requested offer reports one join. The automatic takeover reuses its mount without reporting another.
    expect(fake.mountRequests).toEqual([
      { owner: offer.owner, folder: true, join: true },
      { owner: offer.owner, folder: false, join: false },
    ])
    expect(fake.files.has(offer.record)).toBe(false)
    expect(fake.sessionCommands).toEqual([])
    expect(await bandText($)).toContain(LIVE)
    expect((await $.prompt.submit(prompt(HANDOFF_PROMPT))).drop).toBeUndefined()
    expect(fake.entered.at(-1)?.text).toBe(HANDOFF_ACKNOWLEDGEMENT)
    await oneTurn($, 'opening', HANDOFF_ACKNOWLEDGEMENT, 'Joined.')
    await fake.clock.advance(0)
    expect(fake.records()).toEqual([])
    // The person's next prompt is theirs, and the thread records it as usual.
    expect((await $.prompt.submit(prompt('What is left on the parser?'))).drop).toBeUndefined()
    expect(fake.entered.at(-1)?.text).toBe('What is left on the parser?')
    await oneTurn($, 'second', 'What is left on the parser?', 'The tests.')
    await fake.clock.advance(0)
    expect(fake.records().length).toBeGreaterThan(0)
    expect(JSON.stringify(fake.records())).not.toContain('Joined.')
    // The offering tab sees the record claimed and stops offering; nothing is released.
    await fake.clock.advance(2_000)
    expect(fake.unmounts).toEqual([])
    fake.expectClean()
    await $.session.end(sessionEnd(fake.session))
  })

  test('a session joining a hand-off is not told it is unrecorded while its mount runs', async ($, on) => {
    const fake = desktopTab(on, $)
    const offer = await offerFromDesktopTab($, fake)
    let release!: () => void
    fake.holdRun = (operation) => operation === 'mount' ? new Promise<void>((resolve) => { release = resolve }) : undefined
    const starting = startInThreadFolder($, fake, offer.folder)
    await fake.clock.settle()
    // Claude raises its classic startup hook too, while the hand-off's mount is still running.
    await $.classic.SessionStart({ session_id: fake.session, source: 'startup', cwd: offer.folder } as never)
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    expect(await bandText($)).not.toMatch(/Not set up|Not syncing/)
    release()
    await starting
    await $.session.end(sessionEnd(fake.session))
  })

  test('an opening line the person changed before sending goes to Claude and the thread as they wrote it', async ($, on) => {
    const fake = desktopTab(on, $)
    const offer = await offerFromDesktopTab($, fake)
    await startInThreadFolder($, fake, offer.folder)
    expect((await $.prompt.submit(prompt('Join this Delta thread and summarize it.'))).drop).toBeUndefined()
    expect(fake.entered.at(-1)?.text).toBe('Join this Delta thread and summarize it.')
    await $.session.end(sessionEnd(fake.session))
  })

  test('where the plugin cannot open the link itself, the transcript carries it for the person to open', async ($, on) => {
    const fake = desktopTab(on, $)
    fake.failOpen = true
    const offer = await offerFromDesktopTab($, fake)
    expect(fake.logs.join('\n')).toContain(newSessionLink(offer.folder, HANDOFF_PROMPT))
    expect(await bandText($)).toContain('Open the link in this transcript')
    expect(fake.unmounts).toEqual([])
    await $.session.end(sessionEnd(fake.session))
  })

  test('a hand-off no session joins within 5 minutes is released, saying how to bring it back', async ($, on) => {
    const fake = desktopTab(on, $)
    const offer = await offerFromDesktopTab($, fake)
    await fake.clock.advance(HANDOFF_EXPIRY_MS + 2_000)
    expect(fake.unmounts).toEqual([{ thread: fake.threadId, owner: offer.owner }])
    expect(fake.files.has(offer.record)).toBe(false)
    const text = fake.logs.join('\n')
    expect(text).toContain('No session joined the Delta thread within 5 minutes')
    expect(text).toContain(`Run /delta-join ${link(fake)} to bring it back`)
    fake.expectClean()
    await $.session.end(sessionEnd(fake.session))
  })

  test('the offering tab exiting releases a hand-off no session joined', async ($, on) => {
    const fake = desktopTab(on, $)
    const offer = await offerFromDesktopTab($, fake)
    await $.session.end({ ...sessionEnd(fake.session), reason: 'prompt_input_exit' })
    expect(fake.unmounts).toEqual([{ thread: fake.threadId, owner: offer.owner }])
    expect(fake.files.has(offer.record)).toBe(false)
  })

  test("Claude's own cd below the joined directory keeps participating, and leaving it pauses", async ($, on) => {
    const fake = sharedThread(on, $)
    await $.session.start(sessionStart)
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    await finishJoin(fake)
    const directory = `${MOUNTS}/${fake.session}/delta`
    // A Bash `cd` moves the shell's directory, not the project root.
    fake.root = directory
    fake.cwd = `${directory}/crates/deltadb/src`
    expect((await $.prompt.submit(prompt('from a subdirectory'))).drop).toBeUndefined()
    await $.tool.call(bash('nested', 'grep -n fn worktree_text.rs'))
    await fake.clock.advance(0)
    expect(fake.updates().map((record) => record.update?.toolCallId)).toContain('nested')
    expect(fake.logs.join('\n')).not.toContain('must run in')
    // A sibling that only shares the path's prefix is another directory.
    fake.cwd = `${directory}-other`
    await $.tool.call(bash('outside', 'echo outside'))
    await fake.clock.advance(0)
    expect(fake.updates().map((record) => record.update?.toolCallId)).not.toContain('outside')
    expect(fake.logs.join('\n')).toContain(`must run in ${directory}`)
    expect((await $.prompt.submit(prompt('from outside'))).drop).toBeDefined()
    await $.session.end(sessionEnd(fake.session))
  })

  test('resume mounts again, moves Claude from its launch directory, and records only new rows', async ($, on) => {
    const fake = sharedThread(on, $)
    fake.contractRange = { min: 1, max: 3 }
    await $.session.start(sessionStart)
    await $.command.run({ ...shareCommand, args: `join ${fake.shareId}` })
    await finishJoin(fake)
    const binding = structuredClone(fake.store.get(`session:${fake.session}`)) as any
    const session = fake.session
    await $.session.end({ ...sessionEnd(session), reason: 'prompt_input_exit' })
    // Exiting released the checkouts; Claude comes back in whatever directory it was launched from.
    expect(fake.unmounts).toEqual([{ thread: fake.threadId, owner: session }])
    expect(fake.server.groups.size).toBe(0)
    fake.cwd = '/launch'
    const commands = fake.delta().length
    const moves = fake.sessionCommands.length
    await $.session.start({ ...sessionStart, cwd: fake.cwd })
    // Prompts wait while the worktrees come back, and the band shows the progress.
    expect(await bandText($)).toContain("Restoring the thread's worktrees")
    expect((await $.prompt.submit(prompt('too early'))).drop).toBeDefined()
    await fake.clock.advance(0)
    expect(fake.cwd).toBe(binding.directory)
    expect(fake.sessionCommands.slice(moves)).toEqual([{ command: 'cd', args: binding.directory }])
    expect(fake.store.get(`session:${session}`)).toEqual(binding)
    expect(fake.delta().slice(commands).some((argv) => argv.includes('mount'))).toBe(true)
    expect(fake.delta().slice(commands).filter((argv) => argv[3] === 'mount').every((argv) => !argv.includes('--join'))).toBe(true)
    expect(fake.operations().slice(commands).some((operation) => ['create', 'attach', 'share'].includes(operation!))).toBe(false)
    expect((await $.prompt.submit(prompt('after restore'))).drop).toBeUndefined()
    await $.tool.call(bash('new-tool', 'echo new local output'))
    await fake.clock.advance(0)
    expect(fake.exports).toBe(0)
    expect(fake.updates()).toHaveLength(1)
    expect(fake.updates()[0]?.update?.toolCallId).toBe('new-tool')
    expect(await fake.share($)).toContain('/delta-join')
    expect(fake.operations().some((operation) => ['attach', 'share', 'create'].includes(operation!))).toBe(false)
    // Resuming in the right directory mounts again but needs no move.
    await $.session.end({ ...sessionEnd(session), reason: 'logout' })
    const before = fake.sessionCommands.length
    await $.session.start({ ...sessionStart, cwd: fake.cwd })
    await fake.clock.advance(0)
    expect(fake.sessionCommands.length).toBe(before)
    expect(fake.server.groups.has(session)).toBe(true)
    fake.expectClean()
    await $.session.end(sessionEnd(fake.session))
  })

  test('a failed mount after the clear keeps the fresh session in its saved transition until a retry mounts it', async ($, on) => {
    const fake = sharedThread(on, $)
    fake.commandFault = { operation: 'mount', message: 'daemon unavailable' }
    const before = fake.session
    await $.session.start(sessionStart)
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    await finishJoin(fake)
    const fresh = fake.session
    expect(fresh).not.toBe(before)
    expect(fake.store.get(`session:${fresh}`)).toMatchObject({ snapshot: false, joinTransition: { locator: link(fake), thread: fake.threadId } })
    expect(fake.cwd).toBe(CHECKOUT)
    expect(fake.logs.join('\n')).toContain('daemon unavailable')
    // The failure also shows in the band, in red, alongside the transcript message.
    const band = JSON.stringify(await $.ui.render(abovePrompt))
    expect(band).toContain('"color":"red"')
    expect((await $.prompt.submit(prompt('not mounted yet'))).drop).toBeDefined()
    fake.commandFault = undefined
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    await finishJoin(fake)
    expect(fake.session).toBe(fresh)
    expect(fake.cwd).toBe(`${MOUNTS}/${fresh}/delta`)
    expect(fake.sessionCommands.filter((entry) => entry.command === 'clear')).toHaveLength(1)
    expect(fake.operations().filter((operation) => operation === 'mount')).toHaveLength(2)
    expect(fake.store.get(`session:${fresh}`)).toMatchObject({ snapshot: true, joined: true, owner: fresh })
    fake.expectClean()
    await $.session.end(sessionEnd(fake.session))
  })

  test('a thread with three worktrees is joined in a thread folder and every worktree is checked before a prompt', async ($, on) => {
    const fake = sharedThread(on, $)
    fake.addWorktree('zed')
    fake.addWorktree('web')
    scriptMounts(fake, ['delta', 'zed', 'web'], (owner) => `${FOLDERS}/${owner}`)
    await $.session.start(sessionStart)
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    await finishJoin(fake)
    const session = fake.session
    const folder = `${FOLDERS}/${session}`
    const binding = fake.store.get(`session:${session}`) as any
    expect(binding.directory).toBe(folder)
    expect(binding.mounts.map((mount: any) => [mount.name, mount.directory])).toEqual([
      ['delta', `${MOUNTS}/${session}/delta`], ['zed', `${MOUNTS}/${session}/zed`], ['web', `${MOUNTS}/${session}/web`]])
    expect(fake.cwd).toBe(folder)
    expect(fake.sessionCommands.at(-1)).toEqual({ command: 'cd', args: folder })
    expect((await $.prompt.submit(prompt('all mounted'))).drop).toBeUndefined()
    // One worktree that is not mounted blocks the prompt, and both the reply and the band name it.
    fake.worktreeItems!.find((tree) => tree.reference === 'zed-history#t=0')!.checkouts[0]!.active = false
    const refused = (await $.prompt.submit(prompt('zed is not mounted'))).drop
    expect(refused).toContain('zed')
    expect(refused).not.toContain('"delta"')
    expect(await bandText($)).toContain('zed')
    fake.worktreeItems!.find((tree) => tree.reference === 'zed-history#t=0')!.checkouts[0]!.active = true
    expect((await $.prompt.submit(prompt('mounted again'))).drop).toBeUndefined()
    expect(await bandText($)).not.toContain('"color":"red"')
    // Claude outside the session's directory is refused too, naming where it has to be.
    fake.cwd = `${MOUNTS}/${session}/zed`
    expect((await $.prompt.submit(prompt('wrong directory'))).drop).toBeDefined()
    fake.cwd = folder
    expect(fake.exports).toBe(0)
    expect(fake.operations().filter((operation) => operation === 'mount')).toHaveLength(1)
    expect(fake.server.mount?.directory).toBe(CHECKOUT)
    fake.expectClean()
    await $.session.end(sessionEnd(session))
  })

  test('worktrees added and removed live update the mounts, tell Claude and the person, and move Claude to the thread folder once', async ($, on) => {
    const fake = sharedThread(on, $)
    fake.contractRange = { min: 1, max: 3 }
    await $.session.start(sessionStart)
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    await finishJoin(fake)
    const session = fake.session
    const own = `${MOUNTS}/${session}/delta`
    const folder = `${FOLDERS}/${session}`
    const mounts = () => fake.delta().filter((argv) => argv[3] === 'mount').length
    expect(mounts()).toBe(1)
    // The thread's list is reported again after a reconnect and changes nothing.
    fake.live()!.exit(1)
    await fake.clock.advance(0)
    await fake.clock.advance(1000)
    expect(fake.live()).toBeDefined()
    expect(mounts()).toBe(1)
    expect(fake.rows).toEqual([])

    // A second worktree: Claude was in the first one's checkout, so it moves up to the folder.
    scriptMounts(fake, ['delta', 'zed'], () => folder)
    fake.addWorktree('zed')
    await fake.clock.advance(0)
    expect(mounts()).toBe(2)
    expect(fake.delta().filter((argv) => argv[3] === 'mount').map((argv) => argv.includes('--join'))).toEqual([true, false])
    expect(fake.cwd).toBe(folder)
    expect(fake.sessionCommands.at(-1)).toEqual({ command: 'cd', args: folder })
    expect((fake.store.get(`session:${session}`) as any)).toMatchObject({
      directory: folder, mounts: [{ name: 'delta', directory: own }, { name: 'zed', directory: `${MOUNTS}/${session}/zed` }] })
    // Each row's first line is what Claude is told.
    expect(fake.rows[0]).toContain('zed')
    expect(fake.rows.at(-1)).toContain(folder)
    expect(fake.rows).toHaveLength(2)
    expect((await $.prompt.submit(prompt('two worktrees'))).drop).toBeUndefined()
    await $.turn.start(turnStart('first-turn'))
    await $.turn.complete(turnComplete('first-turn'))

    // A session in the thread folder stays there as worktrees come and go.
    const moves = fake.sessionCommands.length
    scriptMounts(fake, ['delta', 'zed', 'web'], () => folder)
    fake.addWorktree('web')
    await fake.clock.advance(0)
    scriptMounts(fake, ['delta', 'web'], () => folder)
    fake.removeWorktree('zed')
    await fake.clock.advance(0)
    scriptMounts(fake, ['delta'], () => folder)
    fake.removeWorktree('web')
    await fake.clock.advance(0)
    expect(fake.sessionCommands.length).toBe(moves)
    expect(fake.cwd).toBe(folder)
    expect((fake.store.get(`session:${session}`) as any).directory).toBe(folder)
    expect((fake.store.get(`session:${session}`) as any).mounts.map((mount: any) => mount.name)).toEqual(['delta'])
    expect(fake.rows).toHaveLength(5)
    expect(fake.rows.at(-1)).toContain('web')
    expect(await bandText($)).toContain('web')
    expect((await $.prompt.submit(prompt('back to one'))).drop).toBeUndefined()
    fake.expectClean()
    await $.session.end(sessionEnd(session))
  })

  test('a worktree added during a turn waits for the turn to end before telling Claude and moving it', async ($, on) => {
    const fake = sharedThread(on, $)
    await $.session.start(sessionStart)
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    await finishJoin(fake)
    const session = fake.session
    const own = `${MOUNTS}/${session}/delta`
    await $.turn.start(turnStart('running'))
    scriptMounts(fake, ['delta', 'zed'], () => `${FOLDERS}/${session}`)
    fake.addWorktree('zed')
    await fake.clock.advance(0)
    expect(fake.cwd).toBe(own)
    expect(fake.rows).toEqual([])
    await $.turn.complete(turnComplete('running'))
    await fake.clock.advance(0)
    expect(fake.cwd).toBe(`${FOLDERS}/${session}`)
    expect(fake.rows).toHaveLength(2)
    await $.session.end(sessionEnd(session))
  })

  for (const reason of ['clear'] as const) {
    test(`session end for ${reason} ${['clear', 'resume'].includes(reason) ? 'keeps' : 'releases'} the session's mounts`, async ($, on) => {
      const fake = sharedThread(on, $)
      await $.session.start(sessionStart)
      await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
      await finishJoin(fake)
      const session = fake.session
      const released = !['clear', 'resume'].includes(reason)
      await $.session.end({ ...sessionEnd(session), reason })
      expect(fake.unmounts).toEqual(released ? [{ thread: fake.threadId, owner: session }] : [])
      expect(fake.server.groups.has(session)).toBe(!released)
      fake.expectClean()
    })
  }

  for (const surface of ['terminal'] as const) for (const failure of ['clear', 'cd'] as const) {
    test(`${surface}: a refused ${failure} surfaces partial progress without enabling participation in the old cwd`, async ($, on) => {
      const fake = sharedThread(on, $)
      fake.surfaces = [surface]
      fake.refuseClear = failure === 'clear'
      fake.refuseCd = failure === 'cd'
      const before = fake.session
      await $.session.start({ ...sessionStart, surface })
      await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
      await finishJoin(fake)
      expect(fake.logs.length).toBeGreaterThan(0)
      expect(fake.cwd).toBe(CHECKOUT)
      expect(fake.watches.length).toBe(0)
      if (failure === 'clear') {
        expect(fake.session).toBe(before)
        expect(fake.store.has(`session:${before}`)).toBe(false)
      } else {
        expect(fake.session).not.toBe(before)
        expect(fake.store.get(`session:${fake.session}`)).toMatchObject({ snapshot: false, joinTransition: { locator: link(fake) }, next: 1, pending: [] })
        expect((await $.prompt.submit(prompt('do not run here'))).drop).toBeDefined()
        const saved = structuredClone(fake.store.get(`session:${fake.session}`))
        const commands = fake.delta().length
        expect(await fake.share($)).toContain('/delta-join')
        expect(fake.exports).toBe(0)
        expect(fake.delta().length).toBe(commands)
        expect(fake.store.get(`session:${fake.session}`)).toEqual(saved)
        await $.session.end(sessionEnd(fake.session))
        await $.session.start(sessionStart)
        expect(fake.logs.join('\n')).toContain((saved as any).directory)
        expect((await $.prompt.submit(prompt('still blocked after restart'))).drop).toBeDefined()
        await $.command.run({ ...shareCommand, args: 'join another-link' })
        await finishJoin(fake)
        expect(fake.store.get(`session:${fake.session}`)).toEqual(saved)
        fake.refuseCd = false
        await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
        await finishJoin(fake)
        expect(fake.store.get(`session:${fake.session}`)).toMatchObject({ snapshot: true, joined: true })
        expect(fake.sessionCommands.filter((entry) => entry.command === 'clear')).toHaveLength(1)
        expect(fake.operations().filter((operation) => operation === 'mount')).toHaveLength(2)
      }
      await $.session.end(sessionEnd(fake.session))
    })
  }

  test('busy and pending transitions refuse prompts and repeated join commands', async ($, on) => {
    const fake = sharedThread(on, $)
    await $.session.start(sessionStart)
    await $.turn.start(turnStart('busy'))
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    await finishJoin(fake)
    expect(fake.sessionCommands).toEqual([])
    expect(fake.operations()).not.toContain('mount')
    await $.turn.complete({ turnId: 'busy', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    expect((await $.prompt.submit(prompt('no execution'))).drop).toBeDefined()
    await finishJoin(fake)
    expect(fake.entered).toEqual([])
    await $.session.end(sessionEnd(fake.session))
  })

  test('background agents refuse join before any native side effect', async ($, on) => {
    const fake = sharedThread(on, $)
    await $.session.start(sessionStart)
    fake.agents = [{ id: 'bg', type: 'teammate', description: 'writing', status: 'running' }]
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    await finishJoin(fake)
    expect(fake.delta()).toEqual([])
    expect(fake.sessionCommands).toEqual([])
    await $.session.end(sessionEnd(fake.session))
  })

  test('a nonempty fresh producer and a wrong project root never enable a completed binding', async ($, on) => {
    const fake = sharedThread(on, $)
    fake.server.next = 2
    await $.session.start(sessionStart)
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    await finishJoin(fake)
    expect(fake.store.get(`session:${fake.session}`)).toMatchObject({ snapshot: false, joinTransition: { thread: fake.threadId } })
    expect((await $.prompt.submit(prompt('no sequence reuse'))).drop).toBeDefined()
    fake.server.next = 1
    fake.root = CHECKOUT
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    await finishJoin(fake)
    expect(fake.store.get(`session:${fake.session}`)).toMatchObject({ snapshot: false })
    expect(fake.watches).toEqual([])
    expect(fake.records()).toEqual([])
    await $.session.end(sessionEnd(fake.session))
  })

  test('a joined delivery refusal lifts only after explicit successful same-thread join verification', { timeoutMs: 15_000 }, async ($, on) => {
    const fake = sharedThread(on, $)
    await $.session.start(sessionStart)
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    await finishJoin(fake)
    fake.appendFaults.push({ accept: 0, exitCode: 2,
      stdout: () => JSON.stringify({ error: { code: 'access_denied', message: 'access revoked', retryable: false } }) })
    await $.tool.call(bash('retry-tool', 'echo still queued'))
    await fake.clock.advance(0)
    expect((await $.prompt.submit(prompt('cannot run yet'))).drop).toBeDefined()
    fake.live()!.exit(1)
    await fake.clock.advance(0)
    await fake.clock.advance(1000)
    expect((await $.prompt.submit(prompt('reconnect cannot authorize'))).drop).toBeDefined()
    fake.statusPatch = { access: { state: 'local_only', is_owner: null } }
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    await finishJoin(fake)
    expect((await $.prompt.submit(prompt('failed explicit check'))).drop).toBeDefined()
    fake.statusPatch = undefined
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    await finishJoin(fake)
    expect((await $.prompt.submit(prompt('authorized after explicit check'))).drop).toBeUndefined()
    expect(fake.updates()).toHaveLength(1)
    expect(fake.updates()[0]?.update?.toolCallId).toBe('retry-tool')
    expect(fake.operations().some((operation) => ['create', 'share', 'attach'].includes(operation!))).toBe(false)
    await $.session.end(sessionEnd(fake.session))
  })

  for (const surface of ['terminal'] as const) {
    test(`${surface}: repeated join aliases preserve the existing producer and pending immutable records, then deliver once`, { timeoutMs: 15_000 }, async ($, on) => {
      const fake = sharedThread(on, $)
      fake.surfaces = [surface]
      await $.session.start({ ...sessionStart, surface })
      await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
      await finishJoin(fake)
      await $.turn.start(turnStart('previous-turn'))
      await $.tool.call(bash('previous-tool', 'echo recorded'))
      await $.turn.complete(turnComplete('previous-turn'))
      await fake.clock.advance(0)
      const recorded = structuredClone(fake.records())
      fake.appendOffline = true
      await $.tool.call(bash('pending-tool', 'echo queued'))
      await fake.clock.advance(0)
      const session = fake.session
      const binding = structuredClone(fake.store.get(`session:${session}`)) as any
      const files = binding.pending.flatMap((entry: any) => entry.files).map((path: string) => [path, fake.files.get(path)])
      expect(binding.pending).toHaveLength(1)
      expect(binding.lastTurnSequence).toBeGreaterThan(0)
      const item = remoteItem('Already handed off', { id: 'known' })
      const ledger = { thread: fake.threadId, items: { known: await itemFingerprint(item) } }
      fake.server.items.set(item.id, item)
      fake.store.set(`appended:${session}`, ledger)
      fake.live()!.exit(1)
      await fake.clock.advance(0)
      const transitions = structuredClone(fake.sessionCommands)
      const commands = fake.operations().length
      // Recovery needs no transition commands, even when the host no longer offers them.
      fake.builtins = []
      await $.command.run({ ...shareCommand, args: `join ${fake.threadId}` })
      await finishJoin(fake)
      expect(fake.session).toBe(session)
      expect(fake.store.get(`session:${session}`)).toEqual(binding)
      for (const [path, content] of files) expect(fake.files.get(path)).toBe(content)
      expect(fake.records()).toEqual(recorded)
      expect(fake.store.get(`appended:${session}`)).toEqual(ledger)
      expect(fake.rows).toEqual([])
      expect(fake.sessionCommands).toEqual(transitions)
      expect(fake.operations().slice(commands).every((operation) => ['mount', 'status', 'watch', 'append'].includes(operation!))).toBe(true)
      fake.appendOffline = false
      await $.command.run({ ...shareCommand, args: `join ${fake.shareId}` })
      await finishJoin(fake)
      const recovered = fake.store.get(`session:${session}`) as any
      expect(recovered).toEqual({ ...binding, pending: [] })
      expect(recovered.next).toBeGreaterThan(1)
      expect(recovered.lastTurnSequence).toBe(binding.lastTurnSequence)
      expect(fake.records().slice(0, recorded.length)).toEqual(recorded)
      expect(fake.updates().filter((entry) => entry.update?.toolCallId === 'pending-tool')).toHaveLength(1)
      expect(fake.store.get(`appended:${session}`)).toEqual(ledger)
      expect(fake.sessionCommands).toEqual(transitions)
      // The reconnected conversation keeps reporting in the band.
      expect(await bandText($)).toContain(LIVE)
      expect(fake.exports).toBe(0)
      expect(fake.entered).toEqual([])
      fake.expectClean()
      await $.session.end(sessionEnd(session))
    })
  }

  test('joining a different canonical thread preserves the previous joined producer', async ($, on) => {
    const fake = sharedThread(on, $)
    await $.session.start(sessionStart)
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    await finishJoin(fake)
    fake.appendOffline = true
    await $.tool.call(bash('old-pending', 'echo queued for the first thread'))
    await fake.clock.advance(0)
    const previous = fake.session
    const binding = structuredClone(fake.store.get(`session:${previous}`)) as any
    const transitions = fake.sessionCommands.length
    // Switch the CLI fixture to a separate shared thread with an empty producer.
    fake.threadId = 'different-canonical-thread'
    fake.shareId = 'thread_different'
    fake.server.thread = fake.threadId
    fake.server.next = 1
    fake.server.records.clear()
    fake.server.groups.clear()
    fake.appendOffline = false
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    await finishJoin(fake)
    const joined = fake.store.get(`session:${fake.session}`) as any
    expect(fake.session).not.toBe(previous)
    expect(joined).toMatchObject({ joined: true, thread: fake.threadId, next: 1, pending: [] })
    expect(joined.directory).not.toBe(binding.directory)
    expect(fake.sessionCommands.slice(transitions)).toEqual([{ command: 'clear', args: '' }, { command: 'cd', args: joined.directory }])
    expect(fake.store.get(`session:${previous}`)).toMatchObject(binding)
    for (const entry of binding.pending) for (const path of entry.files) expect(fake.files.has(path)).toBe(true)
    expect(fake.exports).toBe(0)
    expect(fake.entered).toEqual([])
    fake.expectClean()
    await $.session.end(sessionEnd(fake.session))
  })

  test('same-thread recovery interrupted during status preserves the replacement session and its live watcher', async ($, on) => {
    const fake = sharedThread(on, $)
    await $.session.start(sessionStart)
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    await finishJoin(fake)
    const previous = fake.session
    const binding = structuredClone(fake.store.get(`session:${previous}`)) as any
    const transitions = structuredClone(fake.sessionCommands)
    let observed!: () => void
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { observed = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    let inspections = 0
    fake.ignoreReadCancellation = true
    fake.holdStatusFor = (session) => {
      if (session === previous && ++inspections === 2) { observed(); return held }
    }
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    const recovery = fake.clock.advance(0)
    await waiting
    await $.session.end(sessionEnd(previous))
    fake.session = 'replacement-session'
    const replacement = { ...binding, session: fake.session, owner: fake.session }
    fake.store.set(`session:${fake.session}`, replacement)
    await $.session.start({ ...sessionStart, cwd: fake.cwd })
    await fake.clock.advance(0)
    const watch = fake.live()!
    const commands = fake.operations().length
    release()
    await recovery
    expect(fake.session).toBe('replacement-session')
    expect(fake.live()).toBe(watch)
    expect(watch.closed).toBe(false)
    expect(fake.store.get(`session:${fake.session}`)).toMatchObject({ thread: fake.threadId, joined: true, owner: fake.session })
    expect(fake.store.get(`session:${previous}`)).toMatchObject(binding)
    expect(fake.sessionCommands.slice(0, transitions.length)).toEqual(transitions)
    expect(fake.operations().length).toBe(commands)
    expect(fake.rows).toEqual([])
    fake.holdStatusFor = undefined
    expect((await $.prompt.submit(prompt('replacement remains ready'))).drop).toBeUndefined()
    await $.session.end(sessionEnd(fake.session))
  })

  test('a session replacement during preflight capability inspection cannot mount or change the replacement cwd', async ($, on) => {
    const fake = sharedThread(on, $)
    await $.session.start(sessionStart)
    let observed!: () => void
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { observed = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    fake.holdCommandListFor = () => { observed(); return held }
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    const transition = fake.clock.advance(0)
    await waiting
    const fresh = fake.session
    await $.session.end(sessionEnd(fresh))
    fake.session = 'replacement-session'
    fake.cwd = '/replacement'
    await $.session.start({ ...sessionStart, cwd: fake.cwd })
    release()
    await transition
    expect(fake.sessionCommands).toEqual([])
    expect(fake.operations()).not.toContain('mount')
    expect(fake.store.has(`session:${fresh}`)).toBe(false)
    expect(fake.cwd).toBe('/replacement')
    expect(fake.store.has('session:replacement-session')).toBe(false)
    expect(fake.watches).toEqual([])
    expect(fake.rows).toEqual([])
    await $.session.end(sessionEnd(fake.session))
  })

  test('ending the fresh session during status cannot bind, watch, or add rows to its replacement', async ($, on) => {
    const fake = sharedThread(on, $)
    fake.upsert(remoteItem('Must not enter a replacement session'))
    await $.session.start(sessionStart)
    let observed!: () => void
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { observed = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    fake.holdStatusFor = (session) => {
      if (session.endsWith('-fresh')) { observed(); return held }
    }
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    const transition = fake.clock.advance(0)
    await waiting
    const fresh = fake.session
    await $.session.end(sessionEnd(fresh))
    fake.session = 'replacement-session'
    fake.cwd = '/replacement'
    await $.session.start({ ...sessionStart, cwd: fake.cwd })
    release()
    await transition
    expect(fake.store.get(`session:${fresh}`)).toMatchObject({ snapshot: false, joinTransition: { locator: link(fake) } })
    expect(fake.store.has('session:replacement-session')).toBe(false)
    expect(fake.watches).toEqual([])
    expect(fake.rows).toEqual([])
    expect(fake.cwd).toBe('/replacement')
    expect(fake.logs.some((line) => line.startsWith('Joined Delta in fresh'))).toBe(false)
    await $.session.end(sessionEnd(fake.session))
  })

  test('an incompatible recording contract refuses join before any transition, mount, or clear', async ($, on) => {
    const fake = sharedThread(on, $)
    await $.session.start(sessionStart)
    fake.contractRange = { min: 0, max: 0 }
    const previous = fake.session
    await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
    await finishJoin(fake)
    expect(fake.logs.join('\n')).toContain('Update Delta')
    expect(fake.session).toBe(previous)
    expect(fake.sessionCommands).toEqual([])
    expect(fake.operations()).not.toContain('mount')
    expect(fake.store.has(`session:${fake.session}`)).toBe(false)
    expect(fake.watches).toEqual([])
    await $.session.end(sessionEnd(fake.session))
  })

})

const REFERENCE = '00000000-0000-4000-8000-000000000001#t=0'

function sharedThread(on: Parameters<typeof fakeThreads>[0], engine: Engine, options: Parameters<typeof fakeThreads>[1] = {}) {
  const fake = fakeThreads(on, options)
  fake.endSession = (session) => engine.session.end({ ...sessionEnd(session), reason: 'clear' })
  fake.server.thread = fake.threadId
  fake.server.shared = true
  fake.server.checkout = 'attached'
  fake.server.mount = { thread: fake.threadId, directory: CHECKOUT, reference: REFERENCE }
  fake.server.worktrees = [{ reference: REFERENCE, name: 'delta' }]
  scriptMounts(fake, ['delta'], (owner) => `${MOUNTS}/${owner}/delta`)
  return fake
}

/** Explicit scenario responses, not the daemon's worktree placement algorithm. */
function scriptMounts(fake: ReturnType<typeof fakeThreads>, names: string[], directory: (owner: string) => string) {
  fake.mountReply = (owner) => {
    const worktrees = names.map((name) => ({
      reference: name === 'delta' ? REFERENCE : `${name}-history#t=0`,
      name, directory: `${MOUNTS}/${owner}/${name}`, state: 'mounted',
    }))
    fake.worktreeItems = worktrees.map((tree) => ({
      reference: tree.reference, checkouts: [
        ...(tree.reference === REFERENCE ? [{ directory: CHECKOUT, state: 'attached' as const }] : []),
        { directory: tree.directory, state: 'detached' as const, active: true },
      ],
    }))
    return cliFixture('mount', { thread_id: fake.threadId, owner, directory: directory(owner), worktrees })
  }
}

function link(fake: ReturnType<typeof fakeThreads>) { return `https://delta.dev/join/${fake.shareId}` }

/** A Desktop Code tab, worktree or not, joining a thread Delta titles "Fix the parser". */
function desktopTab(on: Parameters<typeof fakeThreads>[0], engine: Engine) {
  const fake = sharedThread(on, engine)
  desktopHost(fake)
  fake.statusPatch = { title: 'Fix the parser' }
  scriptMounts(fake, ['delta'], (owner) => owner.startsWith('desktop-') ? `${FOLDERS}/${owner}` : `${MOUNTS}/${owner}/delta`)
  return fake
}

/** Run `/delta join` in a Desktop tab and return the hand-off it offered. */
async function offerFromDesktopTab($: Engine, fake: ReturnType<typeof fakeThreads>) {
  await $.session.start({ ...sessionStart, surface: 'desktop' })
  await $.command.run({ ...shareCommand, args: `join ${link(fake)}` })
  await finishJoin(fake)
  const owner = fake.mountRequests[0]!.owner
  expect(owner).toMatch(/^desktop-/)
  return { owner, folder: `${FOLDERS}/${owner}`, record: `${CONFIG}/delta-plugin/handoffs/${owner}.json` }
}

/** The session Desktop starts in the thread folder from the link, once the opening line is sent. */
async function startInThreadFolder($: Engine, fake: ReturnType<typeof fakeThreads>, folder: string) {
  fake.session = 'opened-from-link'
  fake.cwd = folder
  await $.session.start({ ...sessionStart, surface: 'desktop', cwd: folder })
}

/** One Claude turn as the engine runs it: the prompt's row, the turn, the reply's row. */
async function oneTurn($: Engine, turnId: string, text: string, answer: string) {
  await $.turn.start(turnStart(turnId, text))
  await $.session.append({ door: 'prompt', uuid: `${turnId}-prompt`, message: { type: 'user', role: 'user', content: text } } as never)
  await $.session.append({ door: 'response', uuid: `${turnId}-answer`,
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: answer }] } } as never)
  await $.turn.complete({ ...turnComplete(turnId), answer })
}

/** Claude Code Desktop, which has no `/cd`. */
function desktopHost(fake: ReturnType<typeof fakeThreads>) {
  fake.surfaces = ['desktop']
  fake.builtins = ['clear']
}

/** The status band as JSON text, which is how a test reads what it draws. */
async function bandText($: Engine) {
  return JSON.stringify(await $.ui.render(abovePrompt))
}

async function finishJoin(fake: ReturnType<typeof fakeThreads>) { await fake.clock.advance(0) }
