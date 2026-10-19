/** CLI boundary fixture and Claude host; watching never creates, mounts, or publishes. */
import { expect, mock, type MockClock, type Plugin, type TestRest } from 'claude-code/testing'
import type { ApiMessage, ConfigRow, On, ProcessRunResult } from 'claude-code'
import type { ThreadState, ThreadUser, WatchChild, WatchComment, WatchItem } from './thread-commands'
import { cliErrorCodes, cliFixture } from './cli-fixtures'

export type Envelope = {
  schemaVersion: 1
  sequence: number
  update?: Record<string, any>
  turnSequence?: number
}
export type Disposition = 'recorded' | 'fenced' | 'duplicate'
export type TurnState = { sequence: number; status: 'running' | 'finished' | 'superseded' }
export type Accepted = { line: string; envelope: Envelope; disposition: Disposition; version: string }
export type AppendFault = {
  disposition?: Disposition
  frames?: Record<string, unknown>[]
  /** Accept and acknowledge only this many leading records. */
  accept?: number
  exitCode?: number
  stderr?: string
  /** Accept every record durably, then lose the whole response. */
  throwAfterAccept?: boolean
  /** Rewrite each acknowledgment line the CLI prints. */
  ack?: (ack: Record<string, any>) => Record<string, any>
  /** Change response formatting without changing the accepted operations. */
  stdout?: (stdout: string) => string
}
type WatchOutput = { kind: 'text'; stream: 'stdout' | 'stderr'; text: string } |
  { kind: 'exit'; result: { code: number | null; signal: string | null } }
export type Watch = {
  argv: string[]; ready: boolean; closed: boolean
  write(text: string, stream?: 'stdout' | 'stderr'): void
  frame(value: unknown): void
  exit(code?: number | null): void
  observe(): boolean
  take(signal: AbortSignal): Promise<WatchOutput>
}

/** One row a `session.append` implementation stored, as the plugin's hook passed it down. */
export type AppendedRow = {
  door: string
  type: string
  name?: string
  role?: string
  isMeta?: true
  origin: unknown
  content: readonly { type: string; text?: string }[]
}

export const CHECKOUT = '/repo'
export const CONFIG = '/sandbox/config'
/** Where the fake host mounts a joiner's worktrees, and the thread folders that hold links to several. */
export const MOUNTS = '/mounts'
export const FOLDERS = '/thread-folders'

/** The fixture has one virtual root; Windows hosts qualify its slash-led paths with a drive. */
function fixturePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^[a-z]:/i, '')
}

/** Apply the same host-path translation to test setup, assertions, and filesystem hooks. */
class FixtureFiles extends Map<string, string> {
  override set(path: string, text: string): this { return super.set(fixturePath(path), text) }
  override get(path: string): string | undefined { return super.get(fixturePath(path)) }
  override has(path: string): boolean { return super.has(fixturePath(path)) }
  override delete(path: string): boolean { return super.delete(fixturePath(path)) }
}

export const sessionStart = { surface: 'terminal', isInteractive: true, cwd: CHECKOUT } as const
export const shareCommand = {
  command: 'delta', args: 'share', origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as const
/** The band above the prompt: the hook context the plugin draws its status and queued message rows in. */
export const abovePrompt = {
  component: 'AbovePrompt', requestId: 'above-prompt', surface: 'terminal',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const
/** The band's mark while the watch is live: the band draws it however its other parts change. */
export const LIVE = JSON.stringify({ type: 'Text', props: { color: 'green' }, children: ['●'] })
/** The band's mark while it connects, or reconnects past a drop's grace. */
export const PENDING = JSON.stringify({ type: 'Text', props: { color: 'yellow' }, children: ['◌'] })
/** The row a slash command printed, under its echo, as the host raises it for its hook. */
export function commandOutput(args: string, text: string, command = 'delta', columns?: number) {
  return {
    component: 'CommandOutput', requestId: `command-${args}`, surface: 'terminal',
    ...columns === undefined ? {} : { viewport: { columns, rows: 40, isFullscreen: false } },
    props: { command, args, text, isErrored: false },
  } as const
}

/** The caveat the engine stores above every command run, which the person never sees as typed. */
export const localCommandCaveat =
  '<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a ' +
  "request, and its output goes straight to the user. It's recorded here as context for later " +
  'messages.</local-command-caveat>'

/**
 * One run of `/<command> <args>` as the engine stores it, in the order it appends the rows: the
 * caveat, the echo naming the command and the arguments it had, and the output row wrapping what
 * the command answered under the plugin that raised it. `origin` is the run's, as `command.run`
 * reads it: the plugin's own for a plugin's internal call, the person's for their typed one.
 */
export function commandRunRows(command: string, args: string, answer: string,
    origin: { kind: string; name?: string }) {
  return [
    { door: 'command', origin,
      message: { type: 'user', role: 'user', isMeta: true,
        content: [{ type: 'text', text: localCommandCaveat }] },
      uuid: `${command}-${args}-caveat` },
    { door: 'command', origin,
      message: { type: 'user', role: 'user', content: [{ type: 'text',
        text: `<command-name>/${command}</command-name>\n            ` +
          `<command-message>${command}</command-message>\n            ` +
          `<command-args>${args}</command-args>` }] },
      uuid: `${command}-${args}-echo` },
    { door: 'command', origin: { kind: 'engine' },
      message: { type: 'system', name: 'local_command', role: 'user',
        content: [{ type: 'text', text: `<local-command-stdout>${origin.name ?? command}: ${answer}</local-command-stdout>` }] },
      uuid: `${command}-${args}-output` },
  ] as const
}
/** A command the person typed, with the origin and presentation the engine stamps on it. */
export function typedDelta(args: string) {
  return {
    command: 'delta', args, origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  } as const
}

export function sessionEnd(sessionId: string) {
  return { reason: 'other', sessionId, resume: { id: sessionId } } as const
}
export function prompt(text: string, turnId?: string) {
  return { text, wait: false, origin: { kind: 'composer' }, ...(turnId ? { turnId } : {}) } as const
}
export function turnStart(turnId: string, text = '') {
  return { text, turnId }
}
export function turnComplete(turnId: string, reason: 'answer' | 'aborted' = 'answer') {
  return { turnId, answer: '', durationMs: 1, isAborted: reason === 'aborted', reason } as const
}
export function bash(toolUseId: string, command: string) {
  return { tool: 'Bash', tool_use_id: toolUseId, command } as const
}
export const ADA: ThreadUser = { user_id: 'user-ada', name: 'Ada' }
let items = 0
/** A completed remote item; override any field. */
export function remoteItem(text: string, fields: Partial<WatchItem> = {}): WatchItem {
  return {
    ...cliFixture('item').item, id: `item-${++items}`, kind: 'user_message', after_id: null, turn_id: null,
    author: ADA, created_at: 1_759_700_000_000, open: false, content: { text }, ...fields,
  }
}

let comments = 0
/** A delivered comment by Ada on a passage of the transcript; override any field. */
export function remoteComment(text: string, fields: Partial<WatchComment> = {}): WatchComment {
  const id = fields.id ?? `comment-${++comments}`
  return {
    id, chain: id, after_id: null, delivered_with: 'item-delivering', routed_to: null, author: ADA, co_authors: [],
    agent: false, created_at: 1_759_700_000_000, text, target: { kind: 'transcript', item_id: null, quote: 'the parser' },
    ...fields,
  }
}

let sessions = 0

/**
 * A plugin loaded beside the one under test, which holds one clock wait for the whole test.
 *
 * The kit's mock clock steps by asking the host to settle, and with a host call still open and
 * nothing happening the host waits out a real 500 ms with no progress. A live `thread watch`
 * stream is such a call for the whole run, so every clock step in these tests would cost that. The
 * kit answers a wait with a hook of its own, and the host stops waiting while a hook of the test's
 * runs, so a held wait is what makes the step immediate. The kit lets a wait go once it outruns a
 * hook's budget (ten seconds), past which a longer test pays the budget again.
 */
export const heldClockWait: Plugin = {
  name: 'held-clock-wait',
  register(on) {
    on('session.start', async ($, e, next) => {
      // Self-contained on purpose: the kit re-evaluates this source outside the module, so only
      // what the text itself names exists here.
      void $.clock.after(1_000_000_000, () => undefined)
      return next(e)
    })
  },
}

/** `test`, with {@link heldClockWait} loaded beside the plugin under test for every case. */
export function testsWithHeldClockWait(test: (name: string, ...rest: TestRest) => void) {
  return (name: string, ...rest: TestRest) => {
    const options = rest.length === 2 ? rest[0] : {}
    const body = rest.length === 2 ? rest[1] : rest[0]
    test(name, { ...options, plugins: [heldClockWait, ...(options.plugins ?? [])] }, body)
  }
}

/**
 * Installs thread command responses, host, filesystem, and store beneath the plugin.
 *
 * Tests change behavior through the returned object's mutable fields rather
 * than registering competing hooks for the same events.
 */
export function fakeThreads(on: On, options: {
  session?: string
  thread?: string
  messages?: ApiMessage[]
  env?: Record<string, string>
} = {}) {
  const session = options.session ?? `session-${++sessions}`
  /** Waiters for `waitForLog`; the `ui.log` hook answers them as matching lines arrive. */
  const logWaiters: { start: number; match: (log: string) => boolean; resolve: (log: string) => void }[] = []
  /** Waiters for a share link, which the plugin writes only to the debug log. */
  const linkWaiters: ((url: string) => void)[] = []
  const fake = {
    session,
    cwd: CHECKOUT,
    pluginVersion: '0.1.1',
    cliIntegrations: [] as { operation: string; integration?: string; commandForm?: string }[],
    surfaces: ['terminal'] as ('terminal' | 'desktop')[],
    builtins: ['clear', 'cd'],
    sessionCommands: [] as { command: string; args: string }[],
    refuseClear: false,
    refuseCd: false,
    /** Every link the plugin opened with `open`, such as Desktop's new-session link. */
    opened: [] as string[],
    /** `open` fails, as it does where there is no macOS `open` to run. */
    failOpen: false,
    /** Each `thread mount` the plugin asked for, including its independent folder and join flags. */
    mountRequests: [] as { owner: string; folder: boolean; join: boolean }[],
    holdCommandListFor: undefined as ((session: string) => Promise<void> | undefined) | undefined,
    root: undefined as string | undefined,
    agents: [] as { id: string; description: string; type: string; status: string }[],
    endSession: undefined as ((session: string) => Promise<unknown>) | undefined,
    clock: mock.clock(on) as MockClock,
    store: new Map<string, unknown>(),
    files: new FixtureFiles(),
    commands: [] as string[][],
    watches: [] as Watch[],
    statusProcesses: [] as { closed: boolean; emittedBytes: number }[],
    violations: [] as string[],
    /** Shared state survives watcher restarts, which have no write effects. */
    server: {
      thread: undefined as string | undefined,
      next: 1,
      records: new Map<number, Accepted>(),
      turn: undefined as TurnState | undefined,
      version: 0,
      checkout: 'missing' as 'attached' | 'inactive' | 'detached' | 'missing',
      /** The sharer's own checkout, attached to the thread; a joiner's mounts are separate. */
      mount: undefined as { thread: string; directory: string; reference: string } | undefined,
      /** The worktrees attached to the thread, in attachment order; `thread mount` places each one. */
      worktrees: undefined as { reference: string; name: string }[] | undefined,
      /** The mounted checkouts of each owner that asked for them, and the directory each was told to work in. */
      groups: new Map<string, { directory: string; mounts: Map<string, { name: string; directory: string; active: boolean }> }>(),
      shared: false,
      /** Every address `thread invite` sent, in order. */
      invited: [] as string[],
      /** The upload intent `thread create` recorded, before or after the thread registers with the cloud. */
      upload: undefined as { organization: string; visibility: 'private' | 'organization' } | undefined,
      /** Whether Delta has registered the thread with the cloud, which upgrades local-only access. */
      registered: false,
      /** Whether status names the upload's organization; real CLIs have reported null for a thread created with one. */
      reportsOrganization: true,
      /** Whether Delta has confirmed the thread's content upload; only then is `upload.state` `uploaded`. */
      confirmed: false,
      /** A failure reason Delta reports for the thread's background upload, replacing any success. */
      uploadFailure: undefined as string | undefined,
      /** The thread's items as other clients recorded them; this producer's own are never watched. */
      items: new Map<string, WatchItem>(),
      /** The thread's delivered comments, which a snapshot sends after the items. */
      comments: new Map<string, WatchComment>(),
      children: [] as WatchChild[],
    },
    threadId: options.thread ?? `thread-for-${session}`,
    shareId: `thread_cloud-${session}`,
    /** Holds every watch's `live` event, after its snapshot items, until it settles. */
    holdLive: undefined as Promise<void> | undefined,
    /** Child discovery is independent of parent transcript readiness. */
    holdChildren: undefined as Promise<void> | undefined,
    holdStatus: undefined as Promise<void> | undefined,
    holdStatusFor: undefined as ((session: string) => Promise<void> | undefined) | undefined,
    ignoreReadCancellation: false,
    /** API export used by the initial share. */
    messages: options.messages ?? [] as ApiMessage[],
    toolResult: { stdout: 'tool output', stderr: '', interrupted: false } as unknown,
    exports: 0,
    appendFaults: [] as AppendFault[],
    /** Every append fails before accepting anything until cleared. */
    appendOffline: false,
    /** The server refuses the thread's recorded changes until the person forks them into a kept thread or discards them. */
    refusedChanges: undefined as { fork?: string } | undefined,
    appendCalls: 0,
    /** Patches every ready frame, e.g. to simulate a different conversation. */
    readyPatch: undefined as Record<string, unknown> | undefined,
    statusPatch: undefined as Record<string, unknown> | undefined,
    worktreeItems: undefined as Extract<ThreadState['worktrees'], { status: 'available' }>['items'] | undefined,
    mountReply: undefined as ((owner: string) => Record<string, any>) | undefined,
    attachmentPatch: undefined as Record<string, unknown> | undefined,
    mountPatch: undefined as Record<string, unknown> | undefined,
    /** Every `thread unmount` the plugin asked for. */
    unmounts: [] as { thread: string; owner: string }[],
    publicationPatch: undefined as Record<string, unknown> | undefined,
    /** Addresses `thread invite` reports as failed, with the reason it gives. */
    inviteFailures: {} as Record<string, string>,
    /** Replaces the default watch readiness and snapshot. */
    onWatch: undefined as ((watch: Watch, index: number) => void) | undefined,
    commandFault: undefined as { operation: string; message: string; code?: string; reason?: string; retryable?: boolean; after?: boolean; exitCode?: number } | undefined,
    /** The recording-contract range `thread contract` reports; overrides the fixture's `{min:1,max:6}`. */
    contractRange: undefined as { min?: number; max?: number } | undefined,
    /** Answers `thread contract` like a CLI that predates it: clap error on stderr, exit 2, no JSON. */
    contractUnknownSubcommand: false,
    /** Every `thread contract` the plugin asked for, counted apart from the recording commands. */
    contractChecks: 0,
    authCalls: [] as string[][],
    authReplies: [] as { status: string; [key: string]: unknown }[],
    holdAuth: undefined as Promise<void> | undefined,
    authWaitClosed: false,
    organizationResult: { stdout: '', stderr: '', exitCode: 0, isStdoutTruncated: false, isStderrTruncated: false },
    cliMissing: false,
    cliSetups: [] as string[],
    holdCliSetup: undefined as ((install: boolean) => Promise<void> | undefined) | undefined,
    holdCliResolution: undefined as (() => Promise<void> | undefined) | undefined,
    /** Reading a transcript from an offset cannot start, as without `tail` or a usable PowerShell. */
    failTranscriptRead: false,
    failWrite: false,
    /** `git rev-parse` fails, as outside a checkout. */
    failGit: false,
    /** The organizations `delta --json org list` reports. */
    organizations: undefined as { id: string; name: string; current: boolean }[] | undefined,
    /** `delta --json org list` fails with a typed error envelope. */
    failOrgList: false,
    /** What `git rev-parse --show-toplevel` reports, so a test can simulate a linked worktree. */
    checkoutRoot: CHECKOUT,
    /** What `git rev-parse --git-common-dir` reports, shared by worktrees. */
    gitCommonDir: `${CHECKOUT}/.git`,
    failStoreSet: false as boolean | (() => boolean),
    failRemoval: false,
    holdListing: undefined as Promise<void> | undefined,
    /** Pauses `process.run` for the named operations, so a test can read the band mid-step. */
    holdRun: undefined as ((operation: string | undefined) => Promise<void> | undefined) | undefined,
    /** Pauses the initial API export, between its fetch and its staging. */
    holdExport: undefined as Promise<void> | undefined,
    /** Pauses a native session command, such as join's `/clear` and `/cd`. */
    holdSessionCommand: undefined as ((command: string) => Promise<void> | undefined) | undefined,
    holdStoreGet: undefined as ((key: string) => Promise<void> | undefined) | undefined,
    holdTool: undefined as Promise<void> | undefined,
    holdAppend: undefined as Promise<void> | undefined,
    holdAbort: undefined as Promise<void> | undefined,
    refusePrompt: undefined as string | undefined,
    entered: [] as { text: string; context?: readonly string[]; turnId?: string }[],
    aborts: [] as string[],
    statuses: [] as (string | undefined)[],
    logs: [] as string[],
    /** Every `AskUserQuestion` the plugin asked, and the answer it receives. */
    answerQuestion: undefined as ((question: any) => unknown) | undefined,
    questions: [] as any[],
    /** Every redraw the plugin asked for, including the band animation's timer. */
    invalidates: 0,
    /** The first line of each row the plugin tried to add to Claude's transcript, from its debug log. */
    rows: [] as string[],
    /** Every run of the plugin's own command that reached the host instead of the plugin. */
    commandRuns: [] as { command: string; args: string }[],
    /** Every row passed down to `session.append` after the plugin's own hook rewrote it: what the model receives. */
    stored: [] as AppendedRow[],

    state(): ThreadState & { worktrees: Extract<ThreadState['worktrees'], { status: 'available' }> } {
      const thread = fake.server.thread!
      const shared = fake.server.shared
      const upload = fake.server.upload
      return {
        ...cliFixture('status'),
        thread_id: thread,
        url: shared || fake.server.registered ? urlOf() : null,
        access: {
          state: shared || fake.server.registered ? 'granted' : 'local_only',
          is_owner: shared || fake.server.registered ? true : null,
        },
        visibility: shared ? 'organization' : upload && fake.server.registered ? upload.visibility : null,
        upload: upload ? {
          state: fake.server.uploadFailure ? 'failed'
            : fake.server.confirmed ? 'uploaded'
              : fake.server.registered ? 'uploading' : 'queued',
          organization_id: fake.server.reportsOrganization ? upload.organization : null,
          error: fake.server.uploadFailure
            ? { code: 'upload_failed', reason: 'upload_failed', message: fake.server.uploadFailure }
            : null,
        } : null,
        worktrees: { status: 'available', items: fake.worktreeItems ?? (fake.server.mount ? [{
          reference: fake.server.mount.reference,
          checkouts: [{ directory: fake.server.mount.directory, state: fake.server.checkout }],
        }] : []) },
        producer: { source: 'claude-code', external_id: fake.session, next_sequence: fake.server.next,
          turn: fake.server.turn ? { ...fake.server.turn } : null },
      }
    },

    /** Accepted envelopes in sequence order. */
    records(): Envelope[] {
      return [...fake.server.records.keys()].sort((a, b) => a - b).map((sequence) => fake.server.records.get(sequence)!.envelope)
    },
    updates(): Envelope[] { return fake.records().filter((record) => record.update) },
    starts(): number[] {
      return fake.records().filter((record) => record.turnSequence === record.sequence &&
        record.update?.sessionUpdate === 'state_update' && record.update.state === 'running').map((record) => record.sequence)
    },
    finishes(): number[] {
      return fake.records().flatMap((record) => record.turnSequence !== undefined &&
        record.update?.sessionUpdate === 'state_update' && record.update.state === 'idle' ? [record.turnSequence] : [])
    },
    delta(): string[][] { return fake.commands.filter((argv) => argv[0] === '/selected/delta') },
    operations(): (string | undefined)[] { return fake.delta().map((argv) => cliArguments(argv)?.positionals[1]) },
    /** The `--producer-name` each `append` passed, in order; undefined where it passed none. */
    producerNames(): (string | undefined)[] {
      return fake.delta().map(cliArguments).filter((parsed) => parsed?.positionals[1] === 'append')
        .map((parsed) => parsed!.options['--producer-name'] as string | undefined)
    },
    live(): Watch | undefined { return fake.watches.findLast((watch) => !watch.closed) },
    /** Another client records or changes an item; a live watch sees the whole item. */
    upsert(item: WatchItem) {
      fake.server.items.set(item.id, item)
      fake.live()?.frame(cliFixture('item', { item }))
    },
    /** Another client streams more text into an open item. */
    stream(id: string, text: string) {
      const item = fake.server.items.get(id)!
      fake.server.items.set(id, { ...item, content: { ...item.content, text: `${item.content.text ?? ''}${text}` } })
      fake.live()?.frame(cliFixture('itemAppend', { id, text }))
    },
    remove(id: string) {
      fake.server.items.delete(id)
      fake.live()?.frame(cliFixture('remove', { id }))
    },
    /** A comment is delivered, or changes; a live watch sees the whole comment. */
    comment(comment: WatchComment) {
      fake.server.comments.set(comment.id, comment)
      fake.live()?.frame(cliFixture('comment', { comment }))
    },
    removeComment(id: string) {
      fake.server.comments.delete(id)
      fake.live()?.frame(cliFixture('commentRemove', { id }))
    },
    /** The thread's generation state, as every client sees it. */
    turn(state: 'idle' | 'running', user: ThreadUser | null = ADA, turnId: string | null = 'remote-turn') {
      fake.live()?.frame(cliFixture('turn', { state, turn_id: state === 'running' ? turnId : null, user: state === 'running' ? user : null }))
    },
    presence(users: ThreadUser[]) { fake.live()?.frame(cliFixture('presence', { users })) },
    child(child: WatchChild) {
      const index = fake.server.children.findIndex((entry) => entry.thread_id === child.thread_id)
      if (index < 0) fake.server.children.push(child)
      else fake.server.children[index] = child
      fake.live()?.frame({ type: 'child', child })
    },
    removeChild(thread_id: string) {
      fake.server.children = fake.server.children.filter((child) => child.thread_id !== thread_id)
      fake.live()?.frame({ type: 'child.remove', thread_id })
    },
    /** Another Delta client takes the turn away from the current owner. */
    supersede(): number {
      const sequence = fake.starts().at(-1)
      if (sequence === undefined) throw new Error('Script a recorded start before supersession')
      fake.server.turn = { sequence, status: 'superseded' }
      fake.live()?.frame(cliFixture('producerTurn', { sequence, status: 'superseded' }))
      fake.turn('running', ADA, 'takeover-turn')
      return sequence
    },
    /** The competing remote turn finished. */
    releaseRemote() {
      fake.turn('idle')
    },
    waitForShareLink(): Promise<string> {
      return new Promise<string>((resolve) => { linkWaiters.push(resolve) })
    },
    async share($: { command: { run: (input: typeof shareCommand) => Promise<{ text?: string }> } }): Promise<string> {
      const start = fake.logs.length
      const result = await $.command.run(shareCommand)
      // Any text is a refusal before the background share starts; a started share shows none.
      if (result.text !== undefined) return result.text
      // `/delta share` returns at once and runs on the clock; drive it, then await its outcome:
      // a failure in the transcript, or the link the band shows, which only the debug log names.
      const link = fake.waitForShareLink()
      await fake.clock.advance(0)
      return Promise.race([fake.waitForLog(start, (log) => log.startsWith('Delta sharing failed')), link])
    },
    /** Script an attachment event; tests separately script the daemon's next mount answer. */
    addWorktree(name: string, reference = `${name}-history#t=0`) {
      fake.server.worktrees = [...fake.server.worktrees ?? [], { reference, name }]
      announceWorktrees()
    },
    removeWorktree(name: string) {
      fake.server.worktrees = fake.server.worktrees!.filter((tree) => tree.name !== name)
      announceWorktrees()
    },
    expectClean() { expect(fake.violations).toEqual([]) },
    /**
     * Settle the clock until `done` holds; the test's timeout bounds the wait. One settle can return
     * while a chain of host calls (a contract check, a status read, then an append) is still between
     * steps on a loaded machine, and any fixed number of settles can run out first.
     */
    async settleUntil(done: () => boolean) {
      while (!done()) await fake.clock.settle()
    },
    /** Resolves with the first log at or after `start` that `match` accepts, now or later. */
    waitForLog(start: number, match: (log: string) => boolean): Promise<string> {
      const found = fake.logs.slice(start).find(match)
      if (found !== undefined) return Promise.resolve(found)
      return new Promise((resolve) => { logWaiters.push({ start, match, resolve }) })
    },
  }

  mock.env(((event, handler) => {
    if (event === 'env.get') on(event, async ($, e, next) => {
      await fake.holdCliResolution?.()
      return handler($, e, next)
    })
    else on(event, handler)
  }) as On, { CLAUDE_CONFIG_DIR: CONFIG, HOME: '/sandbox', ...options.env })
  // The kit's bottom stores each row; this records it as the plugin's own hook passed it down.
  on('session.append', ($, e, next) => {
    fake.stored.push({
      door: e.door, type: e.message.type, name: e.message.name, role: e.message.role,
      isMeta: e.message.isMeta, origin: e.origin, content: [...e.message.content],
    } as AppendedRow)
    return next(e)
  })
  on('store.get', async ($, e) => {
    const hold = fake.holdStoreGet?.(e.key)
    if (hold) await hold
    return { value: fake.store.get(e.key) as any }
  })
  on('store.set', ($, e) => {
    if (typeof fake.failStoreSet === 'function' ? fake.failStoreSet() : fake.failStoreSet)
      throw new Error('store unavailable')
    fake.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => { fake.store.delete(e.key); return { value: undefined } })
  // Only a Claude build that exposes `$.store.keys` can bound the store; registering the handler is
  // harmless when the running kit does not know the event.
  try { on('store.keys', () => ({ value: [...fake.store.keys()] })) } catch {}
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: fake.session }))
  on('session.cwd', () => ({ value: fake.cwd }))
  on('session.root', () => ({ value: fake.root ?? fake.cwd }))
  on('session.surfaces', () => ({ value: fake.surfaces }))
  on('agent.list', () => ({ value: fake.agents }))
  on('command.list', async () => {
    await fake.holdCommandListFor?.(fake.session)
    return { value: fake.builtins.map((name) => ({ name, description: name, source: 'builtin' as const })) }
  })
  on('command.run', async ($, e) => {
    // The plugin answers its own command; this stands in when its hook does not.
    if (e.command === 'delta') {
      fake.commandRuns.push({ command: e.command, args: e.args })
      return { text: 'the test host answered /delta' }
    }
    fake.sessionCommands.push({ command: e.command, args: e.args })
    const hold = await fake.holdSessionCommand?.(e.command)
    if (hold) await hold
    if (e.command === 'clear' && !fake.refuseClear) {
      await fake.endSession?.(fake.session)
      fake.session = `${fake.session}-fresh`
    } else if (e.command === 'cd' && !fake.refuseCd) fake.cwd = e.args
    else if (!['clear', 'cd'].includes(e.command)) throw new Error(`Unexpected fixture session command ${e.command}`)
    return {}
  })
  // The settings menu's rows, of which the band reads the theme for its status bar's shade.
  on('config.list', () => {
    const theme: ConfigRow = { key: 'theme', label: 'Theme', kind: 'choice', value: 'dark',
      provider: { plugin: 'engine', tier: 'core' }, isLocked: false }
    return { value: [theme] }
  })
  on('session.messages', async ($, e) => {
    if (e.as !== 'api') return { value: [] }
    if (fake.holdExport) await fake.holdExport
    fake.exports++
    return { value: fake.messages }
  })
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'Compacted summary', toolUses: [] }] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.invalidate', () => { fake.invalidates++; return { value: undefined } })
  // The host draws these sites itself when the plugin passes them on unchanged.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['the band'] }))
  on('ui.render', { component: 'CommandOutput' }, ($, e) =>
    ({ type: 'Text', props: {}, children: [`the output row: ${e.props.text}`] }))
  on('ui.status', ($, e) => { fake.statuses.push(e.text); return { value: undefined } })
  on('ui.log', ($, e) => {
    // Claude drops a log whose destination is anything else, so the person never sees it.
    if (e.to !== undefined && e.to !== 'transcript' && e.to !== 'debug')
      fake.violations.push(`ui.log with an invalid destination ${JSON.stringify(e.to)}: ${e.text}`)
    const row = /^Adding a row to Claude's context: (.*)$/s.exec(e.text)
    if (e.to !== 'debug') fake.logs.push(e.text)
    else if (row) fake.rows.push(row[1]!)
    const shared = e.to === 'debug' ? /^Delta share link: (.*)$/.exec(e.text) : null
    if (shared) for (const resolve of linkWaiters.splice(0)) resolve(shared[1]!)
    if (e.to !== 'debug') {
      const index = fake.logs.length - 1
      for (let position = logWaiters.length - 1; position >= 0; position--) {
        const waiter = logWaiters[position]!
        if (index >= waiter.start && waiter.match(e.text)) {
          logWaiters.splice(position, 1)
          waiter.resolve(e.text)
        }
      }
    }
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    fake.entered.push({ text: e.text, context: e.context, turnId: e.turnId })
    return fake.refusePrompt ? { drop: fake.refusePrompt } : { text: e.text, context: e.context }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.abort', async ($, e) => {
    fake.aborts.push(e.turnId)
    if (fake.holdAbort) await fake.holdAbort
    return { value: undefined }
  })
  on('tool.call', async ($, e) => {
    // Joining asks nothing of its own; Claude's folder trust prompt is the only question.
    if (e.tool === 'AskUserQuestion') {
      fake.questions.push(e)
      // A test answers the dialog through `answerQuestion`; otherwise it is dismissed, as a person
      // who closes the prompt would.
      const answer = fake.answerQuestion?.(e as never)
      if (answer !== undefined) return answer as never
      // `/delta share` asks who should see the session; unless a test answers, it takes the first
      // option, sharing with the organization as the command did before it asked.
      const question = (e as any).input?.questions?.[0] ?? (e as any).questions?.[0]
      if (question?.question?.startsWith('Who should see this session?'))
        return { result: { answers: { [question.question]: question.options[0].label } } } as never
      return { deny: 'the person dismissed the question' } as never
    }
    if (fake.holdTool) await fake.holdTool
    return { result: fake.toolResult } as any
  })
  on('fs.write', ($, e) => {
    if (fake.failWrite) throw new Error('disk full')
    fake.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const value = fake.files.get(e.path) ??
      (e.path.endsWith('/.claude-plugin/plugin.json') ? JSON.stringify({ version: fake.pluginVersion }) : undefined)
    if (value === undefined) throw new Error(`Missing fixture file: ${e.path}`)
    return { value }
  })
  on('fs.stat', ($, e) => {
    const text = fake.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file' as const, size: new TextEncoder().encode(text).byteLength, mtimeMs: 0, isLink: false } }
  })
  on('fs.exists', ($, e) => ({ value: [...fake.files.keys()].some((path) =>
    path === fixturePath(e.path) || path.startsWith(`${fixturePath(e.path)}/`)) }))
  on('fs.list', async ($, e) => {
    if (fake.holdListing) await fake.holdListing
    const prefix = `${fixturePath(e.path)}/`
    return { value: [...fake.files.keys()].filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map((path) => ({ name: path.slice(prefix.length), kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
  })
  // Claude runs no settings hook beneath the plugin's: an empty Stop answer lets the turn end.
  on('classic.Stop', () => ({}))
  on('process.run', async ($, e) => {
    const argv = [...e.argv]
    const output = (stdout: string, exitCode = 0, stderr = '') => {
      const bytes = new TextEncoder().encode(stdout)
      const limit = 4 * 1024 * 1024
      return { value: { exitCode, stdout: new TextDecoder().decode(bytes.subarray(0, limit)), stderr,
        isStdoutTruncated: bytes.length > limit, isStderrTruncated: false } }
    }
    if (argv[0] === 'sh') {
      const discovery = !argv[2]?.includes('--non-interactive')
      fake.cliSetups.push(discovery ? 'discover' : 'install')
      await fake.holdCliSetup?.(!discovery)
      if (discovery) return fake.cliMissing ? output('', 3) : output('/selected/delta\n')
      fake.cliMissing = false
      return output('/selected/delta\n')
    }
    const parsed = cliArguments(argv)
    const operation = parsed?.positionals[1]
    if (operation) fake.cliIntegrations.push({ operation, integration: e.init?.env?.DELTA_CLI_INTEGRATION,
      ...e.init?.env?.DELTA_CLI_COMMAND_FORM ? { commandForm: e.init.env.DELTA_CLI_COMMAND_FORM } : {} })
    // Setup reads the account's login to recognise its personal organization; the read changes nothing.
    if (parsed?.positionals[0] === 'auth' && operation === 'status' && argv.includes('--json'))
      return output(JSON.stringify({ status: 'signed_in', account: { account_id: 'user', login: 'tester' } }))
    if (parsed?.positionals[0] === 'org' && argv.includes('--json')) {
      fake.commands.push(argv)
      // Setup creates a team organization only when the account has none; the name follows `--`.
      if (parsed.positionals[1] === 'create' && argv.at(-2) === '--' && !(fake.organizations ?? []).length) {
        const organization = { id: 'org-created', name: parsed.positionals[2]!, current: false }
        fake.organizations = [organization]
        return output(JSON.stringify({ operation: 'created', organization, refresh_warning: null }))
      }
      if (parsed.positionals[1] !== 'list') {
        fake.violations.push(`forbidden command: ${argv.join(' ')}`)
        throw new Error(`forbidden command ${argv.join(' ')}`)
      }
      if (fake.failOrgList)
        return output(JSON.stringify(cliFixture('error', faultEnvelope({
          code: 'authentication_required', message: 'Sign in to Delta to list organizations',
        }))), 2)
      return output(JSON.stringify({
        operation: 'listed',
        organizations: fake.organizations ?? [{ id: 'org-1', name: 'Zed', current: true }],
      }))
    }
    // The recording-contract probe is counted on its own (`contractChecks`) so tests asserting the
    // plugin's recording commands through `commands`/`delta()`/`operations()` stay unaffected by it.
    if (operation === 'contract') {
      // A test may hold policy discovery or the contract check itself, as it holds create/upload/attach.
      // The answer is fixed when asked, so a held check reports the CLI that was asked.
      fake.contractChecks++
      const answer = fake.contractUnknownSubcommand ? output('', 2, "error: unrecognized subcommand 'contract'")
        : output(JSON.stringify(cliFixture('contract', fake.contractRange ?? {})))
      const contractHold = await fake.holdRun?.(operation)
      if (contractHold) await contractHold
      return answer
    }
    fake.commands.push(argv)
    if (argv[0] === '/selected/delta' && argv[1] === 'org')
      return { value: fake.organizationResult }
    if (argv[0] === 'git') {
      if (fake.failGit) return output('', 128, 'not a git repository')
      if (argv.includes('--git-common-dir')) return output(`${fake.gitCommonDir}\n`)
      return output(`${fake.checkoutRoot}\n`)
    }
    if (argv[0] === 'pwd') return output(`${(e as any).init?.cwd ?? CONFIG}\n`)
    if (argv[0] === 'open') {
      if (fake.failOpen) return output('', 1, 'open: command not found')
      fake.opened.push(argv[1]!)
      return output('')
    }
    if (argv[0] === 'rm') {
      if (fake.failRemoval) return output('', 1, 'removal denied')
      for (const path of argv.slice(3)) {
        const sequence = Number(/\/([0-9]+)-[0-9]+\.json$/.exec(path)?.[1])
        // A session whose binding is gone stopped recording and owns no records, so its outbox may go.
        const owner = /\/outbox\/([^/]+)\//.exec(path)?.[1]
        const abandoned = owner !== undefined && !fake.store.has(`session:${owner}`)
        if (path.includes('/outbox/') && !(sequence < fake.server.next) && !abandoned) fake.violations.push(`deleted an unsynchronized record: ${path}`)
        fake.files.delete(path)
      }
      return output('')
    }
    const runHold = await fake.holdRun?.(operation)
    if (runHold) await runHold
    if (operation === 'unmount') {
      const owner = String(parsed?.options['--owner'])
      if (!matchesCommand(argv, ['thread', 'unmount', threadLocator(parsed!.positionals[2])], { '--owner': ownerOf(owner) }))
        fake.violations.push(`unexpected unmount arguments ${argv}`)
      fake.unmounts.push({ thread: fake.server.thread!, owner: String(parsed!.options['--owner']) })
      fake.server.groups.delete(String(parsed!.options['--owner']))
      return output(JSON.stringify(cliFixture('unmount', { thread_id: fake.server.thread, owner: parsed!.options['--owner'] })))
    }
    const source = { '--source': 'claude-code', '--external-id': fake.session }
    const positionals = operation === 'create' ? [] : operation === 'attach' ? [CHECKOUT] : [threadLocator(parsed?.positionals[2])]
    if (operation === 'invite') {
      const emails = parsed!.positionals.slice(3)
      if (!matchesCommand(argv, ['thread', 'invite', threadLocator(parsed!.positionals[2]), ...emails], {}) ||
          argv[argv.length - emails.length - 1] !== '--' || !emails.length) {
        fake.violations.push(`forbidden command: ${argv.join(' ')}`)
        throw new Error(`forbidden command ${argv.join(' ')}`)
      }
      const fault = fake.commandFault?.operation === 'invite' ? fake.commandFault : undefined
      if (fault) return output(JSON.stringify(cliFixture('error', faultEnvelope(fault))), fault.exitCode ?? 2)
      // A thread not yet on the server is uploaded privately first, so only the invited people see it.
      fake.server.upload ??= { organization: 'org-1', visibility: 'private' }
      fake.server.registered = true
      fake.server.confirmed = true
      fake.server.invited.push(...emails)
      return output(JSON.stringify(cliFixture('invite', {
        thread_id: fake.server.thread, url: urlOf(),
        results: emails.map((email) => fake.inviteFailures[email]
          ? { status: 'failed', email, reason: 'already_member', message: fake.inviteFailures[email] }
          : { status: 'invited', email }),
      })))
    }
    const options = operation === 'attach' ? { '--thread': fake.server.thread }
      : operation === 'share' ? { '--visibility': 'organization' }
      : operation === 'fork' || operation === 'discard' ? { ...operation === 'discard' ? { '--force': true as any } : {} }
      : operation === 'append' ? { ...source, '--producer-name': 'Claude Code' }
      : source
    // Create carries its upload intent for an automatic session, and omits it for an explicit share.
    const optional = operation === 'append' ? ['--acknowledge']
      : operation === 'create' ? ['--organization', '--visibility'] : []
    if (!['create', 'attach', 'share', 'status', 'append', 'fork', 'discard'].includes(operation ?? '') ||
        !matchesCommand(argv, [operation === 'attach' ? 'worktree' : 'thread', operation, ...positionals], options, optional)) {
      fake.violations.push(`forbidden command: ${argv.join(' ')}`)
      throw new Error(`forbidden command ${argv.join(' ')}`)
    }
    const fault = fake.commandFault?.operation === operation ? fake.commandFault : undefined
    const failed = () => output(JSON.stringify(cliFixture('error', faultEnvelope(fault!))), fault!.exitCode ?? 2)
    if (fault && !fault.after) return failed()
    if (operation === 'create') {
      const organization = parsed!.options['--organization']
      const visibility = String(parsed!.options['--visibility'])
      if (organization !== undefined) {
        if (!['private', 'organization'].includes(visibility))
          fake.violations.push(`unexpected upload visibility: ${visibility}`)
        if (fake.server.upload && fake.server.upload.organization !== organization)
          return output(JSON.stringify(cliFixture('error', faultEnvelope({
            code: 'invalid_invocation', reason: 'organization_mismatch',
            message: 'this thread already uploads to a different organization',
          }))), 2)
      }
      const created = !fake.server.thread
      fake.server.thread ??= fake.threadId
      // Re-running create keeps the first accepted intent, like the real CLI's idempotent create.
      if (organization !== undefined)
        fake.server.upload ??= { organization: String(organization), visibility: visibility as 'private' | 'organization' }
      return fault ? failed() : output(JSON.stringify(cliFixture('create', { thread_id: fake.server.thread, created })))
    }
    const thread = fake.server.thread
    if (operation === 'attach') {
      fake.server.mount = {
        thread: thread!, directory: CHECKOUT, reference: '00000000-0000-4000-8000-000000000001#t=0',
      }
      fake.server.checkout = 'attached'
      return fault ? failed() : output(JSON.stringify(cliFixture('attach', {
        reference: fake.server.mount.reference, directory: fake.server.mount.directory,
        ...fake.attachmentPatch,
      })))
    }
    if (operation === 'share') {
      fake.server.shared = true
      return fault ? failed() : output(JSON.stringify(cliFixture('share', {
        thread_id: thread, url: urlOf(), ...fake.publicationPatch,
      })))
    }
    if (operation === 'status') {
      const result = statusReply()
      return output(result.stdout, result.code)
    }
    if (operation === 'fork') {
      // A fork copies the refused local state into a new kept thread; the original still requires the discard.
      const fork = fake.refusedChanges?.fork ?? 'thread_fork_example'
      return fault ? failed() : output(JSON.stringify({
        source_thread_id: thread, thread_id: fork, name: `${thread} (local changes)`,
      }, null, 2))
    }
    if (operation === 'discard') {
      fake.refusedChanges = undefined
      return fault ? failed() : output(JSON.stringify(fake.state()))
    }
    fake.appendCalls++
    if (fake.holdAppend) await fake.holdAppend
    return deliver(((e as any).init?.stdin ?? '').split('\n').filter((line: string) => line.length), output)
  })
  on('process.spawn', async function* ($, e, next) {
    if (e.argv[0] === 'tail') {
      // `tail -c +N FILE`: the file from its Nth byte, in pieces, as a transcript read sees it.
      fake.commands.push([...e.argv])
      if (fake.failTranscriptRead) throw new Error('spawn tail ENOENT')
      const text = fake.files.get(e.argv[3]!)
      if (text === undefined) {
        yield { stream: 'stderr', text: `tail: ${e.argv[3]}: No such file or directory` }
        return { value: { code: 1, signal: null } }
      }
      const rest = new TextDecoder().decode(new TextEncoder().encode(text).subarray(Number(e.argv[2]!.slice(1)) - 1))
      for (let index = 0; index < rest.length; index += 7) yield { stream: 'stdout', text: rest.slice(index, index + 7) }
      return { value: { code: 0, signal: null } }
    }
    if (e.argv[2] === 'auth') {
      fake.authCalls.push([...e.argv])
      const reply = fake.authReplies.shift() ?? { status: 'signed_in', account: { account_id: 'user' } }
      try {
        if (e.argv[3] === 'wait' && fake.holdAuth) {
          await Promise.race([fake.holdAuth, new Promise<void>((resolve) => {
            next.signal.addEventListener('abort', () => resolve(), { once: true })
          })])
          if (next.signal.aborted) return { value: { code: null, signal: 'SIGTERM' } }
        }
        yield { stream: 'stdout', text: JSON.stringify(reply) }
        return { value: { code: ['signed_in', 'pending'].includes(reply.status) ? 0 : 1, signal: null } }
      } finally {
        if (e.argv[3] === 'wait') fake.authWaitClosed = true
      }
    }
    const operation = cliArguments(e.argv)?.positionals[1]
    if (operation) fake.cliIntegrations.push({ operation, integration: e.env?.DELTA_CLI_INTEGRATION,
      ...e.env?.DELTA_CLI_COMMAND_FORM ? { commandForm: e.env.DELTA_CLI_COMMAND_FORM } : {} })
    if (operation === 'mount') {
      fake.commands.push([...e.argv])
      const parsed = cliArguments(e.argv)
      const owner = String(parsed?.options['--owner'])
      const folder = parsed?.options['--folder'] === true
      const joining = parsed?.options['--join'] === true
      fake.mountRequests.push({ owner, folder, join: joining })
      if (!matchesCommand(e.argv, ['thread', 'mount', threadLocator(parsed?.positionals[2])],
        { '--owner': ownerOf(owner), ...folder ? { '--folder': true } : {}, ...joining ? { '--join': true } : {} }))
        fake.violations.push(`unexpected mount arguments: ${e.argv.join(' ')}`)
      const hold = await fake.holdRun?.(operation)
      if (hold) await hold
      const fault = fake.commandFault?.operation === operation ? fake.commandFault : undefined
      if (fault) {
        yield { stream: 'stdout', text: JSON.stringify(cliFixture('error', faultEnvelope(fault))) }
        return { value: { code: fault.exitCode ?? 2, signal: null } }
      }
      if (!fake.server.worktrees) {
        yield { stream: 'stdout', text: JSON.stringify(cliFixture('error', { error: { code: 'not_visible', reason: 'thread_gone', message: 'no such thread', retryable: false } })) }
        return { value: { code: 2, signal: null } }
      }
      const mounted = fake.mountReply?.(owner) ?? cliFixture('mount', { thread_id: fake.server.thread, owner })
      fake.server.groups.set(owner, {
        directory: mounted.directory,
        mounts: new Map(mounted.worktrees.map((tree: any) => [
          tree.reference, { name: tree.name, directory: tree.directory, active: true },
        ])),
      })
      yield { stream: 'stdout', text: JSON.stringify({ ...mounted, ...fake.mountPatch }) }
      return { value: { code: 0, signal: null } }
    }
    if (operation === 'status') {
      fake.commands.push([...e.argv])
      if (!matchesCommand(e.argv, ['thread', operation, threadLocator(cliArguments(e.argv)?.positionals[2])], {
        '--source': 'claude-code', '--external-id': fake.session,
      })) fake.violations.push(`forbidden status spawn: ${e.argv.join(' ')}`)
      const read = { closed: false, emittedBytes: 0 }
      fake.statusProcesses.push(read)
      const result = statusReply()
      const ignoreCancellation = fake.ignoreReadCancellation
      const hold = fake.holdStatusFor?.(String(cliArguments(e.argv)?.options['--external-id'])) ?? fake.holdStatus
      try {
        if (hold) {
          if (ignoreCancellation) await hold
          else {
            let wake!: () => void
            const cancelled = new Promise<void>((resolve) => { wake = resolve })
            next.signal.addEventListener('abort', wake, { once: true })
            try { await Promise.race([hold, cancelled]) }
            finally { next.signal.removeEventListener('abort', wake) }
          }
        }
        if (next.signal.aborted) return { value: { code: null, signal: 'SIGTERM' } }
        for (let offset = 0; offset < result.stdout.length; offset += 64 * 1024) {
          const text = result.stdout.slice(offset, offset + 64 * 1024)
          read.emittedBytes += new TextEncoder().encode(text).byteLength
          yield { stream: 'stdout', text }
        }
        return { value: { code: result.code, signal: null } }
      } finally {
        read.closed = true
      }
    }
    const watch = createWatch(e)
    fake.watches.push(watch)
    if (!matchesCommand(e.argv, ['thread', 'watch', threadLocator(cliArguments(e.argv)?.positionals[2])], {
      '--source': 'claude-code', '--external-id': fake.session, '--participate': 'Claude Code',
    })) fake.violations.push(`forbidden spawn: ${e.argv.join(' ')}`)
    if (fake.onWatch) fake.onWatch(watch, fake.watches.length - 1)
    else watch.observe()
    try {
      while (true) {
        const item = await watch.take(next.signal)
        if (item.kind === 'exit') return { value: item.result }
        yield { stream: item.stream, text: item.text }
      }
    } finally {
      watch.closed = true
    }
  })

  function worktreesFrame() {
    return cliFixture('worktrees', { worktrees: fake.server.worktrees!.map(({ reference, name }) => ({ reference, name })) })
  }

  function announceWorktrees() { fake.live()?.frame(worktreesFrame()) }

  function urlOf() {
    const fixture = cliFixture('share')
    return fixture.url.replace(fixture.share_id, fake.shareId)
  }

  /** The session owns its mounts; a Desktop hand-off mounts under an owner of its own. */
  function ownerOf(owner: string) {
    return owner.startsWith('desktop-') ? owner : fake.session
  }

  function threadLocator(value: string | undefined) {
    return [fake.server.thread, fake.shareId, urlOf()].includes(value!) ? value : fake.server.thread
  }

  function statusReply() {
    const fault = fake.commandFault?.operation === 'status' ? fake.commandFault : undefined
    if (fault)
      return { code: fault.exitCode ?? 2, stdout: JSON.stringify(cliFixture('error', faultEnvelope(fault))) }
    if (!fake.server.thread)
      return { code: 2, stdout: JSON.stringify(cliFixture('error',
        { error: { code: 'app_unavailable', reason: 'app_unavailable', message: 'cannot verify access', retryable: true } })) }
    return { code: 0, stdout: JSON.stringify({ operation: 'status', ...fake.state(), ...fake.statusPatch }) }
  }

  function createWatch(e: { argv: readonly string[] }) {
    const queue: ({ kind: 'text'; stream: 'stdout' | 'stderr'; text: string } | { kind: 'exit'; result: { code: number | null; signal: string | null } })[] = []
    let wake: (() => void) | undefined
    const watch = {
      argv: [...e.argv],
      ready: false,
      closed: false,
      write(text: string, stream: 'stdout' | 'stderr' = 'stdout') { queue.push({ kind: 'text', stream, text }); wake?.() },
      frame(value: unknown) { watch.write(JSON.stringify(value) + '\n') },
      exit(code: number | null = 1) { queue.push({ kind: 'exit', result: { code, signal: null } }); wake?.() },
      observe(): boolean {
        const thread = fake.server.thread
        if (!thread) return false
        watch.ready = true
        watch.frame(cliFixture('ready', { thread_id: thread, producer: fake.state().producer, ...fake.readyPatch }))
        for (const item of fake.server.items.values()) watch.frame(cliFixture('item', { item }))
        for (const comment of fake.server.comments.values()) watch.frame(cliFixture('comment', { comment }))
        const hold = fake.holdLive
        const live = () => {
          watch.frame(cliFixture('live'))
          if (fake.server.worktrees) watch.frame(worktreesFrame())
          const children = () => watch.frame({ type: 'children', children: fake.server.children })
          if (fake.holdChildren) void fake.holdChildren.then(children)
          else children()
        }
        if (hold) void hold.then(live)
        else live()
        return true
      },
      async take(signal: AbortSignal) {
        while (!queue.length) {
          if (signal.aborted) return { kind: 'exit' as const, result: { code: null, signal: 'SIGTERM' } }
          await new Promise<void>((resolve) => {
            wake = resolve
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
          wake = undefined
        }
        return queue.shift()!
      },
    }
    return watch
  }

  function deliver(
    lines: string[],
    output: (stdout: string, exitCode?: number, stderr?: string) => { value: ProcessRunResult },
  ) {
    const fault = fake.refusedChanges
      ? { accept: 0, exitCode: 2, stdout: () => JSON.stringify(cliFixture('error', faultEnvelope({
        code: 'reload_required', message: "the server rejected this thread's local changes", retryable: false }))) }
      : fake.appendOffline ? { accept: 0, exitCode: 1, stderr: 'offline' } : fake.appendFaults.shift()
    const thread = fake.server.thread
    if (!thread) return output(JSON.stringify(cliFixture('error', { error: { code: 'not_shared', reason: 'not_shared', message: 'not shared', retryable: false } })), 2)
    const acks: Record<string, any>[] = []
    let failure: string | undefined
    for (const [index, line] of lines.entries()) {
      if (fault?.accept !== undefined && index >= fault.accept) break
      let envelope: Envelope
      try { envelope = JSON.parse(line) } catch { failure = 'malformed JSONL'; break }
      const existing = fake.server.records.get(envelope.sequence)
      let ack: Record<string, any>
      if (existing) {
        if (existing.line !== canonical(envelope)) {
          fake.violations.push(`sequence ${envelope.sequence} reused with different content`)
          failure = 'sequence conflict'
          break
        }
        ack = acknowledgment(envelope, existing, true)
      } else if (envelope.sequence !== fake.server.next) {
        fake.violations.push(`sequence gap: expected ${fake.server.next}, got ${envelope.sequence}`)
        failure = 'sequence gap'
        break
      } else {
        const accepted: Accepted = { line: canonical(envelope), envelope, disposition: fault?.disposition ?? 'recorded', version: `server-${++fake.server.version}` }
        fake.server.records.set(envelope.sequence, accepted)
        fake.server.next = envelope.sequence + 1
        ack = acknowledgment(envelope, accepted, false)
      }
      acks.push(ack)
    }
    for (const frame of fault?.frames ?? []) fake.live()?.frame(frame)
    if (fault?.throwAfterAccept) throw new Error('connection lost after durable acceptance')
    // Acknowledgments carry the cumulative frontier, which may have advanced on replay.
    const stdout = acks.map((ack) => {
      const cumulative = { ...ack, next_sequence: fake.server.next }
      return JSON.stringify(fault?.ack ? fault.ack(cumulative) : cumulative)
    }).join('\n')
    const exitCode = fault?.exitCode ?? (failure ? 2 : 0)
    return output(fault?.stdout ? fault.stdout(stdout) : stdout, exitCode, fault?.stderr ?? failure ?? '')
  }

  function acknowledgment(envelope: Envelope, accepted: Accepted, duplicate: boolean) {
    return cliFixture(duplicate ? 'duplicate' : accepted.disposition, {
      thread_id: fake.server.thread, sequence: envelope.sequence,
      next_sequence: fake.server.next, duplicate, version: accepted.version,
      disposition: duplicate ? 'duplicate' : accepted.disposition, turn_sequence: envelope.turnSequence ?? null,
    })
  }

  return fake
}

/** Only the fixture's CLI vocabulary; option placement is not part of its contract. */
function cliArguments(argv: readonly string[]) {
  if (argv[0] !== '/selected/delta') return undefined
  const positionals: string[] = []
  const options: Record<string, string | boolean> = {}
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!
    // As clap reads it, everything after `--` is a positional, even text that starts with dashes.
    if (argument === '--') { positionals.push(...argv.slice(index + 1)); break }
    if (!argument.startsWith('--')) { positionals.push(argument); continue }
    if (Object.hasOwn(options, argument)) return undefined
    if (argument === '--json' || argument === '--folder' || argument === '--force' || argument === '--join') { options[argument] = true; continue }
    if (!['--source', '--external-id', '--thread', '--visibility', '--owner', '--owner-pid', '--organization', '--acknowledge', '--participate', '--producer-name'].includes(argument)) return undefined
    const value = argv[++index]
    if (value === undefined || value.startsWith('--')) return undefined
    options[argument] = value
  }
  return { positionals, options }
}

function matchesCommand(
  argv: readonly string[], positionals: readonly (string | undefined)[],
  options: Record<string, string | boolean | undefined>, optional: readonly string[] = [],
): boolean {
  const parsed = cliArguments(argv)
  if (!parsed) return false
  if (parsed.positionals.length !== positionals.length) return false
  if (!parsed.positionals.every((value, index) => value === positionals[index])) return false
  if (parsed.options['--json'] !== true) return false
  const allowed = new Set([...Object.keys(options), ...optional, '--json'])
  if (!Object.keys(parsed.options).every((name) => allowed.has(name))) return false
  return Object.entries(options).every(([name, value]) => parsed.options[name] === value)
}

function canonical(envelope: Envelope): string {
  return JSON.stringify(envelope)
}

/**
 * A recording failure envelope in the CLI's published shape: a stable `code`, the specific `reason`
 * behind it, and whether the same request may succeed later. Retryability defaults to the published
 * class of a pinned code; a test sets it explicitly for a code whose cause varies.
 */
function faultEnvelope(fault: { code?: string; reason?: string; message: string; retryable?: boolean }): { error: Record<string, unknown> } {
  const code = fault.code ?? 'app_unavailable'
  const retryable = fault.retryable ?? (cliErrorCodes as Record<string, { retryable?: boolean }>)[code]?.retryable
  return { error: { code, reason: fault.reason ?? code, message: fault.message, ...retryable !== undefined ? { retryable } : {} } }
}
