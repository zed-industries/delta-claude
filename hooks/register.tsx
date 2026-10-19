import type { ApiMessage, EngineInterface, On, RenderSurface, TextProps, Timer } from 'claude-code'
import { capturedMessage, isOmittedTool, messageUpdates, resultUpdate, toolInfo, type Update } from './content'
import { ToolRecords } from './tool-records'
import { acknowledgedOutboxFiles, acknowledgedPrefix, appendBatch, outboxChunks, outboxRemoval, pendingRecordTurn } from './outbox'
import { readCommandStream } from './command-reader'
import { deliveryFailure, deliveryRetryDelay } from './delivery-policy'
import { snapshotMessages } from './snapshot'
import { activeBackgroundAgents, hasInteractiveSurface, joinPreflight, missingJoinCommands, ownsSteering, promptGate, releasesMounts, worktreeChanges } from './lifecycle'
import { checkResult, reconnectDelay, validateAttachmentReceipt, validateCreationReceipt, validatePublicationReceipt } from './command-outcomes'
import { copyText, personColor, personKey, renderBand, statusCurrentTurn, statusSpinnerRunning, SPINNER_FRAMES, threadTurnOwned, toolRowParts, type StatusSegment, type StatusState, type TurnStatus } from './status'
import { announceThought, DrawnRows, DrawQueue, shownCommandRewrite, shownItemId, SHOW_ANSWER } from './row-delivery'
import { restoreBinding } from './binding'
import { pathKey, samePath } from './paths'
import { PresenceTracker } from './presence'
import {
  DeltaCommandError, DeltaSendError, appendFailure, classifyCommandFailure, permanentFailureAdvice,
  ContractRefusalError, JoinNotReadyError, contractRefusal, contractVersion, parseThreadContract, parseThreadMount, parseThreadStatus, parseWatchEvent,
  validateJoinedMounts, parseThreadFork, validateThreadFrontier, validateThreadCheckout,
  PRODUCER_NAME, CHILD_CONTRACT_VERSION,
  type MountedThread, type ThreadContract, type ThreadMount, type ThreadReady, type ThreadState, type ThreadStatus, type ThreadTurn, type ThreadUpload, type WatchChild, type WatchEvent, type WatchItem,
} from './thread-commands'
import {
  RemoteView, addRows, commentAction, commentAuthor, commentDisplay, commentMarkdown, commentQuote,
  conversationText, conversationWebLink, isDrawnItem, isEventItem, itemAuthor, itemDisplay, itemMarkdown, keyedComment,
  toolCallParts, THOUGHT_KIND, type Ledger, type PendingRow,
} from './conversation'
import { TitleScanner, transcriptRead } from './title'
import { policyPath, readProjectPolicy, recordsAutomatically, type ProjectPolicy } from './project-policy'
import {
  DASHBOARD_URL, HEADLESS_REFUSAL, InteractionDismissed, InteractionUnavailable, createdOrganizationFrom, emailsIn, invitationSummary, inviteResultsFrom, isPersonalOrganization, membersUrl, offerOnboarding,
  organizationsFrom, releaseOnboarding, runSetupWizard,
  type Interaction, type OnboardingStore, type Organization, type SetupEnv,
} from './setup'
import { DeltaCli } from './cli'
import { chooseShareAudience, threadInvitationsFrom, type ShareAudience } from './share-audience'
import { childKey, childName, childOutbox, recordsSubagent, sentBy, type ChildBinding, type Entry } from './children'
import {
  HISTORY_BUDGET, adoptionPrompt, deltaTurnReport, finishedReport, historyText, isOwnItem, itemsSince,
  looksLikeThreadLink, namedThread, resumePrompt, threadsNote, type ThreadTarget,
} from './delta-threads'
import { AccessRequiredError, requireAuthentication, type AuthenticationHost, type BrowserWait } from './auth'
import {
  HANDOFF_ACKNOWLEDGEMENT, HANDOFF_EXPIRY_MS, HANDOFF_PROMPT, newSessionLink, parseHandoff, type Handoff,
} from './handoff'

type Runtime = EngineInterface
type RecordBody = { update: Update; turnSequence?: number }
type Execution = { sequence: number; turnId?: string; lost?: true; endSequence?: number }
type CleanupPlan = { session: string; root: string; next: number; pending: { sequence: number; files: string[] }[] }
type ReadyGate = { promise: Promise<ThreadReady>; resolve: (ready: ThreadReady) => void; reject: (error: unknown) => void }
/** The upload a repository's policy asks an automatic session for. */
type AutoUpload = { mode: 'private' | 'organization'; organization: string }
type Binding = {
  session: string
  thread?: string
  /** The pasted locator remains resolvable after restarting with an empty local Delta cache. */
  locator?: string
  /** A session working in mounted copies of a thread's worktrees, not a checkout attached by this session. */
  joined?: true
  /** A fresh session awaiting its verified directory transition; recording stays disabled. */
  joinTransition?: JoinPlan
  /** Last confirmed location of a shared session's attached checkout, not proof that the thread still owns it. */
  checkout?: string
  checkoutReference?: string
  /**
   * A joined session's mount owner: its Claude session ID, or for a session that took over a
   * Desktop hand-off, the owner the offering tab mounted under.
   */
  owner?: string
  /** The directory a joined session works in: the checkout of a thread's only worktree, else the thread folder. */
  directory?: string
  /** Every worktree of a joined session's thread, as the last `thread mount` placed them. */
  mounts?: ThreadMount[]
  url?: string
  /** The audience Delta reports for the thread, shown apart from the link. */
  visibility?: 'private' | 'organization' | 'unlisted'
  /** Delta's background upload of this thread, as status last reported it. */
  upload?: ThreadUpload
  /**
   * Delta confirmed this automatic session's first background upload. Recorded so the first-upload
   * operation stays over even if a later per-turn sync reports `uploading` again.
   */
  uploaded?: true
  /**
   * Set on a session that Delta's background uploader syncs: one this plugin created from the
   * repository's policy, or one shared with "Just me". Such a session may participate while its
   * thread is still local-only.
   */
  autoUpload?: AutoUpload
  /**
   * The organization a shared session's thread was created under: the repository's saved team, or for
   * "Just me" without one, the organization selected in Delta.
   */
  organization?: string
  /**
   * When the session really ended, from the engine clock. Absent while it may still be live, so a
   * session in another process is never pruned; pruned sessions can no longer resume into their thread.
   */
  endedAt?: number
  snapshot: boolean
  captureFailure?: string
  next: number
  pending: Entry[]
  execution?: Execution
  lastTurnSequence?: number
  /** The last session title recorded for the thread, so each change is recorded once. */
  title?: string
  /** The agent IDs of the subagents this session records, each with a binding of its own. */
  children?: string[]
  /**
   * The Delta producer this conversation records as, and its outbox folder: the session that
   * started recording. A session that took the conversation over keeps it, so the thread sees one
   * participant whose sequence continues. Absent means this session's own ID.
   */
  producer?: string
  /** Where Claude last reported this session's transcript; a `/cd` can move it. */
  transcript?: string
  /**
   * The session Claude Code continued this conversation in, as backgrounding does. That session
   * owns the binding, its outbox, and its mounts from then on; this one records nothing more.
   */
  continuedIn?: string
}

/** The producer a binding records as; see {@link Binding.producer}. */
function producerOf(binding: { session: string; producer?: string }): string {
  return binding.producer ?? binding.session
}
/**
 * Another participant's running turn, as the band reports it: `since` is when the watch first
 * reported it and `heard` when the thread last changed during it.
 */
type RemoteTurn = { turnId: string | null; name: string; id?: string; since?: number; heard?: number }
/** A share or join that the band is reporting: running, finished, or failed. */
type ProgressTone = 'active' | 'done' | 'error'
/** A join to finish in a session; `owner` names a mount another session made for it to take over. */
type JoinPlan = { session: string; cwd: string; locator: string; thread: string; owner?: string }
type JoinRequest = { session: string; cwd: string; locator: string; fresh?: string; clearing?: boolean; cancelled?: boolean; contractVersion?: number; form?: CommandForm }
/**
 * A share to run. With `choose`, the share decides who sees the session once the CLI is checked: the
 * addresses typed after `/delta share`, or else the person's answer. Without it, it shares with the
 * organization, as the band's control and setup's offer ask.
 */
type ShareRequest = { session: string; cwd: string; cancelled?: boolean; form?: CommandForm; choose?: { emails: string[] } }
/** How a person ran a share or join: `/delta share` (`delta_subcommand`) or `/delta-share` (`dedicated_command`). */
type CommandForm = 'delta_subcommand' | 'dedicated_command'

/** The CLI environment that labels the command a share or join reports with how it was run, for Delta's telemetry. */
function commandFormEnv(form: CommandForm | undefined): Record<string, string> {
  return form ? { DELTA_CLI_COMMAND_FORM: form } : {}
}

const encoder = new TextEncoder()
const LIVE_ACTIVITY_ORIGIN = {
  work_origin: 'external_agent',
  interaction_surface: 'cli',
} as const
type LiveActivityKind = 'user_message' | 'agent_message' | 'agent_thought' | 'tool_call' | 'edit'
const cli = new DeltaCli()
const MAX_LINE = 16 * 1024 * 1024
const MAX_RECONNECT_DELAY = 30_000
/** A mount may materialize several large checkouts before it answers. */
const MOUNT_TIMEOUT_MS = 600_000
/** `thread contract` answers from the CLI binary without starting delta-app, so this bound only catches a wedged process. */
const CONTRACT_TIMEOUT_MS = 30_000
/** How long exiting waits for Delta to record a release. */
const RELEASE_TIMEOUT_MS = 5_000
/** How often an offered hand-off is checked; the claiming session is another process. */
const HANDOFF_POLL_MS = 2_000
/** The band's animation: one braille cycle, redrawn within the engine's per-site throttle. */
const SPINNER_INTERVAL_MS = 120
/** How long a finished share or join stays in the band before clearing. */
const BAND_NOTICE_MS = 4_000
/** How long a lost connection may take to come back before the band says it is reconnecting. */
const RECONNECT_GRACE_MS = 4_000
/** How long another participant's running turn may go without any activity before the band calls it quiet. */
const QUIET_AFTER_MS = 30_000
/** A remote thought or tool call shows as what its agent is doing once open this long, so a burst of quick calls does not flicker. */
const SHOW_ACTIVITY_AFTER_MS = 500
/** How long the band confirms a copied link. */
const COPIED_MS = 2_000
let active = ''
let sessionEpoch = 0
let activatingSession = ''
let queue: Promise<unknown> = Promise.resolve()
let drainTask: Promise<void> | undefined
let gate: Promise<void> | undefined
let inFlight = 0
let quiet: (() => void) | undefined
/** The plugin's folder under Claude's configuration, shared by every Claude process on the machine. */
let pluginData = ''
let outbox = ''
let joining: JoinRequest | undefined
let sharing: ShareRequest | undefined
/** The session whose share the band asked for while its turn ran; it starts when the turn ends. */
let shareAfterTurn: string | undefined
/** A Keep or Discard the band started, so its two controls cannot both run at once. */
let resolving = false
/**
 * The contract version negotiated with each session's CLI build, once it answered a range this plugin
 * speaks; a refusal is never remembered. A capability newer than `PLUGIN_CONTRACT_MIN` is gated on it.
 */
const contractVerified = new Map<string, number>()
/**
 * Whether this session records offline, with `append --acknowledge local` answering without the
 * server. An automatic or shared session does once its CLI is verified: it writes to its own thread,
 * and Delta's background uploader pushes what it acknowledged locally. A joined session writes into
 * someone else's thread, so it keeps server-confirmed delivery and holds Claude while Delta is
 * unreachable.
 */
function recordsOffline(session: string, binding: Binding | undefined): boolean {
  return !!binding && !binding.joined && contractVerified.has(session)
}
/** A read of what a transcript gained gives up after this long; the next turn's end reads it again. */
const TITLE_TIMEOUT_MS = 10_000
/**
 * How much of a transcript's end the first read takes in. Claude appends a title when it is chosen
 * or renamed, and repeats it as the transcript grows, so the end of the file holds the current one.
 */
const TITLE_WINDOW_BYTES = 256 * 1024
/** `$.fs.read` refuses a larger file, so reading a transcript whole is possible only below this. */
const FS_READ_LIMIT = 4 * 1024 * 1024
/**
 * Where a session's transcript was last read to and the title found so far. `ranged` is cleared
 * once reading from an offset fails, so the session reads its transcript whole from then on.
 */
type TitleReader = { path: string; offset: number; scanner: TitleScanner; ranged: boolean; reading?: true }
const titleReaders = new Map<string, TitleReader>()
const drawQueue = new DrawQueue()
let drawing = false
/** The answer the engine gives a plugin's command when no `command.run` hook of its own answered it. */
const UNANSWERED_COMMAND = /no command\.run hook answered it/
/**
 * `watcher`: observation is not live; the next live watch connection lifts it.
 * `verification`: a checkout check failed; a passing check lifts it.
 * `delivery`: Delta refused a record or the thread; only explicit share/join recovery lifts it.
 */
type CheckoutPause = 'watcher' | 'verification' | 'delivery'
/** One row waiting for its turn's start record, with the tool identity it later attributes. */
type HeldRow = { update: Update; toolId?: string; turnId?: string }
type SessionState = {
  binding?: Binding
  /** The first prompt of an unbound session looked again for a conversation it continues. */
  continuationRechecked?: true
  captureFailure?: string
  /** Why checkout sharing is paused; each reason is lifted only by its own recovery. */
  pauses: Map<CheckoutPause, string | undefined>
  /** Delivery retry bookkeeping; see failDelivery. */
  retryAttempts: number
  retryTimer?: Timer
  deliveryNotice?: string
  /** Why sending is being retried, for the band while the retry waits. */
  retryReason?: string
  /** The next status read while Delta's background upload has not yet published the link; see followUpload. */
  uploadRefresh?: Timer
  uploadRefreshAttempts?: number
  unsaved: { updates: Update[]; turnSequence?: number }[]
  tools: ToolRecords
  cleanupTask?: Promise<void>
  cleanupError?: string
  cleanupPlan?: CleanupPlan
  cleanedThrough?: number
  nativeTurns: Map<string, number>
  aborting: Set<string>
  /** Turns that lost the shared thread, so their late output keeps its turn instead of waiting. */
  lostTurns: Set<string>
  /** Items whose command output row this session drew, so a retried model row draws nothing twice. */
  drawn: DrawnRows
  currentTurnId?: string
  /** A partial session transition must not silently become an unshared executing session. */
  joinFailure?: string
  /** A local prompt is entering, so remote rows wait until it is dropped or its turn completes. */
  promptEntering?: boolean
  /**
   * Rows held until `turn.start` fixes the turn they belong to: a composer prompt and any output
   * that reached a hook before its turn's scoped start was written. Recording them earlier would
   * name the turn before theirs, and Delta fences output naming a turn that no longer owns it.
   */
  heldRows?: HeldRow[]
  /** A joined session's mounts were confirmed in this process, and Claude was put in their directory. */
  mounted?: true
  /** A hand-off this Desktop tab offered, until a new session claims it or it expires. */
  offered?: Handoff
  /** A session that started in a hand-off's folder, joining it before its first prompt. */
  handoffClaim?: Promise<void>
  /** What the band reminds an interactive session Delta does not sync, decided when the session starts. */
  reminder?: SyncReminder
  /**
   * The hand-off's opening line, turned into a one-word turn that is left out of the thread:
   * entering until its turn starts, then that turn's ID.
   */
  localTurn?: { turnId?: string }
  /** Mounts are being restored for a resumed session; prompts wait. */
  restoring?: true
  /** Where Claude has to move between turns, because its worktree is no longer the thread's one directory. */
  moveTo?: string
  moving?: true
  /** The latest handling of a `worktrees` event; the next one waits for it. */
  mountRefresh?: Promise<void>
  /** Context rows for Claude that wait for a turn to end. */
  notes: string[]
  /**
   * Delta refused this offline session's recorded changes; the band offers Fork & Restore or
   * Discard, and prompts keep retrying delivery until the person resolves it or an append succeeds.
   */
  refusedOffline?: boolean
}
const sessions = new Map<string, SessionState>()
const presence = new PresenceTracker()
const feed: {
  error?: string; session?: string; thread?: string
  /** Why the watch is reconnecting, for a prompt refused meanwhile. */
  interruption?: string
  revision: number; stopProcess?: () => Promise<unknown>
  cancel?: AbortController
  connection: 'stopped' | 'connecting' | 'live' | 'retrying'
  ready?: ThreadReady; readyGate?: ReadyGate
  view?: RemoteView
  settling?: Promise<void>
  settleNotice?: string
  threadTurn?: Extract<WatchEvent, { type: 'turn' }>
  producerTurn?: ThreadTurn
  /** The thread turn last known to be this producer's. */
  ownTurnId?: string
  remoteTurn?: RemoteTurn
  /** Child inventory from the current snapshot and subsequent per-child updates. */
  children: WatchChild[]
  /** The watched thread's worktree references, which a thread sharing them also reports. */
  worktrees?: string[]
  /** When this session first saw each still-open remote item open, which times what the band shows it doing. */
  openSince: Map<string, number>
  /** The current turn, as the band reports it; recomputed whenever the watched turn changes. */
  turn: TurnStatus
  /** The share or join the band is reporting, held through the operation and briefly after success. */
  progress?: { text: string; tone: ProgressTone; step?: [number, number] }
  /** Clears a finished operation's band line; cancelled on teardown and by the next operation. */
  progressTimer?: Timer
  /** The animation's frame and redraw timer, live only while a live watch has a running turn. */
  spinner?: { frame: number; timer: Timer }
  /**
   * A live watch that dropped: within RECONNECT_GRACE_MS of the drop `reconnectTimer` runs and the
   * band still looks live; past it `reconnecting` is set until the watch is live again.
   */
  reconnecting?: boolean
  reconnectTimer?: Timer
  /** The link was just copied; the timer clears the confirmation. */
  copiedTimer?: Timer
} = {
  revision: 0, connection: 'stopped', turn: { state: 'idle' }, children: [], openSince: new Map(),
}

function newReadyGate(): ReadyGate {
  let resolve!: ReadyGate['resolve']
  let reject!: ReadyGate['reject']
  const promise = new Promise<ThreadReady>((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

/** The engine requires helpers receiving `$` to remain in the hooks module. */
async function startConversation($: Runtime, session: string): Promise<ThreadReady> {
  if (!boundDirectory(stateFor(session).binding))
    throw new Error('Thread setup is incomplete; run /delta-share to finish explicit creation, attachment, and publication')
  if (feed.session === session && feed.cancel && feed.readyGate) {
    if (feed.connection === 'retrying') throw new Error(feed.interruption ?? 'Delta is reconnecting')
    return feed.readyGate.promise
  }
  const stopping = stopConversation()
  const revision = feed.revision
  const cancel = new AbortController()
  const ownsStartup = () => feed.revision === revision && feed.cancel === cancel && !cancel.signal.aborted
  feed.cancel = cancel
  setConnection($, 'connecting')
  feed.session = session
  const thread = stateFor(session).binding!.thread!
  feed.thread = thread
  const readiness = newReadyGate()
  feed.readyGate = readiness
  let launched = false
  try {
    await stopping
    if (!ownsStartup()) throw new Error('Thread watcher startup was cancelled')
    const saved = await $.store.get(ledgerKey(session)) as Ledger | undefined
    if (!ownsStartup()) throw new Error('Thread watcher startup was cancelled')
    feed.view = new RemoteView(thread, saved?.thread === thread && saved.items !== null && typeof saved.items === 'object'
      ? saved : { thread, items: {} })
    launched = true
    void consumeConversation($, session, revision, cancel.signal, readiness).catch((error) => {
      if (!ownsStartup()) return
      feed.readyGate?.reject(error)
      feed.cancel = undefined
      setConnection($, 'stopped')
      const binding = stateFor(session).binding!
      feed.error = `Delta watcher failed: ${String(error)}. ${recoveryAdvice(binding)} to reconnect.`
      $.ui.invalidate('ui.render')
    })
    return await readiness.promise
  } catch (error) {
    if (ownsStartup() && !launched) {
      cancel.abort()
      feed.cancel = undefined
      setConnection($, 'stopped')
    }
    readiness.reject(error)
    throw error
  }
}

async function stopConversation() {
  feed.revision++
  feed.cancel?.abort()
  feed.cancel = undefined
  feed.connection = 'stopped'
  clearReconnect()
  feed.copiedTimer?.cancel()
  feed.copiedTimer = undefined
  stopSpinner()
  // A running share or join keeps its band line across a watcher restart; only its timer ends.
  feed.progressTimer?.cancel()
  feed.progressTimer = undefined
  feed.readyGate?.reject(new Error('Thread watcher stopped'))
  feed.readyGate = undefined
  feed.ready = undefined
  const stop = feed.stopProcess
  feed.stopProcess = undefined
  feed.session = undefined
  feed.thread = undefined
  feed.error = undefined
  feed.interruption = undefined
  feed.view = undefined
  feed.turn = { state: 'idle' }
  // A stopped pass still saves the rows it added; finish that save before a new watch loads or writes the ledger.
  const settling = feed.settling
  feed.settling = undefined
  feed.settleNotice = undefined
  presence.reset()
  feed.threadTurn = undefined
  feed.producerTurn = undefined
  feed.ownTurnId = undefined
  feed.remoteTurn = undefined
  feed.children = []
  feed.openSince.clear()
  dropQueuedDraws()
  if (stop) await stop()
  await settling?.catch(() => {})
}

async function consumeConversation(
  $: Runtime,
  session: string,
  revision: number,
  signal: AbortSignal,
  readiness: ReadyGate,
) {
  const ownsObserver = () => !signal.aborted && revision === feed.revision
  let attempts = 0
  while (ownsObserver()) {
    const started = await $.clock.now()
    if (!ownsObserver()) return
    let stream: ReturnType<Runtime['process']['spawn']> | undefined
    let failure: unknown
    let pending = ''
    let stderr = ''
    let ready: ThreadReady | undefined
    let connected = true
    let live = false
    let inspected = false
    const ownsConnection = () => connected && ownsObserver()
    const inspection = new AbortController()
    const cancelInspection = () => inspection.abort()
    signal.addEventListener('abort', cancelInspection, { once: true })
    let inspectionFailed = false
    let inspectionError: unknown
    let rejectInspection: ((error: unknown) => void) | undefined
    // Participation needs both a complete snapshot and a passing access and checkout inspection.
    const participate = () => {
      if (!live || !inspected || !ownsConnection()) return
      feed.error = undefined
      feed.interruption = undefined
      setConnection($, 'live')
      resumeCheckout(stateFor(session), 'watcher')
      readiness.resolve(ready!)
      void drain($, session).catch((error) => {
        if (ownsConnection()) return report($, error)
      })
    }
    // Ready carries only identity and producer state. Inspect off the watch loop so slow
    // access and checkout reads cannot delay turn cancellation.
    const inspect = (baseline: ThreadReady) => void (async () => {
      try {
        const watched = stateFor(session).binding
        const status = await readThreadStatus($, watched?.locator ?? baseline.thread_id,
          watched ? producerOf(watched) : session, inspection.signal)
        if (!ownsConnection()) return
        await serial(async () => {
          if (!ownsConnection()) return
          const current = await load($, session)
          if (!ownsConnection()) return
          validateThreadFrontier(status, current)
          if (current.joined) {
            // Access only: a worktree changed while disconnected is reconciled by its `worktrees`
            // event, and every prompt and delivery checks each mount.
            validateJoinedMounts(status, [])
            await save($, { ...current, ...statusFields(status) }, ownsConnection)
          } else {
            const checkout = validateThreadCheckout(status, current)
            await save($, {
              ...current, ...statusFields(status),
              checkout: checkout.directory, checkoutReference: checkout.reference,
            }, ownsConnection)
          }
        })
        if (!ownsConnection()) return
        inspected = true
        participate()
        followUpload($, session)
      } catch (error) {
        if (ownsConnection()) {
          inspectionFailed = true
          inspectionError = error
          rejectInspection?.(error)
        }
      }
    })()
    try {
      setConnection($, 'connecting')
      const binding = await serial(() => load($, session))
      if (!ownsObserver()) return
      if (!boundDirectory(binding))
        throw new Error('No attached thread selected; run /delta-share from the intended Git checkout')
      const argv = [await resolveCli($), '--json', 'thread', 'watch', binding.locator ?? binding.thread,
        // Delta shows the signed-in person in the thread as taking part through Claude Code while this
        // watch runs; the stop below and each reconnect end and renew it.
        '--source', 'claude-code', '--external-id', producerOf(binding), '--participate', PRODUCER_NAME]
      if (!ownsObserver()) return
      stream = $.process.spawn({
        argv,
        env: { DELTA_CLI_INTEGRATION: 'claude_code' },
      })
      const running = stream
      feed.stopProcess = () => running.return({ code: null, signal: 'SIGTERM' })
      while (true) {
        if (inspectionFailed) throw inspectionError
        // Only the currently pending next() listens for inspection failure. A single
        // never-settled failure promise would retain a listener per watch line.
        const inspectionFailure = new Promise<never>((_, reject) => { rejectInspection = reject })
        const piece = await Promise.race([stream.next(), inspectionFailure])
        rejectInspection = undefined
        if (!ownsObserver()) return
        if (piece.done)
          throw new Error(`Delta watcher stopped (${piece.value.code ?? piece.value.signal ?? 'unknown'}). ${stderr}`)
        if (piece.value.stream === 'stderr') {
          stderr = (stderr + piece.value.text).slice(-4000)
          continue
        }
        pending += piece.value.text
        if (pending.length > MAX_LINE) throw new Error('Delta watch event exceeds the watcher limit')
        let end: number
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end)
          pending = pending.slice(end + 1)
          if (!line.trim()) continue
          const event = parseWatchEvent(line)
          if (!event) continue
          if (event.type === 'error') throw event.error
          if (event.type === 'producer.turn') {
            feed.producerTurn = { sequence: event.sequence, status: event.status }
            observeThreadTurn($, session)
            await observeTurn($, session, event, ownsObserver)
            if (!ownsObserver()) return
            continue
          }
          if (event.type === 'ready') {
            if (ready) throw new Error('Duplicate thread readiness')
            await serial(async () => {
              if (!ownsObserver()) return
              const current = await load($, session)
              if (!ownsObserver()) return
              validateThreadFrontier(event, current)
            })
            if (!ownsObserver()) return
            feed.thread = event.thread_id
            feed.ready = event
            feed.view?.reset()
            resetPresence()
            // A new watch must replace the old inventory, not reuse it while awaiting its snapshot.
            feed.children = []
            feed.producerTurn = event.producer?.turn ?? undefined
            if (event.producer?.turn) await observeTurn($, session, event.producer.turn, ownsObserver)
            if (!ownsObserver()) return
            refreshTurn($)
            ready = event
            inspect(event)
            continue
          }
          if (!ready) throw new Error('Thread activity arrived before readiness')
          if (event.type === 'live') {
            live = true
            feed.view?.endSnapshot()
            void settleRemote($, session)
            participate()
          } else if (event.type === 'worktrees') {
            feed.worktrees = event.worktrees.map((tree) => tree.reference)
            refreshMounts($, session, event.worktrees)
          }
          else observeRemote($, session, event)
        }
      }
    } catch (error) {
      failure = error
    } finally {
      connected = false
      rejectInspection = undefined
      inspection.abort()
      signal.removeEventListener('abort', cancelInspection)
      try { if (stream) await stream.return({ code: null, signal: 'SIGTERM' }) }
      catch (error) { failure ??= error }
      if (ownsObserver()) feed.stopProcess = undefined
    }
    if (!ownsObserver()) return
    feed.ready = undefined
    // A session that records offline keeps working when the watcher drops: its records stay queued
    // and drain retries, so nothing pauses and no running turn is lost.
    if (!recordsOffline(session, stateFor(session).binding)) {
      pauseCheckout(stateFor(session), 'watcher')
      const running = stateFor(session).binding?.execution
      if (running) await loseExecution($, session, running.sequence, 'The Delta watcher disconnected', ownsObserver)
      if (!ownsObserver()) return
    }
    readiness.reject(failure)
    if (failure instanceof DeltaCommandError && failure.hints.retryable === false) {
      // A retryable failure is a lost connection, but a non-retryable one needs a person:
      // reconnecting cannot bring back a deleted thread or restored access on its own.
      const notice = `Delta sharing paused: ${failure.message}. ${permanentFailureAdvice(failure.code, !!stateFor(session).binding?.autoUpload, failure.reason)}, then ${recoveryAdvice(stateFor(session).binding)}.`
      pauseCheckout(stateFor(session), 'delivery', notice)
      feed.cancel = undefined
      feed.readyGate = undefined
      feed.error = notice
      setConnection($, 'stopped')
      await $.ui.log(notice, { to: 'transcript' })
      return
    }
    readiness = newReadyGate()
    feed.readyGate = readiness
    // A child that emits one event then exits is not a healthy connection.
    const ended = await $.clock.now()
    if (!ownsObserver()) return
    if (ended - started >= MAX_RECONNECT_DELAY) attempts = 0
    const delay = reconnectDelay(attempts)
    attempts++
    // The transcript says why once; the band waits out a brief drop before showing it.
    feed.interruption = `Connection interrupted: ${String(failure)} Retrying in ${delay / 1000}s.`
    setConnection($, 'retrying')
    if (attempts === 1) await $.ui.log(feed.interruption, { to: 'transcript' })
    if (!ownsObserver()) return
    try { await $.clock.sleep(delay, { signal }) }
    catch (error) { if (!signal.aborted) throw error }
  }
}

/** Apply one change to the thread's items, turn state, or presence. */
function observeRemote($: Runtime, session: string, event: WatchEvent) {
  const view = feed.view
  if (view && (event.type === 'item' || event.type === 'item.append' || event.type === 'remove')) {
    const id = event.type === 'item' ? event.item.id : event.id
    if (event.type === 'remove') view.remove(event.id)
    else {
      const before = view.items.get(id)
      const item = event.type === 'item' ? event.item : view.appendText(event.id, event.text)
      // Thinking never becomes a row for Claude, so it is shown to the person here, once, when it completes live.
      if (announceThought(before, item, view.snapshotDone)) {
        const display = itemDisplay(item, view.thread)
        if (display) showToPerson($, display)
      }
      if (event.type === 'item') view.upsert(item)
    }
    if (!view.items.get(id)?.open) feed.openSince.delete(id)
    else if (!feed.openSince.has(id)) void $.clock.now().then((now) => {
      if (view.items.get(id)?.open && !feed.openSince.has(id)) feed.openSince.set(id, now)
    })
    // Activity keeps another participant's running turn from going quiet.
    const turn = feed.remoteTurn
    if (turn) void $.clock.now().then((now) => { turn.heard = now })
    void settleRemote($, session)
    $.ui.invalidate('ui.render')
  } else if (view && (event.type === 'comment' || event.type === 'comment.remove')) {
    if (event.type === 'comment') view.upsertComment(event.comment)
    else view.removeComment(event.id)
    void settleRemote($, session)
    $.ui.invalidate('ui.render')
  } else if (event.type === 'turn') {
    feed.threadTurn = event
    observeThreadTurn($, session)
  } else if (event.type === 'presence') {
    // A live presence report supersedes a finished operation's notice.
    clearDoneNotice()
    presence.update(event.users, (milliseconds, action) => $.clock.after(milliseconds, action),
      () => $.ui.invalidate('ui.render'))
    $.ui.invalidate('ui.render')
  } else if (event.type === 'children' || event.type === 'child' || event.type === 'child.remove') {
    if (event.type === 'children') {
      feed.children = event.children
    } else if (event.type === 'child') {
      const index = feed.children.findIndex((child) => child.thread_id === event.child.thread_id)
      if (index < 0) feed.children.push(event.child)
      else feed.children[index] = event.child
    } else {
      feed.children = feed.children.filter((child) => child.thread_id !== event.thread_id)
    }
    if (recordsChildren(session)) observeThreads($, session)
    syncSpinner($)
    $.ui.invalidate('ui.render')
  }
}

/** Each new watch connection re-reports who is here; its first report is not a set of arrivals. */
function resetPresence() {
  presence.reset()
}

/**
 * Whether the thread's running turn is this producer's own. Producer and thread turn events are
 * separate streams, so either can arrive first: a start not yet reported is ours, and a turn
 * already known as ours stays ours after it finishes, until the thread reports a different one.
 * A turn already known as another participant's is never adopted, even while this producer's
 * own start is being reported for the turn that takes it over.
 */
function ownsThreadTurn(session: string, turn: Extract<WatchEvent, { type: 'turn' }>) {
  const execution = stateFor(session).binding?.execution
  const own = threadTurnOwned({ ...feed, execution }, turn)
  if (own && turn.turn_id) feed.ownTurnId = turn.turn_id
  return own
}

function observeThreadTurn($: Runtime, session: string) {
  const turn = feed.threadTurn
  const remote = turn?.state === 'running' && !ownsThreadTurn(session, turn)
  const previous = feed.remoteTurn
  // A different running turn, whoever started it, took the thread over from the previous one.
  const replaced = turn?.state === 'running' && turn.turn_id !== previous?.turnId && (!remote || !!previous?.turnId)
  // The band reports the turn; its end simply returns the band to the thread's next status.
  if (previous && (!remote || replaced)) feed.remoteTurn = undefined
  if (remote && !feed.remoteTurn) {
    const name = conversationText(turn!.user?.name ?? '').trim()
    const started: RemoteTurn = { turnId: turn!.turn_id, name, ...turn!.user ? { id: personKey(turn!.user) } : {} }
    feed.remoteTurn = started
    // A new turn counts its time, and its quiet, from when it is first reported.
    void $.clock.now().then((now) => { started.since ??= now })
  } else if (remote) feed.remoteTurn!.turnId ??= turn!.turn_id
  refreshTurn($)
}

/**
 * The current turn, from the watch's two independent streams. A thread turn whose `turn_id` is not
 * yet known is still starting; otherwise it belongs to another participant when their running turn
 * was announced, and to this session when it was not. A producer start can reach this session
 * before the thread reports the turn it belongs to.
 */
function currentTurn(): TurnStatus {
  return statusCurrentTurn(feed)
}

/** Recompute the band's turn status and let the animation follow it. */
function refreshTurn($: Runtime) {
  // A real turn change supersedes a finished operation's notice.
  clearDoneNotice()
  feed.turn = currentTurn()
  syncSpinner($)
  $.ui.invalidate('ui.render')
}

/** Drop a finished operation's notice so the band can show what happened next. */
function clearDoneNotice() {
  if (feed.progress?.tone !== 'done') return
  feed.progressTimer?.cancel()
  feed.progressTimer = undefined
  feed.progress = undefined
}

/**
 * Record the watcher's connection state; a redraw and the band's animation follow it. A live watch
 * that drops starts the grace in which the band still looks live; reconnecting attempts keep it
 * running, and only a live or stopped watch ends it.
 */
function setConnection($: Runtime, connection: typeof feed.connection) {
  if (connection === 'live' || connection === 'stopped') clearReconnect()
  else if (connection === 'retrying' && feed.connection === 'live') {
    const timer = $.clock.after(RECONNECT_GRACE_MS, () => {
      if (feed.reconnectTimer !== timer) return
      feed.reconnectTimer = undefined
      feed.reconnecting = true
      $.ui.invalidate('ui.render')
    })
    feed.reconnectTimer = timer
  }
  feed.connection = connection
  syncSpinner($)
  $.ui.invalidate('ui.render')
}

function clearReconnect() {
  feed.reconnectTimer?.cancel()
  feed.reconnectTimer = undefined
  feed.reconnecting = undefined
}

/** Run the band's redraw timer only while a live watch has a running turn, or an operation runs. */
function syncSpinner($: Runtime) {
  if (!spinnerRunning()) return stopSpinner()
  if (feed.spinner) return
  const timer = $.clock.every(SPINNER_INTERVAL_MS, () => {
    const spinner = feed.spinner
    if (!spinner || spinner.timer !== timer) return
    spinner.frame = (spinner.frame + 1) % SPINNER_FRAMES.length
    $.ui.invalidate('ui.render')
  })
  feed.spinner = { frame: 0, timer }
}

/** A running share or join animates wherever it runs; a turn animates only on a live watch. */
function spinnerRunning() {
  return statusSpinnerRunning({ ...feed, progress: currentProgress() })
}

function stopSpinner() {
  feed.spinner?.timer.cancel()
  feed.spinner = undefined
}

/** Record what a share or join is doing and redraw; the band's animation follows it. */
function setProgress($: Runtime, text: string, tone: ProgressTone, step?: [number, number]) {
  feed.progressTimer?.cancel()
  feed.progressTimer = undefined
  feed.progress = { text, tone, step }
  syncSpinner($)
  $.ui.invalidate('ui.render')
}

/** Finish an operation: a success clears after BAND_NOTICE_MS, a failure stays until replaced. */
function finishProgress($: Runtime, text: string, tone: 'done' | 'error') {
  setProgress($, text, tone)
  if (tone !== 'done') return
  const timer = $.clock.after(BAND_NOTICE_MS, () => {
    if (feed.progressTimer !== timer) return
    feed.progressTimer = undefined
    feed.progress = undefined
    syncSpinner($)
    $.ui.invalidate('ui.render')
  })
  feed.progressTimer = timer
}

/** Drop an operation's band line, as a torn-down session does. */
function clearProgress($: Runtime) {
  feed.progressTimer?.cancel()
  feed.progressTimer = undefined
  feed.progress = undefined
  syncSpinner($)
  $.ui.invalidate('ui.render')
}

/**
 * Whether the band has a Delta status to draw: a live watch, a share or join step, a failure, or the
 * reminder of a session Delta does not sync.
 */
function statusShown(): boolean {
  return !!feed.session || !!feed.progress || !!feed.error || !!activeReminder()
}

/** How the band reminds a session Delta does not sync, by the checkout's setting. */
type SyncReminder = 'manual' | 'not set up'
const REMINDERS: Record<SyncReminder, { text: string; command: string }> = {
  manual: { text: 'Not syncing', command: '/delta-share' },
  'not set up': { text: 'Not set up', command: '/delta-setup' },
}

/**
 * The active session's reminder, while the band has nothing else to say. A running share or join,
 * a failure, or an unfinished join takes its place, and a syncing session's band says `Syncing`
 * instead, so the band always shows the current state.
 */
function activeReminder(): { text: string; command: string } | undefined {
  const runtime = sessions.get(active)
  if (!runtime?.reminder || currentProgress() || feed.error || runtime.binding?.joinTransition) return
  return REMINDERS[runtime.reminder]
}

/**
 * What another participant's turn is doing: its newest thought or tool call open long enough to
 * show, how long that has been open, and how many of its other calls are.
 */
function remoteActivity(remote: RemoteTurn, now: number): NonNullable<StatusState['agent']>['doing'] {
  const shown = [...feed.openSince].flatMap(([id, since]) => {
    const item = feed.view?.items.get(id)
    const current = !remote.turnId || !item?.turn_id || item.turn_id === remote.turnId
    return item?.open && current && (item.kind === 'tool_call' || item.kind === THOUGHT_KIND) &&
      now - since >= SHOW_ACTIVITY_AFTER_MS ? [{ item, since }] : []
  })
  const newest = shown.reduce<typeof shown[number] | undefined>(
    (latest, entry) => !latest || entry.since >= latest.since ? entry : latest, undefined)
  if (!newest) return
  const tool = newest.item.kind === 'tool_call'
  return {
    text: tool ? toolCallParts(newest.item).name : 'thinking', tool,
    seconds: (now - newest.since) / 1000,
    more: shown.filter((entry) => entry !== newest && entry.item.kind === 'tool_call').length,
  }
}

/** What the band shows, at the moment it draws. */
async function statusView($: Runtime): Promise<StatusState> {
  const state = feed.session ? sessions.get(feed.session) : undefined
  const remote = feed.turn.state === 'remote' ? feed.remoteTurn : undefined
  const now = await $.clock.now()
  const since = remote?.since ?? now
  const silent = now - (remote?.heard ?? since)
  // A turn with an item still open, such as a long command, is working however long it is silent.
  const open = [...feed.view?.items.values() ?? []].some((item) => item.open)
  const doing = remote ? remoteActivity(remote, now) : undefined
  const binding = state?.binding
  // The visibility label names an organization; read the directory once, and a later redraw fills it.
  if (binding?.visibility) void loadOrganizationDirectory($)
  return {
    ...feed,
    // A staged automatic session records before its watch starts, while the band shows its connection step.
    recording: !!sessions.get(feed.session ?? active)?.binding?.snapshot,
    reminder: activeReminder(),
    // Within the grace after a drop, the band carries on as if the watch were live.
    connection: feed.reconnectTimer ? 'live' : feed.connection,
    deliveryPause: state?.pauses.get('delivery') ?? state?.pauses.get('verification'),
    retryReason: state?.retryTimer ? state.retryReason : undefined,
    progress: currentProgress(),
    link: statusLink(),
    audience: audienceLabel(binding),
    // A refused offline thread keeps its controls until the person forks the changes or discards them.
    conflict: state?.refusedOffline ? { fork: 'Fork & Restore', discard: 'Discard' } : undefined,
    // Sharing waits for Claude's turn to finish, so the control says so rather than ignoring a press.
    // A personal organization has nobody to share with, so its threads offer no share control.
    share: binding?.visibility === 'private' && !personalOrganizationIds.has(threadOrganization(binding) ?? currentOrganizationId ?? '') ? {
      label: shareAfterTurn === active && state?.currentTurnId ? 'Sharing after this turn'
        : state?.currentTurnId ? 'Share after this turn'
        : `Share with ${organizationName(threadOrganization(binding)) ?? 'organization'}`,
    } : undefined,
    people: presence.roster(),
    children: feed.children,
    childrenStale: feed.connection !== 'live',
    agent: remote ? {
      seconds: (now - since) / 1000,
      ...!open && silent >= QUIET_AFTER_MS ? { quiet: silent / 1000 } : {},
      ...doing ? { doing } : {},
    } : undefined,
    copied: !!feed.copiedTimer,
  }
}

/**
 * Who can see the thread, apart from whether it has a link: `Synced with <org>` for a thread only
 * its owner sees (a private one, or any in a personal organization, which has no other members),
 * `Shared with <org>`, or `Unlisted`.
 */
function audienceLabel(binding: Binding | undefined): string | undefined {
  if (!binding?.visibility) return undefined
  if (binding.visibility === 'unlisted') return 'Unlisted'
  const organization = threadOrganization(binding) ?? currentOrganizationId
  const name = organizationName(organization) ?? 'your organization'
  return binding.visibility === 'private' || personalOrganizationIds.has(organization ?? '')
    ? `Synced with ${name}` : `Shared with ${name}`
}

/**
 * The organization a session's thread uploads to. The organization the plugin created the thread
 * under names it, since the CLI's status can report none even for a thread created with one.
 * Undefined for a thread shared without a saved team, or joined, which the caller names by the
 * current organization.
 */
function threadOrganization(binding: Binding): string | undefined {
  return binding.autoUpload?.organization ?? binding.organization ?? binding.upload?.organization_id ?? undefined
}

/**
 * Delta's background upload of an automatic session, drawn on the band's row like a share's steps:
 * its first upload until Delta confirms it, then only a failure. Activation only requests the upload,
 * and Delta registers the thread a moment before it confirms the content, so the link is offered
 * once the upload is confirmed; later per-turn syncs are not shown.
 */
function uploadProgress(binding: Binding | undefined): StatusState['progress'] {
  if (!binding?.autoUpload || !binding.thread) return undefined
  const upload = binding.upload
  if (upload?.state === 'failed')
    return { text: `Sync failed: ${upload.error?.message ?? upload.error?.reason ?? 'unknown reason'}`, tone: 'error' }
  if (binding.uploaded) return undefined
  // Delta reports a failure it retries itself as queued with its error, which is progress, not a failure.
  if (upload?.state === 'queued' && upload.error)
    return { text: `Retrying sync: ${upload.error.message || upload.error.reason || upload.error.code}`, tone: 'active' }
  return { text: upload?.state === 'queued' ? 'Waiting to sync…' : 'Syncing to DeltaDB…', tone: 'active' }
}

/** The operation the band draws: a share, join, or activation step, else an automatic session's upload. */
function currentProgress(): StatusState['progress'] {
  return feed.progress ?? uploadProgress(feed.session ? sessions.get(feed.session)?.binding : undefined)
}

/**
 * The shared thread's link: the watched session's saved binding, which every status inspection keeps
 * current. A URL says a thread exists, not that others can see it; the audience is shown apart.
 * Absent until status reports one, and while a share or join still runs the band shows it dim, without
 * offering it.
 */
function statusLink(): string | undefined {
  if (!feed.session) return
  return conversationWebLink(sessions.get(feed.session)?.binding?.url)
}

/** The status bar's shade for each kind of theme: a step off the terminal's own background. */
const BAR_SHADES = { dark: '#303030', light: '#e8e8e8' }
/** The shade for the person's theme, read once and again whenever they change it. */
let barTheme: keyof typeof BAR_SHADES | undefined

/**
 * The status bar's shade for the person's theme. A terminal that cannot show it as given rounds it
 * to a color it has; at worst the shade is lost and the band reads as a plain row.
 */
async function barShade($: Runtime): Promise<string> {
  if (!barTheme) {
    const theme = (await $.config.list()).find((row) => row.key === 'theme')?.value
    barTheme = typeof theme === 'string' && theme.startsWith('light') ? 'light' : 'dark'
  }
  return BAR_SHADES[barTheme]
}

/** Copy the link to the surface the press came from, and confirm it only once the clipboard took it. */
async function copyLink($: Runtime, link: string, surface: RenderSurface) {
  const result = await $.ui.copy({ text: link, surface })
  if (!result.isCopied) {
    await $.ui.log(`Delta: couldn't copy the link: ${result.reason}`, { to: 'debug' })
    return
  }
  feed.copiedTimer?.cancel()
  const timer = $.clock.after(COPIED_MS, () => {
    if (feed.copiedTimer !== timer) return
    feed.copiedTimer = undefined
    $.ui.invalidate('ui.render')
  })
  feed.copiedTimer = timer
  $.ui.invalidate('ui.render')
}

/** Only the props a segment actually sets, so the surface never sees an undefined style. */
function segmentProps(segment: StatusSegment): TextProps {
  const props: TextProps = {}
  if (segment.color !== undefined) props.color = segment.color
  if (segment.bold) props.bold = true
  if (segment.dim) props.dimColor = true
  if (segment.inverse) props.inverse = true
  return props
}

/** The color the band gives an item's author, so a person reads the same everywhere. */
function authorColor(item: WatchItem): string {
  return personColor(personKey(item.author ?? { user_id: null, name: itemAuthor(item) }))
}

/** Rows wait while Claude's own turn runs or a local prompt is entering, so they never land inside a turn. */
function rowsHeld(session: string) {
  const runtime = stateFor(session)
  return !!runtime.currentTurnId || !!runtime.promptEntering
}

/**
 * The transcript draws one `$.ui.log` entry per call and flattens an embedded newline to U+FFFD, so
 * a person-visible item goes out one entry per paragraph, keeping the line breaks it should have.
 */
function showToPerson($: Runtime, text: string) {
  for (const line of text.split('\n')) $.ui.log(line, { to: 'transcript' })
}

/**
 * Draw a completed message as the output row of the plugin's own `show <id>` command, which is the
 * only plugin-producible transcript row that draws markdown and that redraws with our own tree.
 *
 * The engine runs a plugin's own call with the calling hook alone skipped, and a call from the
 * plugin's background code carries no calling hook, so it skips the plugin's own `command.run` hook
 * altogether. The row therefore waits for a redraw: a `ui.render` hook is a hook context, and the
 * command it raises inside one is answered.
 */
function drawMessage($: Runtime, session: string, id: string): Promise<{ deny?: string }> {
  const result = drawQueue.wait(session, id, () => rowsHeld(session),
    (milliseconds, action) => $.clock.after(milliseconds, action))
  $.ui.invalidate('ui.render')
  return result
}

/**
 * Abandon the rows a stopped conversation was still waiting to draw. They were not added, so the
 * next snapshot offers them again; a stopped watch reports nothing about them.
 */
function dropQueuedDraws() {
  drawQueue.drop()
}

/**
 * Answer the queued message rows, oldest first, from a hook context. Rows wait while a local turn
 * runs, and the queue keeps its order across redraws. Each answer settles the row that queued it.
 */
async function drainMessages($: Runtime) {
  const session = feed.session
  if (drawing || !session || !feed.view) return
  drawing = true
  try {
    while (drawQueue.length) {
      if (feed.session !== session || rowsHeld(session)) break
      const entry = drawQueue.shift()!
      let answer: string | undefined
      try { answer = (await $.command.run({ command: 'delta', args: `show ${entry.id}` })).text }
      catch (error) { entry.settle({ deny: String(error) }); continue }
      entry.settle(answer === undefined || UNANSWERED_COMMAND.test(answer)
        ? { deny: 'this host did not run the plugin\'s own command' }
        : {})
    }
  } finally {
    drawing = false
  }
  if (drawQueue.length) $.ui.invalidate('ui.render')
}

/**
 * Add one model-visible row, and draw a message's copy for the person beside it.
 *
 * The model reads the plugin's own `session.append` row for every kind, so a message is drawn for
 * the person in addition to it, never instead of it. Neither the drawn row nor the model's row is
 * written twice: an item this session already drew is not drawn again, so a retried row repeats
 * neither. A host that will not draw the command output row leaves the model's row alone and shows
 * the person the plain notice.
 */
async function appendRow($: Runtime, session: string, row: PendingRow): Promise<{ deny?: string }> {
  const id = row.commandItem
  const runtime = stateFor(session)
  if (id !== undefined) {
    const drawing = runtime.drawn.drawOnce(id, () => drawMessage($, session, id))
    if (drawing) {
      const refusal = await drawing
      if (refusal.deny === undefined)
        $.ui.log(`Drew the Delta item ${id} as a command output row.`, { to: 'debug' })
      else fallbackNotice($, row, refusal.deny)
    }
  }
  return $.session.append({ message: { type: 'user', content: [{ type: 'text', text: row.text }] } })
}

/** Show a message or comment the plain way, when its command output row is refused; the model's row stands. */
function fallbackNotice($: Runtime, row: PendingRow, reason: string) {
  const view = feed.view
  const commentId = keyedComment(row.id)
  const comment = commentId === undefined ? undefined : view?.comments.get(commentId)
  const item = view?.items.get(row.id)
  const display = !view ? undefined
    : comment ? commentDisplay(comment, view.commentParent(comment), view.commentTarget(comment), view.thread)
    : item ? itemDisplay(item, view.thread) : undefined
  if (display) showToPerson($, display)
  $.ui.log(`Couldn't draw this Delta message as a command row (${reason}).`, { to: 'debug' })
}

/**
 * Add completed remote items to Claude's transcript as model-visible rows, without starting a
 * turn, and correct rows for items that later changed or disappeared. Held rows resume when the
 * prompt is dropped or its turn completes.
 */
function settleRemote($: Runtime, session: string): Promise<void> | undefined {
  if (feed.settling || feed.session !== session) return feed.settling
  const revision = feed.revision
  const owns = () => feed.revision === revision && feed.session === session
  let task: Promise<void> | undefined = undefined
  task = (async () => {
    // Start after `task` is assigned, so a run with nothing to do still clears `settling`.
    await undefined
    try {
      if (!rowsHeld(session)) await flushNotes($, session)
      const view = feed.view
      if (view) await addRows(view, {
        append: (row) => appendRow($, session, row),
        save: (ledger) => $.store.set(ledgerKey(session), ledger),
        held: () => rowsHeld(session),
        current: owns,
        announce: (text) => showToPerson($, text),
        debug: (text) => $.ui.log(text, { to: 'debug' }),
        fail: (reason) => settleFailure($, reason),
      })
    } finally {
      if (feed.settling === task) feed.settling = undefined
    }
    if (owns() && feed.view && !feed.view.settled && !rowsHeld(session)) await settleRemote($, session)
  })()
  feed.settling = task
  return task
}

function settleFailure($: Runtime, reason: string) {
  // Print and SDK sessions keep no conversation a plugin can add rows to; nothing retries that.
  const notice = /keeps no conversation/.test(reason)
    ? `Couldn't add Delta activity to Claude's context: ${reason}. Remote Delta activity isn't available in print or SDK sessions.`
    : `Couldn't add Delta activity to Claude's context: ${reason}. It is offered again when the watcher reconnects.`
  if (feed.settleNotice === notice) return
  feed.settleNotice = notice
  $.ui.log(notice)
}

/** Sync diagnostics can exceed process.run's 4 MiB stdout capture limit, so status streams with a bound. */
async function readThreadStatus(
  $: Runtime, thread: string, session: string, signal = new AbortController().signal,
) {
  return parseThreadStatus(await readCommand($, ['thread', 'status', thread,
    '--source', 'claude-code', '--external-id', session], 'thread status', signal))
}

/**
 * The thread facts a status read carries into the binding: its link, its audience, and Delta's
 * background upload. A URL alone says nothing about who can see the thread, so they stay separate.
 */
function statusFields(status: ThreadStatus): Pick<Binding, 'url' | 'visibility' | 'upload' | 'uploaded'> {
  const url = status.url ?? undefined
  const upload = status.upload ?? undefined
  return {
    url,
    visibility: status.visibility ?? undefined,
    upload,
    // A URL appears when Delta registers the thread, a moment before it confirms the content. The
    // milestone outlives this read, so a later per-turn sync does not reopen the first upload.
    ...url && upload?.state === 'uploaded' ? { uploaded: true as const } : {},
  }
}

/** Save what a status read says about the thread's link, audience, and upload, and redraw the band. */
async function rememberStatus($: Runtime, session: string, status: ThreadStatus) {
  if (active !== session) return
  let published = false
  await serial(async () => {
    const current = await load($, session)
    if (active !== session || !current.thread) return
    const next = { ...current, ...statusFields(status) }
    published = !!current.autoUpload && !current.uploaded && !!next.uploaded
    await save($, next)
  })
  // The first upload ends the way a share does, unless a share or join is drawing its own steps.
  if (published && feed.session === session && !feed.progress && !sharing && !joining)
    finishProgress($, 'Synced to DeltaDB', 'done')
  else {
    syncSpinner($)
    $.ui.invalidate('ui.render')
  }
  followUpload($, session)
}

/**
 * Whether nothing more is expected from Delta's background upload. A session this plugin activated
 * requests the upload and returns before Delta registers the thread, so its link only appears in a
 * later status read; every other session has its link from the share or join that bound it.
 */
function uploadSettled(binding: Binding | undefined): boolean {
  return !binding?.autoUpload || !!binding.uploaded
}

/**
 * Keep reading status, on a backoff, until Delta has registered and confirmed an automatic
 * session's thread, so the band shows its link and audience without waiting for the next delivery.
 * Delta keeps retrying the upload itself; this only observes it.
 */
function followUpload($: Runtime, session: string) {
  const state = sessions.get(session)
  if (!state || active !== session) return
  if (uploadSettled(state.binding)) {
    state.uploadRefreshAttempts = 0
    return
  }
  if (state.uploadRefresh) return
  const attempt = state.uploadRefreshAttempts ?? 0
  state.uploadRefreshAttempts = attempt + 1
  state.uploadRefresh = $.clock.after(reconnectDelay(attempt), () => {
    state.uploadRefresh = undefined
    const binding = state.binding
    if (active !== session || !binding?.thread) return
    void readThreadStatus($, binding.locator ?? binding.thread, producerOf(binding))
      .then((status) => rememberStatus($, session, status))
      // An unanswered read says nothing about the upload; ask again after the next delay.
      .catch(() => followUpload($, session))
  })
}

/** Sign-in's view of the session; `$` stays in this file, as Claude Code's loader requires. */
/** The sign-in waiting on the person's browser, which running a Delta command again offers to stop. */
let browserWait: { on: BrowserWait; stop: AbortController } | undefined

async function authenticationHost($: Runtime): Promise<AuthenticationHost> {
  const windows = await $.env.get('OS') === 'Windows_NT'
  const stop = new AbortController()
  let progress: typeof feed.progress
  return {
    windows,
    sleep: (milliseconds, signal) => $.clock.sleep(milliseconds, { signal }),
    spawn: (argv) => $.process.spawn({ argv }),
    ask: (question, options) => claudeInteraction($).ask(question, { options, header: 'Delta' }),
    open: (url) => openInBrowser($, url, windows),
    waiting: (on) => {
      if (on) {
        browserWait = { on, stop }
        setProgress($, on === 'terms' ? "Waiting for Delta's beta terms…" : 'Waiting for Delta sign-in…', 'active')
        progress = feed.progress
        return
      }
      if (browserWait?.stop === stop) browserWait = undefined
      // What follows sets its own progress; a band still showing the wait would outlive it.
      if (progress && feed.progress === progress) clearProgress($)
    },
    stop: stop.signal,
  }
}

/**
 * Offer to stop a sign-in waiting on the browser, answering whether one was waiting. Whatever waited
 * reports the outcome itself, so the command that asked adds nothing of its own.
 */
async function offerToStopWaiting($: Runtime): Promise<boolean> {
  const wait = browserWait
  if (!wait) return false
  const stop = 'Stop waiting'
  const answer = await claudeInteraction($).ask(wait.on === 'terms'
    ? 'Delta is waiting for you to accept its beta terms in your browser. Stop waiting?'
    : 'Delta is waiting for you to finish signing in with your browser. Stop waiting?',
  { options: [stop, 'Keep waiting'], header: 'Delta' }).catch(() => undefined)
  if (answer === stop) wait.stop.abort()
  return true
}

/**
 * Open a web page in the person's browser, answering whether it opened. macOS has `open`; elsewhere
 * that name is missing or another program, so its failure falls back to the desktop's `xdg-open`.
 */
async function openInBrowser($: Runtime, url: string, windows: boolean): Promise<boolean> {
  const attempts = windows ? [['rundll32', 'url.dll,FileProtocolHandler', url]] : [['open', url], ['xdg-open', url]]
  for (const argv of attempts) {
    const opened = await $.process.run(argv, { timeoutMs: RELEASE_TIMEOUT_MS }).catch(() => ({ exitCode: 1 }))
    if (opened.exitCode === 0) return true
  }
  return false
}

async function resolveCli($: Runtime, allowInstall = false, progress = (text: string) => setProgress($, text, 'active')) {
  return cli.resolve((argv, init) => $.process.run(argv, {
    ...init, env: { ...init?.env, DELTA_CLI_INTEGRATION: 'claude_code' },
  }), allowInstall,
    progress, await $.env.get('OS') === 'Windows_NT'
      ? { exists: (path) => $.fs.exists(path) } : false)
}

async function readCommand($: Runtime, args: string[], name: string, signal: AbortSignal, timeoutMs = 120_000, env: Record<string, string> = {}): Promise<string> {
  if (signal.aborted) throw new Error(`Delta ${name} cancelled`)
  let stream: ReturnType<Runtime['process']['spawn']>
  try {
    const executable = await resolveCli($)
    if (signal.aborted) throw new Error(`Delta ${name} cancelled`)
    stream = $.process.spawn({
      argv: [executable, '--json', ...args],
      env: { ...env, DELTA_CLI_INTEGRATION: 'claude_code' },
    })
  }
  catch (error) { throw new DeltaCommandError('process_failed', `${name}: cannot run Delta CLI (${String(error)})`) }
  return readCommandStream(stream, name, signal,
    (milliseconds, deadline) => $.clock.sleep(milliseconds, { signal: deadline }), timeoutMs)
}

/**
 * Refuse to record against a CLI whose recording contract this plugin does not speak, and return
 * the newest version both speak. Runs once per session; a refusal or a process failure is not
 * remembered, so updating Delta and retrying re-checks. Nor is an answer that arrives after the
 * session ended or was activated again, even under the same ID, so a resumed session renegotiates.
 */
async function requireContract($: Runtime, session: string): Promise<number> {
  const verified = contractVerified.get(session)
  if (verified !== undefined) return verified
  const epoch = sessionEpoch
  const range = await readThreadContract($)
  const refusal = contractRefusal(range)
  if (refusal) throw new ContractRefusalError(refusal)
  const version = contractVersion(range!)
  if (active === session && sessionEpoch === epoch) contractVerified.set(session, version)
  return version
}

/**
 * Ask the CLI which recording contract versions it speaks, using the same invocation the recording
 * helpers use. It answers locally, so the answer needs no delta-app. Unlike `command`, the exit code
 * and empty stdout are inspected first, so a CLI that predates the subcommand (clap's error on
 * stderr, nonzero exit, no JSON) reads as `undefined` rather than a generic malformed-output failure.
 */
async function readThreadContract($: Runtime): Promise<ThreadContract | undefined> {
  let result: Awaited<ReturnType<Runtime['process']['run']>>
  try {
    const executable = await resolveCli($)
    result = await $.process.run([executable, '--json', 'thread', 'contract'], {
      timeoutMs: CONTRACT_TIMEOUT_MS, env: { DELTA_CLI_INTEGRATION: 'claude_code' },
    })
  } catch (error) {
    // The same failure a share or a status read reports when the CLI is missing or cannot start.
    throw new Error(`thread contract: cannot run Delta CLI (${String(error)}). Repair the selected Delta CLI and retry.`)
  }
  if (result.isStdoutTruncated || result.isStderrTruncated)
    throw new Error('thread contract: Delta CLI output truncated; no contract assumed')
  if (result.exitCode !== 0 && !result.stdout.trim()) return undefined
  return parseThreadContract(result.stdout)
}

function stateFor(session: string): SessionState {
  let state = sessions.get(session)
  if (!state) {
    state = { notes: [], unsaved: [], pauses: new Map(), retryAttempts: 0, tools: new ToolRecords(), nativeTurns: new Map(), aborting: new Set(), lostTurns: new Set(), drawn: new DrawnRows() }
    sessions.set(session, state)
  }
  return state
}

/** `notice` tells the person what to do, and is shown when a prompt is refused because of this pause. */
function pauseCheckout(state: SessionState, reason: CheckoutPause, notice?: string) {
  state.pauses.set(reason, notice)
}

function resumeCheckout(state: SessionState, reason: CheckoutPause) {
  state.pauses.delete(reason)
}

function isPaused(state: SessionState) {
  return state.pauses.size > 0
}

function pauseNotice(state: SessionState) {
  return [...state.pauses.values()].find((notice) => notice !== undefined)
    ?? `checkout sharing is paused; ${recoveryAdvice(state.binding)}`
}

function rememberToolResults(tools: ToolRecords, message: ApiMessage) {
  for (const block of message.content) {
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string')
      tools.toolResults.set(block.tool_use_id, block)
    else if (block.type === 'tool_use' && typeof block.id === 'string' && isOmittedTool(block.name))
      tools.omitted.add(block.id)
  }
}

function serial<T>(task: () => Promise<T>): Promise<T> {
  const running = queue.then(task, task)
  queue = running.catch(() => {})
  return running
}

/** Whether `turnId` is the hand-off's one-word turn, which the thread never records. */
function isLocalTurn(runtime: SessionState, turnId: string): boolean {
  return runtime.localTurn?.turnId === turnId
}

/**
 * The turn a row of Claude's own output belongs to, or undefined while that turn's start is not
 * yet staged. `turn.start` writes a turn's scoped running record and is the only thing that
 * assigns it a sequence; output that reaches a hook first waits for it (see `heldRows`) instead
 * of naming the turn before it, which Delta fences as stale output for a finished turn.
 */
function contentTurn(runtime: SessionState): number | undefined {
  const execution = runtime.binding?.execution
  const running = runtime.currentTurnId
  if (running !== undefined) {
    // Only the running turn's own staged start may carry its output.
    if (execution?.turnId === running) return execution.sequence
    // A turn that lost the thread keeps the sequence it had, so Delta fences its late output.
    if (runtime.lostTurns.has(running)) return runtime.binding?.lastTurnSequence
    return undefined
  }
  // No turn runs: late output keeps its turn's sequence, or the latest start's.
  return execution?.sequence ?? runtime.binding?.lastTurnSequence
}

/** Hold rows until the running turn's start fixes the sequence they carry. */
function holdRows(runtime: SessionState, updates: Update[], turnId?: string) {
  runtime.heldRows = [...(runtime.heldRows ?? []), ...updates.map((update) => ({
    update,
    turnId,
    toolId: update.sessionUpdate === 'tool_call_update' && typeof update.toolCallId === 'string'
      ? update.toolCallId : undefined,
  }))]
}

/** Mark a row observed live in this Claude host, without changing imported history. */
function liveActivity(update: Update): Update {
  let activityKind: LiveActivityKind | undefined
  if (update.sessionUpdate === 'user_message' || update.sessionUpdate === 'agent_message' ||
      update.sessionUpdate === 'agent_thought') activityKind = update.sessionUpdate
  else if (update.sessionUpdate === 'tool_call_update') {
    const structuredEdit = Array.isArray(update.content) && update.content.some((item) =>
      item !== null && typeof item === 'object' && !Array.isArray(item) &&
      (item as Record<string, unknown>).type === 'diff')
    activityKind = structuredEdit ? 'edit' : 'tool_call'
  }
  if (!activityKind) return update
  const metadata = update._meta !== null && typeof update._meta === 'object' && !Array.isArray(update._meta)
    ? update._meta as Record<string, unknown> : {}
  const delta = metadata.delta !== null && typeof metadata.delta === 'object' && !Array.isArray(metadata.delta)
    ? metadata.delta as Record<string, unknown> : {}
  return {
    ...update,
    _meta: { ...metadata, delta: { ...delta, ...LIVE_ACTIVITY_ORIGIN, activity_kind: activityKind } },
  }
}

function key(session: string) { return `session:${session}` }
function ledgerKey(session: string) { return `appended:${session}` }

function recoveryCommand(binding?: Binding) {
  const locator = binding?.joinTransition?.locator ?? (binding?.joined ? binding.locator ?? binding.thread : undefined)
  return locator ? `/delta-join ${locator}` : '/delta-share'
}

/**
 * What to tell a person to do next when Delta is not ready. A session this plugin created itself
 * recovers on its own, so its advice never names `/delta share`, which stays the explicit publish
 * action for a manual session.
 */
function recoveryAdvice(binding?: Binding): string {
  return binding?.autoUpload ? 'automatic recording retries on your next prompt' : `run ${recoveryCommand(binding)}`
}

/** Automatic activation has not finished: the binding exposes its thread only once every step succeeded. */
function activationIncomplete(runtime: SessionState): boolean {
  return !!runtime.binding?.autoUpload && !runtime.binding.thread
}

/**
 * A prompt or a resume is an automatic session's repair path: re-run whatever activation steps are
 * missing, using the upload the session already recorded. Every step is idempotent, so this is safe.
 */
function retryAutomaticActivation($: Runtime, session: string, runtime: SessionState) {
  const binding = runtime.binding
  if (binding?.autoUpload && !binding.thread && binding.checkout)
    void activateAutomatically($, session, binding.checkout, binding.autoUpload).catch(() => {})
}

async function save($: Runtime, value: Binding, isCurrent = () => true) {
  // A recording session keeps its transcript's latest path, so a continuation can find the record
  // Claude Code appends there.
  const transcript = transcriptPaths.get(value.session)
  if (transcript && value.thread && value.transcript !== transcript) value = { ...value, transcript }
  await $.store.set(key(value.session), value)
  // A session already ended and pruned must not be recreated by a late write.
  const state = sessions.get(value.session)
  if (state && isCurrent()) state.binding = value
}

async function load($: Runtime, session: string): Promise<Binding> {
  const previous = await $.store.get(key(session)) as Binding | undefined
  if (!previous || previous.session !== session) return { session, snapshot: false, next: 1, pending: [] }
  return restoreBinding(previous)
}

async function digest(input: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(input))
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function stageRecord($: Runtime, binding: Binding, body: RecordBody): Promise<Binding> {
  // The continuing session stages under the same producer; a second writer would reuse its sequences.
  if (binding.continuedIn)
    throw new Error(`this conversation continues in Claude session ${binding.continuedIn}, which records it`)
  return stageOutboxRecord($, producerOf(binding), binding, body)
}

/** Stage one record in the outbox folder `folder`, which holds one recorded conversation's records. */
async function stageOutboxRecord<T extends { next: number; pending: Entry[] }>(
  $: Runtime, folder: string, binding: T, body: RecordBody,
): Promise<T> {
  const sequence = binding.next
  const line = JSON.stringify({ schemaVersion: 1, sequence, ...body }) + '\n'
  const files: string[] = []
  for (const chunk of outboxChunks(line, sequence)) {
    const path = `${outbox}/${folder}/${sequence}-${files.length}.json`
    await $.fs.write(path, chunk)
    files.push(path)
  }
  // Only reference fully written immutable files. An interrupted write leaves orphans.
  binding.pending.push({ sequence, files, digest: await digest(line) })
  binding.next = sequence + 1
  return binding
}

async function writeRecord($: Runtime, binding: Binding, body: RecordBody): Promise<Binding> {
  const next = await stageRecord($, binding, body)
  await save($, next)
  return next
}

async function readRecord($: Runtime, entry: Entry): Promise<string> {
  const line = (await Promise.all(entry.files.map((path) => $.fs.read(path) as Promise<string>))).join('')
  if (await digest(line) !== entry.digest)
    throw new Error(`outbox record ${entry.sequence} changed on disk; sharing paused`)
  return line
}

async function collectAcknowledgedOutbox($: Runtime, plan: CleanupPlan) {
  const { session, root, next, pending } = plan
  if (!/^[A-Za-z0-9_-]+$/.test(session)) throw new Error('Invalid outbox session directory')
  const frontier = pending.reduce((value, entry) => Math.min(value, entry.sequence), next)
  if (frontier <= 1) return
  const directory = `${root}/${session}`
  if (!await $.fs.exists(directory)) return
  const files = acknowledgedOutboxFiles(directory, next, pending, await $.fs.list(directory))
  const windows = await $.env.get('OS') === 'Windows_NT'
  // Keep command lines bounded, including Windows' smaller process argument limit.
  for (let offset = 0; offset < files.length; offset += 64) {
    const removal = outboxRemoval(files.slice(offset, offset + 64), windows)
    const result = await $.process.run(removal.argv, { stdin: removal.stdin, timeoutMs: 30_000 })
    if (result.exitCode !== 0)
      throw new Error(result.stderr.trim() || `file removal exited ${result.exitCode}`)
  }
}

/** Schedule from an acknowledged saved binding, never from mutable staging state. */
function scheduleOutboxCleanup($: Runtime, binding: Binding) {
  const runtime = sessions.get(binding.session)
  // The outbox folder belongs to the session the conversation continued in.
  if (!runtime || binding.continuedIn) return
  runtime.cleanupPlan = {
    session: producerOf(binding), root: outbox, next: binding.next,
    pending: binding.pending.map((entry) => ({ sequence: entry.sequence, files: [...entry.files] })),
  }
  if (runtime.cleanupTask) return
  const task = cleanupOutbox($, binding.session)
  runtime.cleanupTask = task
  void task.finally(() => {
    if (runtime.cleanupTask === task) runtime.cleanupTask = undefined
  }).catch((error) => reportCleanupIssue($, binding.session, `Delta outbox cleanup failed: ${String(error)}`))
}

async function reportCleanupIssue($: Runtime, session: string, message: string) {
  const runtime = stateFor(session)
  const changed = runtime.cleanupError !== message
  runtime.cleanupError = message
  // The error is retained even if the host rejects a diagnostic call.
  // Neither cleanup nor its reporting can be a prerequisite for delivery.
  try { $.ui.invalidate('ui.render') } catch {}
  try { if (changed) await $.ui.log(message, { to: 'transcript' }) }
  catch {}
}

async function cleanupOutbox($: Runtime, session: string) {
  const runtime = stateFor(session)
  while (runtime.cleanupPlan) {
    const plan = runtime.cleanupPlan
    runtime.cleanupPlan = undefined
    const frontier = plan.pending.reduce((value, entry) => Math.min(value, entry.sequence), plan.next)
    if (frontier <= (runtime.cleanedThrough ?? 1)) continue
    try {
      await collectAcknowledgedOutbox($, plan)
      runtime.cleanedThrough = frontier
      const hadError = runtime.cleanupError !== undefined
      runtime.cleanupError = undefined
      try { if (hadError) $.ui.invalidate('ui.render') } catch {}
    } catch (error) {
      const message = `Delivered Delta records could not be removed from the local outbox: ${String(error)}. Delivery can continue; cleanup retries on later acknowledgments or session activation.`
      await reportCleanupIssue($, session, message)
      return
    }
  }
}

async function command($: Runtime, args: string[], name: string, check?: () => Promise<void>, timeoutMs = 120_000, env: Record<string, string> = {}) {
  let result: Awaited<ReturnType<Runtime['process']['run']>>
  try {
    const executable = await resolveCli($)
    if (check) await check()
    result = await $.process.run([executable, '--json', ...args], {
      timeoutMs, env: { ...env, DELTA_CLI_INTEGRATION: 'claude_code' },
    })
  } catch (error) {
    throw new Error(`${name}: cannot run Delta CLI (${String(error)}). Install the matching new Delta CLI and app, and put delta on PATH.`)
  }
  return checkResult(result, name)
}

/** Let the CLI own organization selection and its human-readable result. */
async function organizationCommand($: Runtime, args: string[]) {
  try {
    const executable = await resolveCli($)
    const result = await $.process.run([executable, 'org', ...args], { timeoutMs: 120_000 })
    if (result.isStdoutTruncated || result.isStderrTruncated)
      throw new Error('Delta organization output was truncated; check the selection with /delta-org current.')
    if (result.exitCode !== 0)
      throw new Error(result.stderr.trim() || result.stdout.trim() || `Delta exited with code ${result.exitCode}`)
    return { text: result.stdout.trim() }
  } catch (error) {
    return { text: `Delta organization command failed: ${String(error)}` }
  }
}

/** The directory a binding's records are checked against, or undefined while setup is incomplete. */
function boundDirectory(binding?: Binding): string | undefined {
  if (!binding?.thread) return
  return binding.joined ? binding.directory : binding.checkout
}

/** A joined session runs only with Claude in its directory, so Claude's tools reach every mounted worktree. */
/**
 * Whether Claude works in `directory`: it is the session's project root and the shell is there or
 * below it. Claude's own `cd` in a Bash call moves the shell's directory within the project, so a
 * subdirectory is still the same checkout.
 */
async function isInDirectory($: Runtime, directory: string) {
  const root = await $.session.root()
  if (!samePath(root, directory)) return false
  const current = await $.session.cwd()
  const cwd = pathKey(current, root, directory)
  directory = pathKey(directory, root)
  return cwd === directory || cwd.startsWith(directory.endsWith('/') ? directory : `${directory}/`)
}

async function requireJoinedDirectory($: Runtime, binding: Binding) {
  if (await $.session.id() !== binding.session || !binding.directory || !await isInDirectory($, binding.directory))
    throw new JoinNotReadyError(`This joined session must run in ${binding.directory}. Run /cd ${binding.directory}, then ${recoveryCommand(binding)}; no other checkout will be attached`)
}

/** Status observes the common owner's mounts; watcher lifetime is not checkout ownership. */
async function verifyCheckout($: Runtime, binding: Binding) {
  if (!boundDirectory(binding))
    throw new Error('the checkout has not been attached; saved messages remain queued')
  if (binding.joined) await requireJoinedDirectory($, binding)
  const status = await readThreadStatus($, binding.locator ?? binding.thread!, producerOf(binding))
  validateThreadFrontier(status, binding)
  if (binding.joined) validateJoinedMounts(status, binding.mounts ?? [])
  else validateThreadCheckout(status, binding)
  if (binding.joined) {
    try { await requireJoinedDirectory($, binding) }
    catch { throw new Error('The joined session or directory changed during checkout inspection; participation was not enabled') }
  }
  const runtime = sessions.get(binding.session)
  if (runtime) {
    resumeCheckout(runtime, 'verification')
    runtime.joinFailure = undefined
  }
  await rememberStatus($, binding.session, status)
  return status
}

/**
 * Resolves true only when every pending record was delivered; stopping early because of a pause or
 * session change is not success. Rejects with the refusal, and appends nothing, when the CLI's
 * recording contract is one this plugin does not speak.
 */
async function drainPending($: Runtime, session: string): Promise<boolean> {
    const delivering = () => active === session && sessions.has(session) && !isPaused(sessions.get(session)!)
    while (delivering()) {
      const binding = await serial(async () => load($, session))
      // A conversation that continued in another session delivers from there.
      if (!binding.thread || !binding.pending.length || binding.continuedIn) return true
      // A recovered outbox checks the CLI's contract before its first append, so an incompatible CLI
      // records nothing. An answer that arrives after the session ended or was activated again belongs
      // to that earlier lifetime: it neither appends nor reports, and the current one checks for itself.
      const epoch = sessionEpoch
      try { await requireContract($, session) }
      catch (error) {
        if (!delivering() || sessionEpoch !== epoch) return false
        throw error
      }
      if (!delivering() || sessionEpoch !== epoch) return false
      try { await verifyCheckout($, binding) }
      catch (error) {
        // An unanswered check says nothing about the checkout. A session that records offline still
        // delivers, acknowledged locally, and checks the checkout again once the server answers;
        // any other session waits, and drain decides how long to keep asking.
        const state = sessions.get(session)
        const permanent = classifyCommandFailure(error) === 'permanent'
        if (state && permanent) pauseCheckout(state, 'verification')
        if (permanent || !recordsOffline(session, binding)) throw error
      }
      const { count, fenced, failure } = await appendPending($, {
        reference: binding.locator ?? binding.thread, thread: binding.thread, externalId: producerOf(binding),
        local: recordsOffline(session, binding),
      }, binding.pending)
      if (count) {
        await serial(async () => {
          const current = await load($, session)
          const acknowledged = { ...current, pending: current.pending.slice(count) }
          await save($, acknowledged)
          scheduleOutboxCleanup($, acknowledged)
        })
      }
      // A `fenced` receipt names the turn Delta already superseded. A fence for the running turn
      // stops it now, even if the watcher is lagging or disconnected; a fence for any other
      // sequence, including an earlier turn's late output, changes nothing. Delivery never waits
      // on the stop, so a slow or failed abort cannot hold up the outbox.
      const running = binding.execution?.sequence
      if (running !== undefined && fenced.includes(running))
        void loseExecution($, session, running, 'Shared execution was superseded').catch((error) => report($, error))
      if (failure) throw failure
    }
    return false
}

/**
 * Send the leading pending records to `target.reference` in one bounded append, as `externalId`.
 *
 * Returns how many leading records Delta acknowledged, the turns it fenced among them, and why the
 * rest were not acknowledged. Throws only when the append's outcome is unknown, so nothing counts as
 * acknowledged.
 */
async function appendPending(
  $: Runtime,
  target: { reference: string; thread: string; externalId: string; local: boolean },
  pending: readonly Entry[],
): Promise<{ count: number; fenced: number[]; failure?: DeltaCommandError }> {
  // Keep stdout well below process.run's 4 MiB capture limit.
  const batch: Entry[] = []
  const turnSequences: (number | undefined)[] = []
  let collected = { input: '', bytes: 0, count: 0 }
  for (const entry of pending) {
    const line = await readRecord($, entry)
    const turnSequence = pendingRecordTurn(line, entry.sequence)
    const next = appendBatch(collected, line)
    if (!next) break
    collected = next
    batch.push(entry)
    turnSequences.push(turnSequence)
    if (collected.bytes >= 2_000_000) break
  }
  // Every append names the producer, retries included, so attribution never depends on a live watch.
  const argv = [await resolveCli($), '--json', 'thread', 'append', target.reference,
    '--source', 'claude-code', '--external-id', target.externalId,
    ...target.local ? ['--acknowledge', 'local'] : [],
    '--producer-name', PRODUCER_NAME]
  let result: Awaited<ReturnType<Runtime['process']['run']>>
  try {
    result = await $.process.run(argv, {
      stdin: collected.input, timeoutMs: 120_000, env: { DELTA_CLI_INTEGRATION: 'claude_code' },
    })
  } catch (error) { throw new DeltaCommandError('process_failed', `append did not finish (${String(error)})`) }
  if (result.isStdoutTruncated || result.isStderrTruncated)
    throw new DeltaCommandError('command_failed', 'append output was truncated, so no acknowledgment is assumed')
  const { count, fenced } = acknowledgedPrefix(result.stdout, target.thread,
    batch.map((entry, index) => ({ sequence: entry.sequence, turnSequence: turnSequences[index] })))
  const failure = result.exitCode !== 0 ? appendFailure(result.stdout, result.stderr, result.exitCode)
    : count !== batch.length ? new DeltaCommandError('invalid_acknowledgment', 'the append acknowledgment did not match the records sent')
      : undefined
  return { count, fenced, failure }
}

/** A turn's scoped running record, naming this plugin's version and where Claude runs when known. */
async function runningUpdate($: Runtime): Promise<Update> {
  let producerVersion: string | undefined
  let executionLocation: 'local' | 'remote' | undefined
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))
    if (typeof manifest.version === 'string' && manifest.version.length <= 32 &&
        /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(manifest.version))
      producerVersion = manifest.version
  } catch (error) { await report($, error) }
  try {
    const remote = await $.env.get('CLAUDE_CODE_REMOTE')
    if (remote === 'true') executionLocation = 'remote'
    else if (remote === 'false') executionLocation = 'local'
  } catch (error) { await report($, error) }
  return {
    sessionUpdate: 'state_update', state: 'running',
    ...producerVersion || executionLocation ? { _meta: { delta: {
      ...producerVersion ? { producer_version: producerVersion } : {},
      ...executionLocation ? { execution_location: executionLocation } : {},
    } } } : {},
  }
}

async function beginExecution($: Runtime, session: string, turnId: string) {
  await serial(async () => {
    const running = await runningUpdate($)
    let binding = await load($, session)
    // A delayed completion must not close this new turn. Finish only the stored
    // predecessor, then persist the new start and local identity in one manifest.
    if (binding.execution && !binding.execution.endSequence) {
      binding = await stageRecord($, binding, {
        turnSequence: binding.execution.sequence, update: { sessionUpdate: 'state_update', state: 'idle' },
      })
    }
    const sequence = binding.next
    binding = await stageRecord($, binding, { turnSequence: sequence, update: running })
    binding.execution = { sequence, turnId }
    binding.lastTurnSequence = sequence
    // The composer prompt that started this turn, and any output that reached a hook before this
    // start was written, are recorded under the sequence it just fixed, so each names a real turn.
    // Output held for an earlier turn is dropped: its turn ended without owning this start, and
    // Delta fences it rather than letting it name a turn it does not belong to.
    const runtime = stateFor(session)
    const rows = runtime.heldRows
    if (rows?.length) {
      runtime.heldRows = undefined
      for (const { update, toolId, turnId: owner } of rows) {
        if (owner !== undefined && owner !== turnId) continue
        if (toolId && !runtime.tools.toolTurns.has(toolId)) runtime.tools.toolTurns.set(toolId, sequence)
        binding = await stageRecord($, binding, { update, turnSequence: sequence })
      }
    }
    await save($, binding)
    runtime.nativeTurns.set(turnId, sequence)
  })
}

/**
 * How long a turn completion hook waits for its finish to reach the thread.
 *
 * The host gives a hook about ten seconds and skips one that runs past that budget, so the wait is
 * kept comfortably under it: a normal append is delivered before the hook returns, and a host that
 * exits right after the reply has still delivered it. A slower append keeps draining in the
 * background, and the outbox retries it on the next activation.
 */
const TURN_COMPLETE_DELIVERY_BUDGET_MS = 5_000

/**
 * Stage a turn's idle finish and clear its execution, then deliver it.
 *
 * The finish is durable before this returns. A turn completion hook bounds its delivery to
 * {@link TURN_COMPLETE_DELIVERY_BUDGET_MS}, then continues in the background, so the hook returns
 * within the host's budget and the outbox carries the finish on a later activation. Recovery and
 * shutdown paths keep waiting, so their pending records are delivered.
 */
async function endExecution(
  $: Runtime,
  session: string,
  sequence: number,
  isCurrent = () => true,
  delivery: 'await' | 'bounded' | 'background' = 'await',
  stopReason?: 'end_turn' | 'cancelled' | 'refusal' | 'error',
) {
  await serial(async () => {
    if (!isCurrent()) return
    let binding = await load($, session)
    const execution = binding.execution
    if (!isCurrent() || !execution || execution.sequence !== sequence) return
    if (!execution.endSequence) {
      binding = await stageRecord($, binding, {
        turnSequence: sequence, update: {
          sessionUpdate: 'state_update', state: 'idle',
          ...stopReason ? { stopReason } : {},
          ...stopReason === 'error' ? { error: { code: -32603, message: 'External producer reported an error' } } : {},
        },
      })
    }
    delete binding.execution
    await save($, binding, isCurrent)
  })
  if (!isCurrent()) return
  if (delivery === 'await') await drain($, session)
  else if (delivery === 'background') void drain($, session).catch((error) => report($, error))
  else await deliverWithin($, session, TURN_COMPLETE_DELIVERY_BUDGET_MS)
}

/** Delivers within `budgetMs`, letting the outbox finish a slower append in the background. */
async function deliverWithin($: Runtime, session: string, budgetMs: number): Promise<void> {
  const cancelled = new AbortController()
  const delivery = drain($, session).catch((error) => report($, error))
  const expiry = $.clock.sleep(budgetMs, { signal: cancelled.signal }).catch(() => undefined)
  await Promise.race([delivery, expiry])
  cancelled.abort()
}

async function loseExecution($: Runtime, session: string, sequence: number, reason: string, isCurrent = () => true) {
  const runtime = stateFor(session)
  let turnId = runtime.binding?.execution?.sequence === sequence ? runtime.binding.execution.turnId : undefined
  try {
    await serial(async () => {
      if (!isCurrent()) return
      const binding = await load($, session)
      if (!isCurrent() || binding.execution?.sequence !== sequence) { turnId = undefined; return }
      turnId = binding.execution.turnId
      await save($, { ...binding, execution: { ...binding.execution, lost: true } }, isCurrent)
    })
  } catch (error) { await report($, error) }
  if (!isCurrent()) return
  // Remember the loss so late output keeps this turn's sequence (which Delta fences) instead of
  // waiting for the next turn's start.
  if (turnId) runtime.lostTurns.add(turnId)
  if (!turnId || runtime.nativeTurns.get(turnId) !== sequence)
    return endExecution($, session, sequence, isCurrent)
  if (runtime.aborting.has(turnId)) return
  runtime.aborting.add(turnId)
  try {
    await $.turn.abort({ turnId })
    if (!isCurrent()) return
    await $.ui.log(`${reason}; stopped Claude turn ${turnId}. Already performed tool effects are not rolled back.`, { to: 'transcript' })
  } finally {
    try { await endExecution($, session, sequence, isCurrent) }
    // Hold the guard until the finish is durable, so a duplicate supersession or a fenced receipt
    // for the same turn that is already in flight cannot abort it a second time.
    finally { runtime.aborting.delete(turnId) }
  }
}

async function observeTurn($: Runtime, session: string, turn: ThreadTurn, isCurrent = () => true) {
  const execution = stateFor(session).binding?.execution
  if (!isCurrent() || !execution || execution.sequence !== turn.sequence || execution.endSequence) return
  if (turn.status === 'superseded')
    await loseExecution($, session, turn.sequence, 'Shared execution was superseded', isCurrent)
}

async function recoverExecution($: Runtime, session: string) {
  const runtime = stateFor(session)
  const execution = (await serial(() => load($, session))).execution
  if (!execution) return
  if (execution.turnId && runtime.nativeTurns.has(execution.turnId) && !execution.lost && !execution.endSequence) return
  // Saved Claude IDs are not authority to abort a turn in a new host process.
  // Only a turn observed locally in this module can still be running here.
  if (execution.turnId && runtime.nativeTurns.get(execution.turnId) === execution.sequence)
    await $.turn.abort({ turnId: execution.turnId })
  await endExecution($, session, execution.sequence)
}

async function drain($: Runtime, session: string): Promise<void> {
  if (active !== session || isPaused(stateFor(session))) return
  if (drainTask) {
    await drainTask
    if (active !== session || isPaused(stateFor(session))) return
    if ((await serial(() => load($, session))).pending.length) return drain($, session)
    return
  }
  const task = drainPending($, session).then(async (delivered) => {
    const state = sessions.get(session)
    if (!delivered || active !== session || !state) return
    endDeliveryFailures(state)
    // The session's thread exists now, so children that waited for it can be created.
    for (const child of children.values()) {
      if (child.session === session && child.waitingForParent) void deliverChild($, child)
    }
    if (!state.captureFailure && !isPaused(state)) $.ui.status(undefined)
    // A delivery that succeeds again clears any pinned failure notice.
    $.ui.invalidate('ui.render')
  }, (error) => failDelivery($, session, error))
  drainTask = task
  try { await task }
  finally { if (drainTask === task) drainTask = undefined }
}

/**
 * Classify a failed drain, schedule its retry or pause sharing, and show the user why.
 * Failures that are not Delta command errors, such as a changed outbox file, pass through unchanged.
 * Queued records keep their sequence, so an unchanged retry is always safe.
 */
async function failDelivery($: Runtime, session: string, error: unknown): Promise<never> {
  if (!(error instanceof DeltaCommandError)) throw error
  const state = sessions.get(session)
  // A session that ended or was replaced must not retry, pause, or speak in the active one's transcript.
  if (!state || active !== session) throw new DeltaSendError(error.message, false)
  const decision = deliveryFailure(state, error, state.pauses.has('verification'))
  const { retry: willRetry } = decision
  Object.assign(state, decision.state)
  const failure = new DeltaSendError(error.message, willRetry)
  // The server refused this thread's recorded changes; an offline session keeps its records queued
  // and the band offers the person Fork & Restore or Discard instead of advice to repair a cause.
  const refused = error.code === 'reload_required' && recordsOffline(session, state.binding)
  if (refused) state.refusedOffline = true
  const pausedText = refused
    ? "Delta couldn't publish this thread's offline changes."
    : `Delta sharing paused: ${failure.message}. The message stays queued. ${permanentFailureAdvice(error.code, !!state.binding?.autoUpload, error.reason)}, then ${recoveryAdvice(state.binding)}.`
  if (!willRetry) {
    pauseCheckout(state, decision.pause, pausedText)
  } else scheduleSendRetry($, session, error.hints.retryAfterMs)
  state.retryReason = willRetry ? failure.message : undefined
  const text = willRetry ? `${failure.message}. The message stays queued and sending will be retried.` : pausedText
  // The band is the status surface: it shows the retry or the pause until delivery recovers.
  $.ui.invalidate('ui.render')
  // A repeating failure is shown once however its message varies; the band stays current.
  if (decision.show) {
    await $.ui.log(text, { to: 'transcript' })
  }
  throw failure
}

function endDeliveryFailures(state: SessionState) {
  state.retryAttempts = 0
  state.deliveryNotice = undefined
  state.retryReason = undefined
  state.refusedOffline = false
  state.retryTimer?.cancel()
  state.retryTimer = undefined
}

/** The CLI's `retryAfterMs` can lengthen the exponential backoff but never shorten it, so a tiny hint cannot spin. */
function scheduleSendRetry($: Runtime, session: string, retryAfterMs?: number) {
  const state = sessions.get(session)
  if (!state || active !== session || state.retryTimer) return
  const delay = deliveryRetryDelay(state.retryAttempts++, retryAfterMs)
  // A timer rather than a sleep: the hook that hit the failure may finish long before the retry.
  state.retryTimer = $.clock.after(delay, () => {
    state.retryTimer = undefined
    if (active === session) void drain($, session).catch((error) => report($, error))
  })
}

/**
 * A recorded subagent in this process. Claude stays its executor; Delta records it as an ordinary
 * child thread under the thread of the loop that spawned it, through an outbox of its own.
 */
type ChildRuntime = {
  session: string
  agentId: string
  /** The producer external ID of the loop whose agent sends this run's prompt. */
  sender: string
  /** A foreground child runs inside its parent's turn, so stopping it ends that turn. */
  foreground: boolean
  tools: ToolRecords
  /** Rows waiting for the turn start that fixes the sequence they carry; see `heldRows`. */
  heldRows: HeldRow[]
  currentTurnId?: string
  /** Orders this child's staging, so its sequences follow the order its hooks ran in. */
  queue: Promise<unknown>
  delivering?: Promise<void>
  /** Another delivery was asked for while one ran, so the running one goes round again. */
  redeliver?: boolean
  retryAttempts: number
  retryTimer?: Timer
  /** Why Delta refused this child for good; its records stay queued and nothing retries. */
  refused?: string
  /** The turn Delta took over and Claude was asked to stop, so it is stopped once. */
  stoppedTurn?: number
  /** Watches the child's thread while a turn of it runs, so a takeover in Delta stops it at once. */
  turnWatch?: { sequence: number; stop: () => void }
  /** Its parent had no thread yet; the session's next successful delivery tries again. */
  waitingForParent?: boolean
  /** The detach of its own checkout in flight, which every caller shares. */
  detaching?: Promise<void>
  /**
   * What the next prompt Claude runs it with is recorded as: the message that was sent, without the
   * thread history Claude was handed with it.
   */
  promptText?: string
}
const children = new Map<string, ChildRuntime>()
/** Agents never recorded here: other kinds of agent, and agents spawned by one that is not recorded. */
const unrecordedAgents = new Set<string>()
/** Spawns whose agent ID is not known yet. A child's first hooks can run before its spawn resolves. */
let pendingSpawns = 0
/** The recorded spawns in flight, by the loop that spawned them; their agent IDs are not known yet. */
const spawning: { parent: string; name: string }[] = []
/** What each not-yet-named agent's hooks recorded meanwhile, replayed once its spawn names it. */
const earlyChildSteps = new Map<string, ((child: ChildRuntime) => Promise<void>)[]>()

/** Whether an agent's hooks may concern a recorded child: one already recorded, or one a pending spawn may name. */
function mayRecordChild(agentId: string): boolean {
  return children.has(agentId) || (pendingSpawns > 0 && !unrecordedAgents.has(agentId))
}

function stopReasonOf(e: { isAborted?: boolean; reason?: string }): 'end_turn' | 'cancelled' | 'refusal' | 'error' | undefined {
  return e.isAborted || e.reason === 'aborted' ? 'cancelled'
    : e.reason === 'answer' ? 'end_turn'
    : e.reason === 'refusal' ? 'refusal'
    : e.reason === 'error' ? 'error' : undefined
}

/** Run `step` in order with the child's other steps; a failure is reported and never fails a hook. */
function childStep($: Runtime, child: ChildRuntime, step: () => Promise<void>): Promise<void> {
  const running = child.queue.then(step, step)
  child.queue = running.catch(() => {})
  return running.catch((error) => reportChild($, child, error))
}

/**
 * Run `step` for the recorded child `agentId`, or hold it until a pending spawn names that agent.
 * An agent nobody spawns while this session records is not recorded, so its steps are dropped.
 */
function onChild($: Runtime, agentId: string, step: (child: ChildRuntime) => Promise<void>): Promise<void> {
  const child = children.get(agentId)
  if (child) return childStep($, child, () => step(child))
  if (!unrecordedAgents.has(agentId) && pendingSpawns)
    earlyChildSteps.set(agentId, [...earlyChildSteps.get(agentId) ?? [], step])
  return Promise.resolve()
}

async function loadChild($: Runtime, child: { session: string; agentId: string }): Promise<ChildBinding> {
  const stored = await $.store.get(childKey(child.session, child.agentId)) as ChildBinding | undefined
  if (!stored) throw new Error(`the recorded subagent ${child.agentId} lost its saved state`)
  return restoreBinding(stored) as ChildBinding
}

async function saveChild($: Runtime, binding: ChildBinding) {
  await $.store.set(childKey(binding.session, binding.agentId), binding)
}

function stageChildRecord($: Runtime, binding: ChildBinding, body: RecordBody): Promise<ChildBinding> {
  return stageOutboxRecord($, childOutbox(binding.session, binding.agentId), binding, body)
}

/** Whether this session records the agents it spawns: it records, and its CLI speaks children. */
function recordsChildren(session: string): boolean {
  const binding = stateFor(session).binding
  return !!binding?.snapshot && !binding.joinTransition &&
    (contractVerified.get(session) ?? 0) >= CHILD_CONTRACT_VERSION
}

/**
 * Start recording the agent a spawn named, or resume recording one this session already records.
 * A new child's state is saved before any of its steps run, then the steps its hooks held run.
 */
async function adoptChild($: Runtime, session: string, agentId: string,
    spawn: { parent: string; name: string; foreground: boolean; resumed: boolean }) {
  let child = children.get(agentId)
  if (child) {
    child.sender = spawn.parent
    child.foreground = spawn.foreground
  } else {
    const stored = await $.store.get(childKey(session, agentId)) as ChildBinding | undefined
    // A resumed agent this session never recorded stays unrecorded: its history is not ours.
    if (!stored && spawn.resumed) {
      unrecordedAgents.add(agentId)
      earlyChildSteps.delete(agentId)
      return
    }
    const adopted = newChild(session, agentId, spawn.parent, spawn.foreground)
    child = adopted
    children.set(agentId, adopted)
    // A thread created while its spawn was in flight, for its worktree, may carry another spawn's name.
    if (stored && !spawn.resumed && stored.name !== spawn.name) await childStep($, adopted, async () => {
      const current = await loadChild($, adopted)
      await saveChild($, { ...await stageChildRecord($, current, {
        update: { sessionUpdate: 'session_info_update', title: spawn.name },
      }), name: spawn.name })
    })
    // Saving is the child's first step, so none of its steps can run before its state exists.
    if (!stored) await childStep($, adopted, async () => {
      await saveChild($, { session, agentId, parent: spawn.parent, name: spawn.name, next: 1, pending: [] })
      await rememberChild($, session, agentId)
    })
  }
  const held = earlyChildSteps.get(agentId) ?? []
  earlyChildSteps.delete(agentId)
  for (const step of held) void childStep($, child, () => step(child))
  void deliverChild($, child)
}

/** Begin a child's turn: close any turn left open, stage its scoped start, and place its held rows. */
async function beginChildTurn($: Runtime, child: ChildRuntime, turnId: string, cwd: string) {
  child.currentTurnId = turnId
  let binding = await loadChild($, child)
  if (binding.awaitingSnapshot) return
  const running = await runningUpdate($)
  if (binding.execution)
    binding = await stageChildRecord($, binding, {
      turnSequence: binding.execution.sequence, update: { sessionUpdate: 'state_update', state: 'idle' },
    })
  const sequence = binding.next
  binding = await stageChildRecord($, binding, { turnSequence: sequence, update: running })
  binding.execution = { sequence, turnId }
  binding.lastTurnSequence = sequence
  const rows = child.heldRows
  child.heldRows = []
  for (const { update, toolId, turnId: owner } of rows) {
    if (owner !== undefined && owner !== turnId) continue
    if (toolId && !child.tools.toolTurns.has(toolId)) child.tools.toolTurns.set(toolId, sequence)
    binding = await stageChildRecord($, binding, { update, turnSequence: sequence })
  }
  binding = await placeChild($, binding, cwd)
  await saveChild($, binding)
  void deliverChild($, child)
}

/**
 * Decide, at a child's first turn, whether it works in its parent's checkout, whose worktrees its
 * thread then shares, or apart from it. A run in a checkout of its own, such as an isolated worktree,
 * attaches that checkout to the child's thread while it runs there.
 */
async function placeChild($: Runtime, binding: ChildBinding, cwd: string): Promise<ChildBinding> {
  const root = await gitRoot($, cwd)
  const directory = root ?? cwd
  if (binding.sharesParentCheckout === undefined) {
    const parent = await parentDirectories($, binding)
    binding.sharesParentCheckout = parent.some((candidate) => samePath(candidate, directory))
    binding.directories = binding.sharesParentCheckout ? parent : [directory]
  }
  // An adopted or forked thread runs where Delta already keeps its worktrees, so nothing is attached for it.
  if (!binding.sharesParentCheckout && !binding.adopted && !binding.mountOwner && root && !binding.checkout) binding.checkout = root
  return binding
}

/**
 * The directories a child's parent works in: the session's checkout, or a joined session's directory
 * and each worktree mounted for it; or the directories a recorded parent subagent works in.
 */
async function parentDirectories($: Runtime, binding: Pick<ChildBinding, 'session' | 'parent'>): Promise<string[]> {
  if (binding.parent !== binding.session)
    return (await loadChild($, { session: binding.session, agentId: binding.parent })).directories ?? []
  const session = stateFor(binding.session).binding
  const bound = boundDirectory(session)
  if (!bound) return []
  if (!session?.joined) return [bound]
  // A joined thread with one worktree works in that worktree's own directory.
  const mounted = (session.mounts ?? []).map((mount) => mount.directory)
  return [bound, ...mounted.filter((directory) => !samePath(directory, bound))]
}

/** The directory a child's paths are recorded relative to. */
function childRoot(binding: ChildBinding): string | undefined {
  return binding.directories?.[0] ?? boundDirectory(stateFor(binding.session).binding)
}

/**
 * End a child's turn, or record the whole run of a child found running when recording started. That
 * run's transcript goes into the turn recorded for it then, and a checkout of its own, read from
 * `cwd` in its hook, is attached so its files reach Delta before the run's detach.
 */
async function endChildTurn($: Runtime, child: ChildRuntime, turnId: string | undefined,
    stopReason: 'end_turn' | 'cancelled' | 'refusal' | 'error' | undefined, cwd?: string) {
  if (turnId !== undefined && child.currentTurnId === turnId) child.currentTurnId = undefined
  let binding = await loadChild($, child)
  const snapshot = !!binding.awaitingSnapshot
  if (snapshot) {
    binding = await snapshotChild($, child, binding)
    if (cwd) binding = await placeChild($, binding, cwd)
    await saveChild($, binding)
  }
  const execution = binding.execution
  // A run found going when recording started has no Claude turn id; any end of it ends that turn.
  if (!execution || (execution.turnId !== undefined && execution.turnId !== turnId)) {
    if (snapshot) void deliverChild($, child)
    return
  }
  binding = await stageChildRecord($, binding, {
    turnSequence: execution.sequence, update: {
      sessionUpdate: 'state_update', state: 'idle',
      ...stopReason ? { stopReason } : {},
      ...stopReason === 'error' ? { error: { code: -32603, message: 'External producer reported an error' } } : {},
    },
  })
  delete binding.execution
  await saveChild($, binding)
  child.turnWatch?.stop()
  child.tools.forgetUnpaired(execution.sequence)
  void deliverChild($, child)
}

/**
 * Stage the rows of one message a child's loop stored. A prompt is attributed to the agent that
 * sent it. Like the session's own rows, a row waits for the turn start that fixes its sequence.
 */
async function recordChildMessage($: Runtime, child: ChildRuntime, message: ApiMessage, id: string) {
  let binding = await loadChild($, child)
  if (binding.awaitingSnapshot) return
  rememberToolResults(child.tools, message)
  const root = childRoot(binding)
  const updates = messageUpdates(message, id, child.tools.structuredResults, { root, omitted: child.tools.omitted })
    .map((update) => liveActivity(sentBy(update, child.sender)))
  const prompt = message.role === 'user' && message.content.some((block) => block.type !== 'tool_result')
  const turn = binding.execution?.sequence
  if (turn === undefined && (prompt || child.currentTurnId !== undefined)) {
    // A prompt waits for whichever turn starts next; output waits for the turn Claude runs.
    child.heldRows.push(...updates.map((update) => ({
      update, turnId: prompt ? undefined : child.currentTurnId,
      toolId: update.sessionUpdate === 'tool_call_update' && typeof update.toolCallId === 'string'
        ? update.toolCallId : undefined,
    })))
  } else {
    for (const update of updates) {
      const tool = update.sessionUpdate === 'tool_call_update' && typeof update.toolCallId === 'string'
        ? update.toolCallId : undefined
      if (tool && !child.tools.toolTurns.has(tool)) child.tools.toolTurns.set(tool, turn ?? binding.lastTurnSequence)
      binding = await stageChildRecord($, binding, {
        update, turnSequence: tool ? child.tools.toolTurns.get(tool) : turn ?? binding.lastTurnSequence,
      })
    }
    await saveChild($, binding)
  }
  for (const block of message.content) {
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') child.tools.settle(block.tool_use_id, 'row')
  }
  void deliverChild($, child)
}

/** Stage a child's tool result as its call hook saw it, with the structured output a row lacks. */
async function recordChildToolResult($: Runtime, child: ChildRuntime,
    call: { tool: string; tool_use_id: string; input: unknown }, result: unknown, isError: boolean) {
  let binding = await loadChild($, child)
  if (binding.awaitingSnapshot || child.tools.omitted.has(call.tool_use_id)) return
  const root = childRoot(binding)
  const update = resultUpdate(call.tool_use_id, call.tool, result, isError, root)
  child.tools.structuredResults.set(call.tool_use_id, update)
  const row = child.tools.toolResults.get(call.tool_use_id)
  const updates = (row
    ? messageUpdates({ role: 'user', content: [row] }, `tool-result:${call.tool_use_id}`, child.tools.structuredResults)
    : [{ ...update, status: 'in_progress', name: call.tool, ...toolInfo(call.tool, call.input, root) }]).map(liveActivity)
  const turn = child.tools.toolTurns.get(call.tool_use_id) ?? binding.execution?.sequence ?? binding.lastTurnSequence
  for (const update of updates) binding = await stageChildRecord($, binding, { update, turnSequence: turn })
  await saveChild($, binding)
  child.tools.settle(call.tool_use_id, 'call')
  void deliverChild($, child)
}

/**
 * Record the whole transcript of a child that ran before this session recorded: within the turn
 * recorded for a run still going then, else as history.
 */
async function snapshotChild($: Runtime, child: ChildRuntime, binding: ChildBinding): Promise<ChildBinding> {
  const messages = await $.session.messages({ agentId: child.agentId, as: 'api' })
  if (!Array.isArray(messages)) throw new Error(`the transcript of subagent ${child.agentId} is unavailable`)
  const root = childRoot(binding)
  const tools = new ToolRecords()
  const turnSequence = binding.execution?.sequence
  for (const [index, message] of snapshotMessages(messages).entries()) {
    rememberToolResults(tools, message)
    for (const update of messageUpdates(message, `snapshot:${index}`, undefined, { root, omitted: tools.omitted }))
      binding = await stageChildRecord($, binding, { update: sentBy(update, child.sender), ...turnSequence ? { turnSequence } : {} })
  }
  delete binding.awaitingSnapshot
  await saveChild($, binding)
  return binding
}

async function gitRoot($: Runtime, cwd: string): Promise<string | undefined> {
  try {
    const result = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd })
    return result.exitCode === 0 && !result.isStdoutTruncated ? result.stdout.trim() || undefined : undefined
  } catch { return undefined }
}

/**
 * Create the child's thread, attach a checkout of its own, and deliver its queued records. A child
 * whose parent has no thread yet waits for the next delivery. One delivery runs at a time; asking
 * again while one runs makes it go round once more.
 */
function deliverChild($: Runtime, child: ChildRuntime): Promise<void> {
  if (child.delivering) {
    child.redeliver = true
    return child.delivering
  }
  const task = (async () => {
    do {
      child.redeliver = false
      await deliverChildOnce($, child)
    } while (child.redeliver)
    child.retryAttempts = 0
  })().catch((error) => failChildDelivery($, child, error))
  child.delivering = task.finally(() => { child.delivering = undefined })
  return child.delivering
}

async function deliverChildOnce($: Runtime, child: ChildRuntime) {
  if (child.refused || !children.has(child.agentId)) return
  const session = await serial(() => load($, child.session))
  child.waitingForParent = !session.thread
  if (!session.thread) return
  let binding = await loadChild($, child)
  if (!binding.thread) {
    // Whether its thread shares its parent's worktrees is known once the child starts working.
    if (binding.sharesParentCheckout === undefined) return
    const parent = child.session === binding.parent ? session.locator ?? session.thread : await childReference($, child, binding.parent)
    child.waitingForParent = !parent
    if (!parent) return
    const created = await createChildThread($, child.agentId, parent, binding.name,
      binding.sharesParentCheckout ? 'shared' : undefined)
    await childStep($, child, async () => {
      await saveChild($, { ...await loadChild($, child), thread: created.thread_id, reference: created.reference })
    })
    binding = await loadChild($, child)
  }
  if (binding.checkout && !binding.checkoutReference) {
    const attached = await command($, ['worktree', 'attach', binding.checkout, '--thread', binding.reference!], 'worktree attach')
    validateAttachmentReceipt(attached, binding.checkout)
    await childStep($, child, async () => {
      await saveChild($, { ...await loadChild($, child), checkoutReference: attached.reference })
    })
    binding = await loadChild($, child)
  }
  watchChildTurn($, child, binding)
  while (binding.pending.length) {
    const { count, fenced, failure } = await appendPending($, {
      reference: binding.reference!, thread: binding.thread!, externalId: child.agentId,
      local: recordsOffline(child.session, session),
    }, binding.pending)
    if (count) {
      let acknowledged!: ChildBinding
      await childStep($, child, async () => {
        const current = await loadChild($, child)
        acknowledged = { ...current, pending: current.pending.slice(count) }
        await saveChild($, acknowledged)
      })
      // Delivery runs one at a time per child, so its cleanup needs no queue of its own.
      void collectAcknowledgedOutbox($, {
        session: childOutbox(child.session, child.agentId), root: outbox, next: acknowledged.next,
        pending: acknowledged.pending.map((entry) => ({ sequence: entry.sequence, files: [...entry.files] })),
      }).catch((error) => reportChild($, child, error))
    }
    // Delta fenced the running turn: someone took the child over in Delta, so Claude stops it.
    const running = binding.execution?.sequence
    if (running !== undefined && fenced.includes(running)) takeOverChild($, child, running)
    if (failure) throw failure
    binding = await loadChild($, child)
  }
  // A checkout of its own is attached only while the child runs there; once nothing runs and what it
  // recorded is delivered, the thread keeps Delta's copy and the checkout is Claude's again.
  if (!binding.execution && binding.checkoutReference) await detachChildCheckout($, child)
}

/** Create or reuse the subagent `agentId`'s child thread under `parent`, with its parent's worktrees or forks of them. */
async function createChildThread($: Runtime, agentId: string, parent: string, name: string,
    worktrees: 'shared' | 'isolated' | undefined): Promise<{ thread_id: string; reference: string }> {
  const created = await command($, ['thread', 'create', '--source', 'claude-code', '--external-id', agentId,
    '--parent', parent, '--name', name, ...worktrees ? [`--${worktrees}-worktrees`] : []], 'thread create')
  validateCreationReceipt(created)
  if (typeof created.reference !== 'string' || !created.reference)
    throw new Error('thread create: Delta returned no reference for the subagent\'s thread')
  return { thread_id: created.thread_id, reference: created.reference }
}

function takeOverChild($: Runtime, child: ChildRuntime, sequence: number) {
  if (child.stoppedTurn === sequence) return
  child.stoppedTurn = sequence
  void stopChild($, child)
}

/**
 * While a child's turn runs, watch its thread so a stop or a message in Delta, which supersedes that
 * turn, stops Claude within moments rather than at the child's next append, which a long tool call
 * can hold back. A watch that fails is reported and not retried: the next append's fence still stops
 * the turn.
 */
function watchChildTurn($: Runtime, child: ChildRuntime, binding: ChildBinding) {
  const sequence = binding.execution?.sequence
  const reference = binding.reference
  if (sequence === undefined || !reference || child.turnWatch?.sequence === sequence) return
  child.turnWatch?.stop()
  let stopped = false
  let stream: ReturnType<Runtime['process']['spawn']> | undefined
  const watch = {
    sequence,
    stop: () => {
      stopped = true
      void stream?.return({ code: null, signal: 'SIGTERM' }).catch(() => {})
    },
  }
  child.turnWatch = watch
  void (async () => {
    const argv = [await resolveCli($), '--json', 'thread', 'watch', reference,
      '--source', 'claude-code', '--external-id', child.agentId]
    // The turn may have ended while the delivery that asked for this watch ran.
    if (stopped || (await loadChild($, child)).execution?.sequence !== sequence) return
    stream = $.process.spawn({ argv, env: { DELTA_CLI_INTEGRATION: 'claude_code' } })
    let pending = ''
    while (!stopped) {
      const piece = await stream.next()
      if (piece.done || stopped) return
      if (piece.value.stream !== 'stdout') continue
      pending += piece.value.text
      if (pending.length > MAX_LINE) throw new Error('Delta watch event exceeds the watcher limit')
      let end: number
      while ((end = pending.indexOf('\n')) >= 0) {
        const event = parseWatchEvent(pending.slice(0, end))
        pending = pending.slice(end + 1)
        if (event?.type === 'error') throw event.error
        const turn = event?.type === 'producer.turn' ? event : event?.type === 'ready' ? event.producer?.turn : undefined
        if (turn?.sequence === sequence && turn.status === 'superseded') {
          if ((await loadChild($, child)).execution?.sequence === sequence) takeOverChild($, child, sequence)
          return
        }
      }
    }
  })().catch((error) => reportChild($, child, error)).finally(() => {
    watch.stop()
    if (child.turnWatch === watch) child.turnWatch = undefined
  })
}

/** How long a child's `turn.complete` hook delivers before detaching; see `finishChildRun`. */
const CHILD_FINISH_DELIVERY_BUDGET_MS = 3_000
/** How long detaching a finished child's checkout may take within its hook's budget. */
const CHILD_DETACH_TIMEOUT_MS = 4_000

/**
 * After a child's run ends, deliver what it recorded within a short budget, then stop sharing a
 * checkout of its own. Claude may remove that worktree as soon as the run's completion hooks
 * return, so the detach happens before this hook does; delivery that takes longer continues on its
 * own.
 */
async function finishChildRun($: Runtime, child: ChildRuntime) {
  const expiry = new AbortController()
  await Promise.race([
    deliverChild($, child),
    $.clock.sleep(CHILD_FINISH_DELIVERY_BUDGET_MS, { signal: expiry.signal }).catch(() => undefined),
  ])
  expiry.abort()
  await detachChildCheckout($, child)
  await noteForkMerge($, child)
}

/** A word for a POSIX shell, quoted unless it is plainly safe as it is. */
function shellQuote(word: string): string {
  return /^[\w@%+=:,./#-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`
}

/**
 * A subagent that worked in a Delta fork has no branch in this repository for Claude to merge, so
 * its parent is told how to bring the fork's changes into its own checkout.
 */
async function noteForkMerge($: Runtime, child: ChildRuntime) {
  try {
    const binding = await loadChild($, child)
    if (!binding.mountOwner || binding.adopted || !binding.reference) return
    const parent = await parentReference($, child.session, binding.parent)
    if (!parent) return
    await deliverNote($, child.session, `[Delta] The subagent "${binding.name}" worked in its own copy of this checkout ` +
      'in Delta, not in a git branch of this repository. To bring its changes into the checkout it was forked from, run: ' +
      `${shellQuote(await resolveCli($))} thread merge ${shellQuote(binding.reference)} --into ${shellQuote(parent)}`)
  } catch (error) { await reportChild($, child, error) }
}

/** The reference of the thread `parent`, the session or a recorded subagent, records into, once that thread exists. */
async function parentReference($: Runtime, session: string, parent: string): Promise<string | undefined> {
  if (parent !== session) return (await loadChild($, { session, agentId: parent }).catch(() => undefined))?.reference
  const binding = await serial(() => load($, session))
  return binding.locator ?? binding.thread
}

/** Detach a child's own checkout from its thread once no run of it is going on, once at a time. */
function detachChildCheckout($: Runtime, child: ChildRuntime): Promise<void> {
  child.detaching ??= detachChildCheckoutOnce($, child).finally(() => { child.detaching = undefined })
  return child.detaching
}

async function detachChildCheckoutOnce($: Runtime, child: ChildRuntime) {
  const binding = await loadChild($, child).catch(() => undefined)
  if (!binding || binding.execution || !binding.thread || !binding.checkout || !binding.checkoutReference) return
  try {
    await command($, ['worktree', 'unmount', binding.checkoutReference, binding.checkout, '--thread', binding.thread],
      'worktree unmount', undefined, CHILD_DETACH_TIMEOUT_MS)
  } catch (error) {
    await reportChild($, child, error)
    return
  }
  await childStep($, child, async () => {
    const current = await loadChild($, child)
    if (current.execution) return
    delete current.checkout
    delete current.checkoutReference
    await saveChild($, current)
  })
}

/** The reference of a recorded parent subagent's thread, creating that thread first when needed. */
async function childReference($: Runtime, child: ChildRuntime, parentAgentId: string): Promise<string | undefined> {
  const parent = children.get(parentAgentId)
  if (!parent) throw new Error(`the subagent ${child.agentId}'s parent ${parentAgentId} is not recorded`)
  await deliverChild($, parent)
  return (await loadChild($, parent)).reference
}

/**
 * A refusal stops the child's delivery and is shown once; anything else retries with backoff. A
 * child's failure never pauses the session or its other children.
 */
async function failChildDelivery($: Runtime, child: ChildRuntime, error: unknown) {
  const binding = await loadChild($, child).catch(() => undefined)
  const name = binding?.name ?? child.agentId
  if (error instanceof DeltaCommandError && classifyCommandFailure(error) === 'permanent') {
    child.refused = String(error)
    await $.ui.log(`Delta stopped recording the subagent "${name}": ${String(error)}. Its records stay queued.`, { to: 'transcript' })
    return
  }
  if (child.retryTimer) return
  const retryAfterMs = error instanceof DeltaCommandError ? error.hints.retryAfterMs : undefined
  child.retryTimer = $.clock.after(deliveryRetryDelay(child.retryAttempts++, retryAfterMs), () => {
    child.retryTimer = undefined
    void deliverChild($, child)
  })
}

async function reportChild($: Runtime, child: ChildRuntime, error: unknown) {
  try { await $.ui.log(`Delta could not record the subagent ${child.agentId}: ${String(error)}`, { to: 'debug' }) }
  catch { /* reporting never fails a hook */ }
}

/**
 * Stop a child Delta took over. A background child is stopped on its own; a foreground child runs
 * inside its parent's turn, which stops with it.
 */
async function stopChild($: Runtime, child: ChildRuntime) {
  try {
    let name = ''
    // The parent hears Delta's reply when Delta's turn ends, as it would have heard the subagent's.
    await childStep($, child, async () => {
      const binding = await loadChild($, child)
      name = binding.name
      await saveChild($, { ...binding, awaited: 'delta' })
    })
    if (child.foreground) {
      const turnId = stateFor(child.session).currentTurnId
      if (turnId) await $.turn.abort({ turnId })
    } else await $.tool.call({ tool: 'TaskStop', task_id: child.agentId } as never)
    await $.ui.log(`Someone took over the subagent "${name}" in Delta, so Claude stopped it. Tool effects it already made are not rolled back.`, { to: 'transcript' })
    await deliverNote($, child.session, `[Delta] Someone took over the subagent "${name}" in Delta, so Claude stopped its run here. Delta's agent continues it in that thread; its reply is added here when Delta's turn ends. Send "${name}" a message with SendMessage to run it here again.`)
  } catch (error) { await reportChild($, child, error) }
}

/*
 * Delta threads as Claude's own subagents. A SendMessage that names a thread of this session's Delta
 * conversation, or a Delta link, runs that thread here: a subagent already recorded for it resumes,
 * told what happened in Delta since it last ran, and any other thread gets a subagent of its own that
 * starts from the thread's history and works in the thread's worktrees. Its turns are recorded on that
 * thread as any recorded subagent's are, and whoever sends a thread a message runs its turn.
 */

/** How long reading a thread's snapshot may take. */
const THREAD_READ_TIMEOUT_MS = 15_000
/** How long a read waits past going live for the worktrees, which a watch reports after its items. */
const THREAD_WORKTREES_GRACE_MS = 3_000

/**
 * A thread's id, items, and worktrees as one watch's snapshot reports them, and who runs its turn
 * when one is running.
 */
type ThreadRead = { thread_id: string; items: WatchItem[]; worktrees: string[]; running?: { name: string | null } }

/**
 * Read a thread's snapshot once: its items, which come before the watch goes live, and its
 * worktrees, which come after; a CLI that reports no worktrees is waited on only briefly.
 */
async function readThread($: Runtime, reference: string): Promise<ThreadRead> {
  const stream = $.process.spawn({
    argv: [await resolveCli($), '--json', 'thread', 'watch', reference],
    env: { DELTA_CLI_INTEGRATION: 'claude_code' },
  })
  let expired = false
  const timer = $.clock.after(THREAD_READ_TIMEOUT_MS, () => {
    expired = true
    void stream.return({ code: null, signal: 'SIGTERM' }).catch(() => {})
  })
  const items = new Map<string, WatchItem>()
  let thread: string | undefined
  let worktrees: string[] | undefined
  let running: ThreadRead['running']
  let live = false
  let grace: Timer | undefined
  let pending = ''
  const result = (): ThreadRead => ({ thread_id: thread!, items: [...items.values()], worktrees: worktrees ?? [], running })
  try {
    for (;;) {
      const piece = await stream.next()
      if (piece.done) {
        if (live && !expired) return result()
        throw new Error(expired ? `reading the Delta thread ${reference} timed out` : `Delta could not read the thread ${reference}`)
      }
      if (piece.value.stream !== 'stdout') continue
      pending += piece.value.text
      if (pending.length > MAX_LINE) throw new Error('Delta watch event exceeds the watcher limit')
      let end: number
      while ((end = pending.indexOf('\n')) >= 0) {
        const event = parseWatchEvent(pending.slice(0, end))
        pending = pending.slice(end + 1)
        if (event?.type === 'error') throw event.error
        if (event?.type === 'ready') thread = event.thread_id
        else if (event?.type === 'item') items.set(event.item.id, event.item)
        else if (event?.type === 'item.append') {
          const item = items.get(event.id)
          if (item) items.set(event.id, { ...item, content: { ...item.content, text: `${item.content.text ?? ''}${event.text}` } })
        } else if (event?.type === 'remove') items.delete(event.id)
        else if (event?.type === 'worktrees') worktrees = event.worktrees.map((tree) => tree.reference)
        else if (event?.type === 'turn') running = event.state === 'running' ? { name: event.user?.name ?? null } : undefined
        else if (event?.type === 'live') {
          if (!thread) throw new Error('Thread activity arrived before readiness')
          live = true
          grace = $.clock.after(THREAD_WORKTREES_GRACE_MS, () => {
            void stream.return({ code: null, signal: 'SIGTERM' }).catch(() => {})
          })
        }
        if (live && worktrees) return result()
      }
    }
  } finally {
    timer.cancel()
    grace?.cancel()
    void stream.return({ code: null, signal: 'SIGTERM' }).catch(() => {})
  }
}

/**
 * The actor Delta records a child's output as on this device, which tells its own items from
 * everyone else's. Read once, after the child first recorded, and kept with its binding.
 */
async function childActor($: Runtime, child: ChildRuntime): Promise<string | undefined> {
  const binding = await loadChild($, child)
  if (binding.actorId || !binding.reference) return binding.actorId
  const actorId = (await readThreadStatus($, binding.reference, child.agentId)).producer?.actor_id ?? undefined
  if (actorId) await childStep($, child, async () => saveChild($, { ...await loadChild($, child), actorId }))
  return actorId
}

/**
 * Running a thread someone else is running takes it over, which only the person may decide: they are
 * asked, and a session that cannot ask leaves the thread alone. Returns why the send is refused, or
 * undefined to go ahead.
 */
async function takeoverRefusal($: Runtime, name: string, running: { name: string | null }): Promise<string | undefined> {
  const who = conversationText(running.name ?? '').trim() || 'someone'
  const refusal = `The Delta thread "${name}" is running in Delta (${who}), so Claude left it alone. ` +
    'Try again once it is idle, or ask the person to let Claude take it over.'
  if (!hasInteractiveSurface(await $.session.surfaces())) return refusal
  try {
    const answer = await claudeInteraction($).ask(
      `Claude wants to take over "${name}", which ${who} is running in Delta. Take it over?`,
      [TAKE_OVER, 'Leave it running'])
    return answer === TAKE_OVER ? undefined : refusal
  } catch {
    return refusal
  }
}

const TAKE_OVER = 'Take it over'

async function childForThread($: Runtime, session: string, thread: string): Promise<ChildRuntime | undefined> {
  for (const child of children.values()) {
    if (child.session !== session) continue
    const binding = await loadChild($, child).catch(() => undefined)
    if (binding?.thread === thread) return child
  }
}

/** The thread a running adoption spawns a subagent for, which that spawn's hook binds it to. */
let adoption: { session: string; prompt: string; binding: Omit<ChildBinding, 'agentId'>; text: string } | undefined

/**
 * Run a thread `to` names with `text`, or leave the send to Claude: undefined when `to` names no
 * thread. A subagent already recorded for the thread is resumed by Claude's own delivery, readdressed
 * to it; any other thread gets a subagent here.
 */
async function sendToThread($: Runtime, session: string, sender: string, to: string, text: string,
    next: (to: string, text: string) => Promise<{ isDelivered: true } | { isDelivered: false; reason: string }>) {
  let child = children.get(to)
  if (child && child.session !== session) child = undefined
  let target: ThreadTarget | undefined
  if (!child) {
    const listed = feed.session === session ? namedThread(to, feed.children) : undefined
    if (listed) {
      child = await childForThread($, session, listed.thread_id)
      if (!child && listed.reference) target = { reference: listed.reference, name: listed.name, thread_id: listed.thread_id }
    } else if (looksLikeThreadLink(to)) target = { reference: to.trim(), name: to.trim() }
    else {
      const named = [...children.values()].filter((candidate) => candidate.session === session)
      for (const candidate of named) {
        const binding = await loadChild($, candidate).catch(() => undefined)
        if (binding?.name.trim().toLowerCase() === to.trim().toLowerCase()) { child = candidate; break }
      }
    }
  }
  if (child) return resumeThread($, child, text, next)
  if (target) return runThread($, session, sender, target, text)
}

/**
 * Message a recorded subagent: one running now gets it in its turn, recorded there; a finished one
 * resumes with it, after what happened in its thread in Delta since it last ran.
 */
async function resumeThread($: Runtime, child: ChildRuntime, text: string,
    next: (to: string, text: string) => Promise<{ isDelivered: true } | { isDelivered: false; reason: string }>) {
  const binding = await loadChild($, child)
  if (binding.execution) {
    const result = await next(child.agentId, text)
    // Claude hands a running loop the message as a row this plugin does not record, so it is recorded here.
    if (result.isDelivered)
      await childStep($, child, () => recordChildMessage($, child, { role: 'user', content: [{ type: 'text', text }] }, `send:${crypto.randomUUID()}`))
    return result
  }
  let prompt = text
  if (binding.reference) {
    try {
      const read = await readThread($, binding.reference)
      const refusal = read.running && await takeoverRefusal($, binding.name, read.running)
      if (refusal) return { isDelivered: false as const, reason: refusal }
      const since = itemsSince(read.items, await childActor($, child))
      prompt = resumePrompt(binding.name, historyText(since, binding.reference, HISTORY_BUDGET), text)
      const last = read.items.at(-1)
      if (last) await childStep($, child, async () => saveChild($, { ...await loadChild($, child), reportedItem: last.id }))
    } catch (error) { await reportChild($, child, error) }
  }
  child.promptText = text
  const result = await next(child.agentId, prompt)
  if (!result.isDelivered) child.promptText = undefined
  return result
}

/**
 * Start a subagent on a thread Claude never ran: it begins from the thread's history and works where
 * the thread's worktrees are, in this session's checkout when it shares them, else in a mount of its
 * own. Claude reports nothing of a subagent a plugin starts, so the parent is told its reply here.
 */
async function runThread($: Runtime, session: string, sender: string, target: ThreadTarget, text: string) {
  const read = await readThread($, target.reference)
  if (await childForThread($, session, read.thread_id))
    return { isDelivered: false as const, reason: `Claude already runs the Delta thread "${target.name}"; message it by that name.` }
  const refusal = read.running && await takeoverRefusal($, target.name, read.running)
  if (refusal) return { isDelivered: false as const, reason: refusal }
  if (!read.worktrees.length)
    return { isDelivered: false as const, reason: `The Delta thread "${target.name}" has no worktree for Claude to work in.` }
  const name = target.name === target.reference
    ? (await readThreadStatus($, target.reference, session).catch(() => undefined))?.title?.trim() || 'Delta thread'
    : target.name
  const root = stateFor(session).binding
  const rootWorktrees = feed.session === session ? feed.worktrees ?? [] : []
  const shares = read.worktrees.every((tree) => rootWorktrees.includes(tree))
  let cwd: string | undefined
  let directories: string[]
  let mountOwner: string | undefined
  if (shares) {
    cwd = boundDirectory(root)
    directories = await parentDirectories($, { session, parent: session })
  } else {
    mountOwner = `${session}-${read.thread_id.slice(-12)}`
    const mounted = await mountThread($, { session, thread: read.thread_id, locator: target.reference, owner: mountOwner },
      { folder: read.worktrees.length > 1 })
    requireMounted(mounted, read.thread_id)
    cwd = mounted.directory
    directories = [mounted.directory]
  }
  if (!cwd) return { isDelivered: false as const, reason: 'This session has no checkout for the thread to work in.' }
  const prompt = adoptionPrompt(name, historyText(read.items.filter((item) => !item.open), target.reference, HISTORY_BUDGET), text)
  const binding: Omit<ChildBinding, 'agentId'> = {
    session, parent: sender, name, thread: read.thread_id, reference: target.reference, next: 1, pending: [],
    sharesParentCheckout: shares, directories, adopted: true, awaited: 'claude',
    ...mountOwner ? { mountOwner } : {}, ...read.items.length ? { reportedItem: read.items.at(-1)!.id } : {},
  }
  adoption = { session, prompt, binding, text }
  pendingSpawns++
  try {
    const spawned = await $.agent.spawn({ prompt, description: name, subagentType: 'general-purpose', cwd })
    if ('deny' in spawned) return { isDelivered: false as const, reason: String(spawned.deny) }
    await adoptThread($, spawned.agentId)
    return { isDelivered: true as const }
  } finally {
    adoption = undefined
    pendingSpawns--
    if (!pendingSpawns) earlyChildSteps.clear()
  }
}

/** Record the subagent a thread's adoption spawned as that thread's, once. */
async function adoptThread($: Runtime, agentId: string) {
  const adopting = adoption
  if (!adopting || children.has(agentId)) return
  const child = newChild(adopting.session, agentId, adopting.binding.parent, false)
  child.promptText = adopting.text
  children.set(agentId, child)
  // Taken now: the spawn may resolve, and the held steps be cleared, while the binding saves.
  const held = earlyChildSteps.get(agentId) ?? []
  earlyChildSteps.delete(agentId)
  void childStep($, child, async () => {
    await saveChild($, { ...adopting.binding, agentId })
    await rememberChild($, adopting.session, agentId)
  })
  for (const step of held) void childStep($, child, () => step(child))
  void deliverChild($, child)
}

/** Tell the parent the reply of a thread it is waiting on, as Claude tells it a subagent's. */
async function reportReply($: Runtime, session: string, text: string) {
  try { await $.prompt.submit({ text }) }
  catch (error) {
    // A host that takes no plugin prompt still gets the reply into Claude's context.
    await $.ui.log(`Couldn't hand Claude a Delta thread's reply: ${String(error)}`, { to: 'debug' })
    await deliverNote($, session, text)
  }
}

/** A thread the plugin started Claude on finished its first run: Claude says nothing of it, so the parent is told. */
async function reportClaudeRun($: Runtime, child: ChildRuntime) {
  let awaited = false
  let name = ''
  await childStep($, child, async () => {
    const binding = await loadChild($, child)
    if (binding.awaited !== 'claude') return
    awaited = true
    name = binding.name
    const { awaited: _, ...rest } = binding
    await saveChild($, rest)
  })
  if (!awaited) return
  const messages = await $.session.messages({ agentId: child.agentId })
  const reply = Array.isArray(messages) ? messages.filter((message) => message.role === 'assistant' && message.text.trim()).at(-1)?.text : undefined
  await reportReply($, child.session, finishedReport(name, reply?.trim()))
}

/** The last status each thread of the watched conversation reported, to see a turn of it end. */
const threadStatuses = new Map<string, string>()
/** The names of the threads the parent was last told it can message. */
let notedThreads: string | undefined

/**
 * Follow the conversation's threads: tell the parent which it can message when that changes, and
 * when a turn Delta's agent ran in a thread this session runs ends, what it said.
 */
function observeThreads($: Runtime, session: string) {
  for (const thread of feed.children) {
    const before = threadStatuses.get(thread.thread_id)
    threadStatuses.set(thread.thread_id, thread.status)
    if (before === 'running' && thread.status !== 'running' && thread.status !== 'queued' && thread.reference)
      void reportDeltaTurn($, session, thread).catch((error) => report($, error))
  }
  const listed = feed.children.filter((thread) => thread.reference).map((thread) => ({ name: thread.name, status: thread.status }))
  const names = JSON.stringify(listed.map((thread) => thread.name).sort())
  if (names !== notedThreads && listed.length) {
    notedThreads = names
    const note = threadsNote(listed)
    if (note) void deliverNote($, session, note).catch((error) => report($, error))
  }
}

/**
 * A thread this session runs finished a turn that was not Claude's: tell the parent what Delta said,
 * starting a turn when it waits on that thread, else as context for its next one.
 */
async function reportDeltaTurn($: Runtime, session: string, thread: WatchChild) {
  const child = await childForThread($, session, thread.thread_id)
  if (!child) return
  const binding = await loadChild($, child)
  if (binding.execution || !binding.reference) return
  const read = await readThread($, binding.reference)
  const actor = await childActor($, child)
  // A turn of Claude's own ending is no news to the parent.
  const lastTurn = [...read.items].reverse().find((item) => item.turn_id !== null)
  if (!lastTurn || isOwnItem(lastTurn, actor)) return
  let since = itemsSince(read.items, actor)
  const reported = since.findIndex((item) => item.id === binding.reportedItem)
  if (reported >= 0) since = since.slice(reported + 1)
  const text = deltaTurnReport(binding.name, since, binding.reference)
  let awaited = false
  await childStep($, child, async () => {
    const current = await loadChild($, child)
    awaited = current.awaited === 'delta'
    const { awaited: _, ...rest } = current
    await saveChild($, { ...rest, ...read.items.length ? { reportedItem: read.items.at(-1)!.id } : {} })
  })
  if (!text) return
  if (awaited) await reportReply($, session, text)
  else await deliverNote($, session, text)
}

/**
 * Create an isolated subagent's thread with a fork of its parent's worktrees and mount it for the
 * subagent to work in. Returns the checkout's directory, or undefined when the session does not
 * record yet or the parent has no worktrees to fork, which leaves Claude to make a worktree of its own.
 */
async function forkChild($: Runtime, session: string, agentId: string, parent: string, name: string): Promise<string | undefined> {
  const reference = await parentReference($, session, parent)
  if (!reference) return
  const created = await createChildThread($, agentId, reference, name, 'isolated')
  const mountOwner = `${session}-${agentId.slice(-12)}`
  const mounted = await mountThread($, { session, thread: created.thread_id, locator: created.reference, owner: mountOwner })
  if (mounted.thread_id !== created.thread_id) throw new Error('Delta mounted a different thread for the subagent')
  const binding: ChildBinding = {
    session, agentId, parent, name, thread: created.thread_id, reference: created.reference, next: 1, pending: [],
    sharesParentCheckout: false, directories: [mounted.directory], mountOwner,
  }
  if (!mounted.worktrees.length) {
    // Nothing to fork: where it works is decided at its first turn, as for any other subagent.
    await unmountThread($, created.reference, mountOwner)
    delete binding.mountOwner
    delete binding.directories
    delete binding.sharesParentCheckout
  }
  const stored = await $.store.get(childKey(session, agentId)) as ChildBinding | undefined
  await saveChild($, stored ? { ...stored, ...binding, next: stored.next, pending: stored.pending } : binding)
  await rememberChild($, session, agentId)
  return binding.mountOwner ? mounted.directory : undefined
}

/** How long an isolated subagent's worktree waits for its session's recording to finish starting. */
const FORK_ACTIVATION_WAIT_MS = 20_000

/** Release the mounts this session made for threads it ran, when it ends. */
async function releaseThreadMounts($: Runtime, session: string, agentIds: readonly string[]) {
  for (const agentId of agentIds) {
    const binding = await loadChild($, { session, agentId }).catch(() => undefined)
    if (binding?.mountOwner && binding.reference) await unmountThread($, binding.reference, binding.mountOwner)
  }
}

/**
 * Load a session's recorded children after a restart: close turns this process never saw run and
 * deliver what they queued.
 */
async function restoreChildren($: Runtime, session: string, binding: Binding) {
  for (const agentId of binding.children ?? []) {
    if (children.has(agentId)) continue
    let stored: ChildBinding
    try { stored = await loadChild($, { session, agentId }) }
    catch (error) { await report($, error); continue }
    const child = newChild(session, agentId, stored.parent, false)
    children.set(agentId, child)
    const execution = stored.execution
    if (execution) void childStep($, child, () => endChildTurn($, child, execution.turnId, 'cancelled'))
    // Delivering also detaches a checkout a run that ended without its hook left attached.
    void deliverChild($, child)
  }
}

/**
 * Record the agents that already ran when this session starts recording. A finished agent's
 * transcript is recorded now; a running one's when its run ends. Teammates and forks stay unrecorded.
 */
async function adoptExistingChildren($: Runtime, session: string) {
  const recorded = new Set<string>()
  // Each agent is adopted after the agent that spawned it, whatever order the list has.
  let waiting = (await existingAgents($)).filter((agent) => agent.teammateId === undefined && agent.type !== 'fork')
  for (let progress = true; progress;) {
    progress = false
    const ready = waiting.filter((agent) => agent.parentId === undefined || recorded.has(agent.parentId))
    waiting = waiting.filter((agent) => !ready.includes(agent))
    for (const agent of ready) {
      progress = true
      await adoptExistingChild($, session, agent)
      recorded.add(agent.id)
    }
  }
  // A run that ended between the list and its adoption heard no `turn.complete` here, so its
  // transcript is read now rather than at an end that already passed.
  const running = new Set((await $.agent.list()).filter((agent) => agent.status === 'running').map((agent) => agent.id))
  for (const agentId of recorded) {
    const child = children.get(agentId)
    if (!child || running.has(agentId)) continue
    await childStep($, child, () => endChildTurn($, child, undefined, undefined))
  }
}

type ExistingAgent = Awaited<ReturnType<Runtime['agent']['list']>>[number]

/**
 * The agents this session ran: those Claude lists, and those its main transcript's Agent calls name.
 * A finished foreground agent is no longer listed, but its call's result still names it.
 */
async function existingAgents($: Runtime): Promise<ExistingAgent[]> {
  const agents = new Map((await $.agent.list()).map((agent) => [agent.id, agent] as const))
  for (const row of await $.session.messages()) {
    for (const use of row.toolUses) {
      if (use.tool !== 'Agent' && use.tool !== 'Task') continue
      const result = use.result as Record<string, unknown> | undefined
      const agentId = typeof result?.agentId === 'string' ? result.agentId : undefined
      if (!agentId || agents.has(agentId) || result?.teammate_id !== undefined) continue
      const input = use.input
      agents.set(agentId, {
        id: agentId, description: typeof input.description === 'string' ? input.description : '',
        name: typeof input.name === 'string' ? input.name : undefined,
        type: typeof input.subagent_type === 'string' ? input.subagent_type : 'general-purpose',
        // An agent Claude no longer lists is no longer running.
        status: 'completed',
      } as ExistingAgent)
    }
  }
  return [...agents.values()]
}

/**
 * Record an agent that ran before this session recorded. One still running gets a running turn now,
 * so Delta shows it working and a takeover there stops it; its transcript is recorded when the run
 * ends. A finished one's transcript is recorded now, with the worktree Claude kept for it attached
 * and detached again, so its files reach Delta and its thread can be continued there.
 */
async function adoptExistingChild($: Runtime, session: string, agent: ExistingAgent) {
  const parent = agent.parentId ?? session
  // The turns that would say where it works already started, so its spawn call tells instead.
  const spawn = await spawnPlacement($, agent)
  const shares = !spawn.apart
  let binding: ChildBinding = {
    session, agentId: agent.id, parent, name: childName({ name: agent.name, description: agent.description }),
    next: 1, pending: [], sharesParentCheckout: shares,
    directories: shares ? await parentDirectories($, { session, parent }) : [],
    ...agent.status === 'running' ? { awaitingSnapshot: true as const } : {},
    ...agent.status !== 'running' && spawn.worktree ? { checkout: spawn.worktree } : {},
  }
  if (binding.awaitingSnapshot) {
    const sequence = binding.next
    binding = await stageChildRecord($, binding, { turnSequence: sequence, update: await runningUpdate($) })
    binding.execution = { sequence }
    binding.lastTurnSequence = sequence
  }
  await saveChild($, binding)
  await rememberChild($, session, agent.id)
  const child = newChild(session, agent.id, parent, false)
  children.set(agent.id, child)
  if (binding.awaitingSnapshot) void deliverChild($, child)
  else {
    await childStep($, child, () => snapshotChild($, child, binding))
    void deliverChild($, child)
  }
}

/**
 * Where the call that spawned an agent ran it: apart from its parent's checkout, in an isolated
 * worktree or a directory of its own, and the worktree Claude kept for it once it finished. An agent
 * whose call is not found shares its parent's.
 */
async function spawnPlacement($: Runtime, agent: ExistingAgent): Promise<{ apart: boolean; worktree?: string }> {
  for (const row of await $.session.messages(agent.parentId ? { agentId: agent.parentId } : {})) {
    for (const use of row.toolUses) {
      const result = use.result as Record<string, unknown> | undefined
      if ((use.tool === 'Agent' || use.tool === 'Task') && result?.agentId === agent.id) {
        const worktree = typeof result.worktreePath === 'string' && result.worktreePath ? result.worktreePath : undefined
        return { apart: use.input.isolation === 'worktree' || typeof use.input.cwd === 'string', ...worktree ? { worktree } : {} }
      }
    }
  }
  return { apart: false }
}

function newChild(session: string, agentId: string, sender: string, foreground: boolean): ChildRuntime {
  return {
    session, agentId, sender, foreground, tools: new ToolRecords(), heldRows: [], queue: Promise.resolve(),
    retryAttempts: 0,
  }
}

/** List a child on its session's binding, which is how a restarted process finds it again. */
async function rememberChild($: Runtime, session: string, agentId: string) {
  await serial(async () => {
    const binding = await load($, session)
    if (!binding.children?.includes(agentId))
      await save($, { ...binding, children: [...binding.children ?? [], agentId] })
  })
}

/**
 * Record the session's title for its thread when it changed since the last one recorded. Only a
 * shared session names its thread; a joined session takes part in someone else's. Nothing here can fail a turn or sharing: a title that cannot be read or staged is skipped, and
 * the next turn's end tries again.
 */
async function recordTitle($: Runtime, session: string, transcript: string) {
  const binding = stateFor(session).binding
  if (!binding?.snapshot || binding.joined || !binding.thread) return
  try {
    const title = await readTitle($, session, transcript)
    if (title === undefined || title === stateFor(session).binding?.title) return
    const staged = await serial(async () => {
      const current = await load($, session)
      if (!current.snapshot || current.joined || current.title === title) return false
      await save($, { ...await stageRecord($, current, { update: { sessionUpdate: 'session_info_update', title } }), title })
      return true
    })
    // Once staged, the title is delivered and reported like every other record.
    if (staged) void drain($, session).catch((error) => report($, error))
  } catch (error) {
    await $.ui.log(`Couldn't record this session's title: ${String(error)}`, { to: 'debug' })
  }
}

/**
 * The session's title, from what its transcript gained since the last read: the first read takes
 * in the file's last {@link TITLE_WINDOW_BYTES}, and each later one only the bytes added since. A
 * transcript that shrank was rewritten, as compaction does, and is read from its end again.
 *
 * Reading from an offset needs `tail`, or PowerShell allowed to call .NET on Windows, and either
 * may be missing or refused, as under Constrained Language Mode. Once it fails, the session reads
 * its transcript whole with `$.fs.read`, which works wherever the plugin does, up to
 * {@link FS_READ_LIMIT}; past that it has no title to offer. A read already running is not
 * doubled; the next turn's end picks up what it left.
 */
async function readTitle($: Runtime, session: string, transcript: string): Promise<string | undefined> {
  const previous = titleReaders.get(session)
  if (previous?.reading) return previous.scanner.title
  const { size } = await $.fs.stat(transcript)
  let reader = previous
  if (!reader || reader.path !== transcript || size < reader.offset) {
    reader = { path: transcript, offset: Math.max(0, size - TITLE_WINDOW_BYTES), scanner: new TitleScanner(), ranged: previous?.ranged ?? true }
    titleReaders.set(session, reader)
  }
  if (size === reader.offset) return reader.scanner.title
  reader.reading = true
  try {
    if (reader.ranged) {
      try {
        await readFrom($, transcript, reader.offset, (text) => reader.scanner.push(text))
        reader.offset = size
        return reader.scanner.title
      } catch (error) {
        reader.ranged = false
        await $.ui.log(`Couldn't read the transcript from an offset (${String(error)}); reading it whole from now on.`, { to: 'debug' })
      }
    }
    if (size > FS_READ_LIMIT) throw new Error(`the transcript is ${size} bytes, more than it can be read whole`)
    const scanner = new TitleScanner()
    scanner.push(await $.fs.read(transcript))
    reader.scanner = scanner
    reader.offset = size
    return scanner.title
  } finally {
    reader.reading = undefined
  }
}

/** Stream a file from a byte offset to its end, without holding it whole. */
async function readFrom($: Runtime, path: string, offset: number, onText: (text: string) => void) {
  const stream = $.process.spawn(transcriptRead(path, offset, await $.env.get('OS') === 'Windows_NT'))
  const deadline = new AbortController()
  let timedOut = false
  void $.clock.sleep(TITLE_TIMEOUT_MS, { signal: deadline.signal }).then(() => {
    timedOut = true
    void stream.return({ code: null, signal: 'SIGTERM' }).catch(() => {})
  }).catch(() => {})
  let stderr = ''
  try {
    while (true) {
      const piece = await stream.next()
      if (timedOut) throw new Error('reading the transcript timed out')
      if (piece.done) {
        if (piece.value.code !== 0) throw new Error(stderr.trim() || `the read exited ${piece.value.code ?? piece.value.signal}`)
        return
      }
      if (piece.value.stream === 'stderr') stderr = (stderr + piece.value.text).slice(-4000)
      else onText(piece.value.text)
    }
  } finally {
    deadline.abort()
    await stream.return({ code: null, signal: 'SIGTERM' })
  }
}

async function report($: Runtime, error: unknown) {
  // A delivery failure was already shown, with its retry or pause, where it was classified.
  if (error instanceof DeltaSendError) return
  const text = `Delta sharing paused: ${String(error)}. ${recoveryAdvice(sessions.get(active)?.binding)}.`
  await $.ui.status(text)
  await $.ui.log(text)
}

async function recordCaptureFailure($: Runtime, session: string, error: unknown) {
  const state = stateFor(session)
  state.captureFailure = String(error)
  try {
    await serial(async () => save($, { ...await load($, session), captureFailure: state.captureFailure }))
  } catch {
    // An unavailable store cannot preserve its own failure across a process restart.
  }
  const execution = state.binding?.execution
  if (execution) {
    try { await loseExecution($, session, execution.sequence, 'Local conversation capture failed') }
    catch (failure) { await report($, failure) }
  }
  await report($, error)
}

async function persistUpdates($: Runtime, session: string, updates: Update[], turnSequence?: number) {
  const unsaved = stateFor(session).unsaved
  try {
    await serial(async () => {
      if (unsaved.length) {
        unsaved.push({ updates, turnSequence })
        return
      }
      let state = await load($, session)
      for (const [index, update] of updates.entries()) {
        try { state = await writeRecord($, state, { update, turnSequence }) }
        catch (error) {
          unsaved.push({ updates: updates.slice(index), turnSequence })
          throw error
        }
      }
    })
  } catch (error) { await recordCaptureFailure($, session, error) }
}

async function flushUnsaved($: Runtime, session: string) {
  const runtime = stateFor(session)
  const unsaved = runtime.unsaved
  while (unsaved.length) {
    const first = unsaved[0]
    if (!first) break
    await serial(async () => {
      let state = await load($, session)
      while (first.updates.length) {
        const update = first.updates[0]
        if (!update) break
        state = await writeRecord($, state, { update, turnSequence: first.turnSequence })
        first.updates.shift()
      }
      unsaved.shift()
    })
  }
  if (runtime.captureFailure) {
    await serial(async () => {
      const state = await load($, session)
      delete state.captureFailure
      await save($, state)
    })
    runtime.captureFailure = undefined
  }
}

async function checkoutRoot($: Runtime): Promise<string> {
  const result = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: await $.session.cwd() })
  if (result.exitCode !== 0 || result.isStdoutTruncated)
    throw new Error('current directory is not inside a Git checkout; open a checkout first')
  return result.stdout.trim()
}

async function assertShareSession($: Runtime, request: ShareRequest) {
  const session = await $.session.id()
  const cwd = await $.session.cwd()
  if (request.cancelled || sharing !== request || session !== request.session || !samePath(cwd, request.cwd))
    throw new Error('The Claude session or folder changed during share; the obsolete share was stopped')
}

/**
 * Whether a session already syncs: it is on the server, or handed to Delta's background uploader. Such
 * a session keeps its audience when it reconnects and cannot become private to its owner again.
 */
function sessionSyncs(binding: Binding | undefined): boolean {
  return !!binding?.url || !!binding?.autoUpload
}

/**
 * What a finished share reports: the thread's link, which a private share may not have until Delta's
 * background upload registers it, and what the band and transcript say. No `band` means nothing was
 * shared, because the person chose not to.
 */
type ShareOutcome = { url?: string; band?: string; notice?: string }

async function share($: Runtime, request: ShareRequest): Promise<ShareOutcome> {
  const { session } = request
  const check = () => assertShareSession($, request)
  await assertShareSession($, request)
  const runtime = stateFor(session)
  if (runtime.currentTurnId) throw new Error('Wait for the current Claude turn to finish before sharing or reattaching')
  let binding = await serial(() => load($, session))
  if (binding.joined || binding.joinTransition)
    throw new Error(`This session joined an already shared thread. Retry ${recoveryCommand(binding)} to reconnect; joining never attaches or republishes a checkout.`)
  if (runtime.unsaved.length) await flushUnsaved($, session)
  binding = await serial(() => load($, session))
  if (runtime.captureFailure || binding.captureFailure)
    throw new Error(`a stored Claude row could not be saved locally (${runtime.captureFailure ?? binding.captureFailure}); sharing is paused to avoid an incomplete transcript`)
  // Refuse a CLI this plugin cannot record against before its snapshot fills the local outbox.
  await resolveCli($, true)
  await assertShareSession($, request)
  await requireContract($, session)
  await assertShareSession($, request)
  // Asked before anything is staged, so declining leaves the session exactly as it was.
  const chosen: ShareAudience | string = request.choose ? await chooseAudience($, session, request.choose.emails) : { kind: 'organization' }
  if (typeof chosen === 'string') return chosen ? { notice: chosen } : {}
  const audience = chosen
  await assertShareSession($, request)
  if (runtime.currentTurnId) throw new Error('Wait for the current Claude turn to finish before sharing or reattaching')
  await requireAuthentication(await authenticationHost($), await resolveCli($), check, async (text) => {
    await check()
    setProgress($, 'Waiting for Delta sign-in…', 'active')
    await $.ui.log(text, { to: 'transcript' })
  })
  await check()
  // Every recorded path is shown relative to the checkout this share attaches.
  const root = await checkoutRoot($)
  await assertShareSession($, request)
  // Refused before the snapshot, so a refusal leaves no thread or staged records behind.
  const joined = await joinedBindingAt($, root)
  if (joined) throw new ShareRefusal(joinedCheckoutRefusal(root, joined))
  await assertShareSession($, request)
  if (!binding.snapshot) {
    let release!: () => void
    gate = new Promise<void>((resolve) => { release = resolve })
    try {
      if (inFlight) await new Promise<void>((resolve) => { quiet = resolve })
      await assertShareSession($, request)
      // Appends begun after the gate cannot reach the transcript until the snapshot is read.
      setProgress($, 'Exporting earlier messages…', 'active', [2, 5])
      const snapshot = snapshotMessages(await $.session.messages({ as: 'api' }))
      await assertShareSession($, request)
      setProgress($, `Exporting ${snapshot.length} earlier messages…`, 'active', [2, 5])
      const summaries = await $.session.messages()
      await assertShareSession($, request)
      const toolResults = new Map(summaries.flatMap((row) =>
        row.toolUses.map((use) => [use.tool_use_id, use] as const)))
      for (const [id, tool] of toolResults) {
        if (tool.result === undefined) continue
        runtime.tools.structuredResults.set(id, resultUpdate(id, tool.tool, tool.result, !!tool.isError, root))
      }
      // Snapshot only the normalized, post-compaction main conversation.
      await serial(async () => {
        let state = await load($, session)
        await assertShareSession($, request)
        for (const [index, message] of snapshot.entries()) {
          rememberToolResults(runtime.tools, message)
          const updates = messageUpdates(message, `snapshot:${index}`, runtime.tools.structuredResults,
            { root, omitted: runtime.tools.omitted })
          for (const update of updates) state = await stageRecord($, state, { update })
        }
        // Commit the complete immutable plan and its pending receipts together. Until
        // this succeeds, neither a retry nor a CLI invocation can see a partial import.
        await save($, { ...state, snapshot: true })
      })
      runtime.binding = await serial(() => load($, session))
      // The agents that already ran become child threads too. A failure leaves them unrecorded
      // and never fails the share.
      if (recordsChildren(session)) {
        try { await adoptExistingChildren($, session) }
        catch (error) { await $.ui.log(`Delta could not record this session's earlier subagents: ${String(error)}`, { to: 'transcript' }) }
      }
    } finally {
      // Nothing is recorded before the snapshot, so these hold only its bulk results.
      runtime.tools.structuredResults.clear()
      runtime.tools.toolResults.clear()
      runtime.tools.omitted.clear()
      release()
      gate = undefined
    }
  }
  // Reattachment is the explicit recovery: it lifts every pause but the watcher's, which going live lifts.
  runtime.pauses.clear()
  runtime.deliveryNotice = undefined
  binding = await serial(() => load($, session))
  await assertShareSession($, request)
  // A private share hands the thread to Delta's background uploader, as Private sync does, so it needs
  // an organization to upload to even in a repository with no saved team.
  const privateUpload = audience.kind === 'private' && !binding.autoUpload
  if (!binding.thread || privateUpload) {
    // The repository's saved team decides where its sessions go, rather than the organization selected
    // in Delta: creating the thread under it makes the later `thread share` or invitation publish there too.
    // Asking who should see the session read the organization list, so the selected one is known.
    const organization = (binding.thread ? threadOrganization(binding) : undefined) ?? await savedOrganization($, root) ??
      (privateUpload ? currentOrganizationId : undefined)
    if (privateUpload && !organization)
      throw new Error('Delta has no organization to sync this session to; check /delta-org list')
    // Creation is idempotent: for a thread that already exists, it only records the private upload.
    const created = await command($, ['thread', 'create', '--source', 'claude-code', '--external-id', session,
      ...organization ? ['--organization', organization, '--visibility', 'private'] : []], 'thread create', check)
    validateCreationReceipt(created)
    if (binding.thread && created.thread_id !== binding.thread)
      throw new Error('Delta returned a different thread for this session; the existing binding was preserved')
    if (!binding.thread && !created.created) {
      const status = await readThreadStatus($, created.thread_id, session)
      validateThreadFrontier(status, { session, thread: created.thread_id, next: binding.next, pending: binding.pending })
      // A durable identity always precedes append. A staged plan alone may have
      // been regenerated after losing the binding, so it cannot prove lineage.
      if (status.producer!.next_sequence !== 1)
        throw new Error('This Delta producer already contains records, but its local thread identity and receipts are missing. Restore the matching producer state or start a new Claude session; do not reset or reuse sequence numbers. The existing Delta conversation was preserved.')
    }
    // Persist identity before further fallible commands; creation is idempotent if this write fails.
    await serial(async () => save($, {
      ...await load($, session), thread: created.thread_id, ...organization ? { organization } : {},
      ...privateUpload ? { autoUpload: { mode: 'private' as const, organization: organization! } } : {},
    }))
    binding = await serial(() => load($, session))
  }
  await assertShareSession($, request)
  await stopConversation()
  await assertShareSession($, request)
  // Only now that the watcher is stopped is its pause true; the restarted watch lifts it once live.
  // A session that records offline does not wait for the watcher and takes no such pause.
  if (!recordsOffline(session, binding)) pauseCheckout(runtime, 'watcher')
  setProgress($, 'Attaching the checkout…', 'active', [3, 5])
  let attached: Awaited<ReturnType<typeof command>>
  try { attached = await command($, ['worktree', 'attach', root, '--thread', binding.thread!], 'worktree attach', check) }
  catch (error) {
    // A checkout Delta manages for another thread, which no session here joined.
    if (error instanceof DeltaCommandError && error.reason === 'worktree_directory_in_use')
      throw new Error(`${root} is a checkout Delta manages for another thread, so it can't be shared as this one. Run /delta-join with that thread's link to work there (${error.message})`)
    throw error
  }
  validateAttachmentReceipt(attached, root)
  await serial(async () => {
    const current = await load($, session)
    if ((current.checkout && !samePath(current.checkout, root)) ||
        (current.checkoutReference !== undefined && current.checkoutReference !== attached.reference))
      throw new Error('Delta returned a different checkout reference or directory; the existing binding was preserved')
    await save($, { ...current, checkout: root, checkoutReference: attached.reference })
  })
  await assertShareSession($, request)
  let outcome: ShareOutcome = { band: audience.kind === 'unchanged' ? 'Reconnected' : 'Synced privately' }
  if (audience.kind === 'unchanged' && !sessionSyncs(binding))
    throw new Error('This session has not been shared yet; run /delta-share and choose who should see it')
  // Keeping a thread Delta last reported as shared with its organization publishes it again, which is
  // idempotent and restores access the server has since lost.
  if (audience.kind === 'organization' || (audience.kind === 'unchanged' && binding.visibility === 'organization')) {
    setProgress($, 'Publishing the thread…', 'active', [4, 5])
    const shared = await command($, ['thread', 'share', binding.thread!, '--visibility', 'organization'], 'thread share', check,
      undefined, commandFormEnv(request.form))
    validatePublicationReceipt(shared, binding.thread)
    await serial(async () => save($, { ...await load($, session), url: shared.url }))
    outcome = { url: shared.url, band: 'Shared' }
  } else if (audience.kind === 'invite') {
    // Inviting uploads a thread that is not on the server yet privately, so only the people invited see it.
    setProgress($, 'Sending invitations…', 'active', [4, 5])
    const { url, results } = threadInvitationsFrom(await command($, ['thread', 'invite', binding.thread!, '--', ...audience.emails],
      'thread invite', check, undefined, commandFormEnv(request.form)), binding.thread!)
    await serial(async () => save($, { ...await load($, session), url }))
    const invited = results.filter((result) => result.invited).length
    outcome = {
      url, notice: `${invitationSummary(results, 'this session')} Link: ${url}`,
      band: invited ? `Invited ${invited === 1 ? '1 person' : `${invited} people`}` : 'Synced privately; nobody was invited',
    }
  }
  await assertShareSession($, request)
  await startConversation($, session)
  await assertShareSession($, request)
  setProgress($, 'Syncing files…', 'active', [5, 5])
  await drain($, session)
  for (const child of children.values()) if (child.session === session) void deliverChild($, child)
  if (isPaused(runtime))
    throw new Error('checkout sharing is paused; saved messages remain queued until reattachment succeeds')
  if (runtime.captureFailure || runtime.unsaved.length)
    throw new Error('a live row could not be saved locally; fix the outbox error and retry /delta-share')
  await verifyCheckout($, await load($, session))
  await assertShareSession($, request)
  return { ...outcome, url: outcome.url ?? (await serial(() => load($, session))).url }
}

/**
 * The joined session whose mounts include `directory`. A mount's path is unique to its thread and
 * owner, so a match means the directory is that thread's checkout, not one this session can share.
 */
async function joinedBindingAt($: Runtime, directory: string): Promise<Binding | undefined> {
  // A Claude build without `$.store.keys` cannot enumerate the store; Delta still refuses the attach.
  let keys: string[]
  try { keys = await $.store.keys() } catch { return }
  for (const storeKey of keys) {
    if (!storeKey.startsWith('session:')) continue
    const binding = await $.store.get(storeKey) as Binding | undefined
    if (!binding?.joined || !binding.thread) continue
    if (binding.mounts?.some((mount) => samePath(mount.directory, directory))) return binding
  }
}

/**
 * A share this session must not make, refused before anything was staged. Its message names the
 * step to take instead, so it is shown without the advice to retry the share.
 */
class ShareRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ShareRefusal'
  }
}

/** What a failed share tells the person: why, and what to retry. */
function shareFailureText(error: unknown, retry: string): string {
  if (error instanceof ShareRefusal) return `Delta didn't share this session: ${error.message}.`
  return `Delta sharing failed: ${String(error)}. Fix the issue and retry ${retry}; saved records retain their sequence.`
}

function joinedCheckoutRefusal(root: string, joined: Binding): string {
  return `${root} is a worktree of the Delta thread ${joined.url ?? joined.thread}, mounted when a Claude session joined it. Sharing it would publish the same files as a separate thread; run /delta-join ${joined.locator ?? joined.thread} to record this conversation in that thread instead`
}

/**
 * Run a share on the clock so `/delta share` returns at once: the band reports progress, and once
 * the share succeeds it keeps the link on hand, so nothing is added to the transcript.
 */
async function runShare($: Runtime, request: ShareRequest) {
  const { session } = request
  try {
    const outcome = await share($, request)
    if (outcome.band) finishProgress($, outcome.band, 'done')
    else clearProgress($)
    if (outcome.notice) await $.ui.log(outcome.notice, { to: 'transcript' })
    if (outcome.url) await $.ui.log(`Delta share link: ${outcome.url}`, { to: 'debug' })
  } catch (error) {
    if (request.cancelled || sharing !== request) return
    const text = error instanceof AccessRequiredError ? error.message
      : shareFailureText(error, recoveryCommand(stateFor(session).binding))
    setProgress($, text, 'error')
    await $.ui.log(text, { to: 'transcript' })
  } finally {
    if (sharing === request) sharing = undefined
  }
}

/** A timer leaves the active command before invoking commands that wait for idle. */
async function join($: Runtime, request: JoinRequest) {
  let plan: JoinPlan | undefined
  let fresh: string | undefined
  try {
    await assertJoinSession($, request.session, request)
    if (!samePath(await $.session.cwd(), request.cwd))
      throw new Error('The session or folder changed while join was queued; retry from the intended session')
    const pending = await load($, request.session)
    const runtime = stateFor(request.session)
    if (runtime.currentTurnId || runtime.promptEntering)
      throw new Error('Wait for Claude to become idle before joining')
    if (runtime.restoring) throw new Error("Wait for Delta to finish restoring this session's worktrees before joining")
    if (activeBackgroundAgents(await $.agent.list()))
      throw new Error('Stop background agents and teammates before joining; an idle main turn is not sufficient')
    // Refuse a CLI this plugin cannot record against before any transition, mount, or clear.
    await resolveCli($, true)
    // `/clear` ends the old session and removes its cached contract before the fresh session mounts.
    request.contractVersion = await requireContract($, request.session)
    const check = async () => {
      await assertJoinSession($, request.session, request)
      if (await $.session.cwd() !== request.cwd)
        throw new Error('The folder changed during sign-in; retry join from the intended folder')
    }
    await requireAuthentication(await authenticationHost($), await resolveCli($), check, async (text) => {
      await check()
      setProgress($, 'Waiting for Delta sign-in…', 'active')
      await $.ui.log(text, { to: 'transcript' })
    })
    await check()
    if (pending.joinTransition) {
      plan = pending.joinTransition
      fresh = request.session
      request.fresh = fresh
      if (plan.locator !== request.locator) throw new Error('Retry the pending join with its original locator')
      await completeJoin($, fresh, plan, request)
      return
    }
    let status = pending.joined ? await readJoinStatus($, request) : undefined
    await assertJoinSession($, request.session, request)
    if (pending.joined && status?.thread_id === pending.thread) {
      // Resolve aliases by canonical identity; never replace this producer with an empty frontier.
      setProgress($, 'Reconnecting to the shared thread…', 'active')
      await restoreMounts($, request.session, () => assertJoinSession($, request.session, request))
      await verifyCheckout($, await load($, request.session))
      await assertJoinSession($, request.session, request)
      if (runtime.unsaved.length) await flushUnsaved($, request.session)
      const binding = await load($, request.session)
      await assertJoinSession($, request.session, request)
      if (runtime.captureFailure || binding.captureFailure)
        throw new Error(`a stored Claude row could not be saved locally (${runtime.captureFailure ?? binding.captureFailure}); restore the outbox before retrying`)
      resumeCheckout(runtime, 'delivery')
      endDeliveryFailures(runtime)
      if (feed.connection === 'retrying') await stopConversation()
      await assertJoinSession($, request.session, request)
      await startConversation($, request.session)
      await recoverExecution($, request.session)
      await drain($, request.session)
      await assertJoinSession($, request.session, request)
      await verifyCheckout($, await load($, request.session))
      if (isPaused(runtime) || runtime.unsaved.length)
        throw new Error('Joined participation remains paused; saved records remain queued')
      // The band reports the rejoin through the finished notice; the transcript keeps only conversation.
      $.ui.log(`Reconnected to the joined Delta thread in Claude session ${request.session}; the checkout and producer state were preserved.`, { to: 'debug' })
      finishProgress($, 'Joined the shared thread', 'done')
      return
    }
    // Claude Code Desktop has no `/cd`, applies its own folder tool's move only when a model turn
    // ends, which a join run from a command never has, and never moves a worktree session at all.
    // So a Desktop join starts a new session in the thread's folder instead.
    const handsOff = (await $.session.surfaces()).includes('desktop')
    // `/delta join` is the request, and the fresh session leaves this one resumable, so the only
    // question is Claude's own folder trust prompt.
    if (!handsOff) await requireJoinCommands($, ['clear', 'cd'])
    await assertJoinSession($, request.session, request)
    status ??= await readJoinStatus($, request)
    await assertJoinSession($, request.session, request)
    if (joinPreflight(status) === 'access')
      throw new Error('Joining requires authenticated access to an already shared thread; check your Delta sign-in and link')
    // Only the fresh session can own the mount, so mounting waits for it. Refuse here what a mount
    // could never satisfy, while the old session is still untouched.
    if (joinPreflight(status) === 'empty')
      throw new Error('This thread has no worktree to join')
    if (handsOff) {
      const handoff = await pendingHandoff($, request.cwd)
      if (handoff?.thread === status.thread_id) await takeOverHandoff($, request, handoff)
      else await offerHandoff($, request, status)
      return
    }
    plan = { session: request.session, cwd: request.cwd, locator: request.locator, thread: status.thread_id }
    if (await $.session.id() !== request.session || !samePath(await $.session.cwd(), request.cwd))
      throw new Error('The session or folder changed during the access check; nothing was changed')
    if (activeBackgroundAgents(await $.agent.list()))
      throw new Error('A background agent started during the access check; stop it before retrying')
    await assertJoinSession($, request.session, request)
    setProgress($, 'Starting a fresh Claude session…', 'active')
    request.clearing = true
    try { await $.command.run({ command: 'clear' }) }
    finally { request.clearing = false }
    fresh = await $.session.id()
    if (fresh === request.session) {
      fresh = undefined
      throw new Error('Claude did not create a fresh session after /clear; the old binding was not replaced')
    }
    request.fresh = fresh
    await assertJoinSession($, fresh, request)
    if ((await load($, fresh)).snapshot)
      throw new Error('The new Claude session already has a binding; it was not replaced')
    // Persist a blocking retry state, not a completed binding in the wrong directory.
    await serial(async () => {
      await assertJoinSession($, fresh!, request)
      await save($, { session: fresh!, snapshot: false, next: 1, pending: [], joinTransition: plan! }, () => !request.cancelled)
    })
    await completeJoin($, fresh, plan, request)
  } catch (error) {
    if (request.cancelled) return
    const invalidLocator = error instanceof DeltaCommandError && error.code === 'invalid_reference'
    // Sign-in runs before the session changes, so an access requirement leaves nothing to preserve.
    const text = error instanceof AccessRequiredError && !fresh ? error.message : `Delta join failed: ${String(error)}. ${invalidLocator
      ? `The ${fresh ? 'fresh session' : 'previous session and folder'} was preserved. Use the thread's share link with /delta-join instead of retrying this locator.`
      : fresh
      ? `Fresh session ${fresh} was preserved. Retry /delta-join ${plan?.locator ?? request.locator} to finish the saved transition; the previous session is ${plan?.session ?? request.session} at ${plan?.cwd ?? request.cwd}.`
      : `The previous session and folder were preserved. Retry /delta-join ${request.locator}.`}`
    if (fresh) stateFor(fresh).joinFailure = text
    setProgress($, text, 'error')
    await $.ui.log(text, { to: 'transcript' })
  } finally {
    if (joining === request) joining = undefined
  }
}

/** How long a join waits out failures Delta marks retryable, such as a daemon still connecting. */
const JOIN_RETRY_BUDGET_MS = 30_000

/**
 * Reads the thread's status for a join, retrying failures Delta marks retryable.
 *
 * A join often runs right after the session starts, when Delta's daemon may still be connecting
 * and answers `disconnected`; a person waiting on the join should not have to retry that.
 */
async function readJoinStatus($: Runtime, request: JoinRequest) {
  const deadline = await $.clock.now() + JOIN_RETRY_BUDGET_MS
  for (let attempt = 0; ; attempt++) {
    try { return await readThreadStatus($, request.locator, request.session) }
    catch (error) {
      const delay = deliveryRetryDelay(attempt, error instanceof DeltaCommandError ? error.hints.retryAfterMs : undefined)
      if (classifyCommandFailure(error) !== 'transient' || await $.clock.now() + delay > deadline) throw error
      setProgress($, 'Waiting for Delta to connect…', 'active')
      await $.clock.sleep(delay)
      await assertJoinSession($, request.session, request)
    }
  }
}

async function assertJoinSession($: Runtime, session: string, request: JoinRequest) {
  if (request.cancelled || await $.session.id() !== session)
    throw new Error('The Claude session changed during join; the obsolete transition was stopped')
}

/** Check actual host capabilities before any destructive session transition. */
async function requireJoinCommands($: Runtime, names: string[]) {
  const commands = await $.command.list()
  const missing = missingJoinCommands(names, commands)
  if (missing.length)
    throw new Error(`This Claude host does not expose the built-in ${missing.map((name) => `/${name}`).join(' and ')} command required to join; the saved session and mount plan were preserved`)
}

/** Complete only the saved fresh session's transition, never clear again on retry. */
async function completeJoin($: Runtime, session: string, plan: JoinPlan, request: JoinRequest) {
  // This session runs against the same CLI build `join` already verified for this process; `/clear`
  // removed the old session's verification before this fresh one started.
  contractVerified.set(session, request.contractVersion!)
  const check = () => assertJoinSession($, session, request)
  await check()
  setProgress($, "Mounting the thread's worktrees…", 'active')
  const mounted = await mountThread(
    $, { session, thread: plan.thread, locator: plan.locator, owner: plan.owner },
    { reportJoin: !plan.owner, form: request.form },
  )
  await check()
  requireMounted(mounted, plan.thread)
  // Remember the verified destination even if Claude refuses /cd; the retry notice must name it.
  await serial(async () => {
    await check()
    await save($, { ...await load($, session), directory: mounted.directory }, () => !request.cancelled)
  })
  await enterDirectory($, session, mounted.directory, check)
  const binding: Binding = {
    session, thread: plan.thread, locator: plan.locator, joined: true,
    owner: plan.owner ?? session, directory: mounted.directory, mounts: mounted.worktrees,
    // snapshot means live recording is enabled, not that old history must be exported.
    snapshot: true, next: 1, pending: [],
  }
  const status = await verifyCheckout($, binding)
  await check()
  Object.assign(binding, statusFields(status))
  await serial(async () => {
    await check()
    await save($, binding, () => !request.cancelled)
  })
  stateFor(session).mounted = true
  await check()
  // Neither session.start nor classic.SessionStart is relied upon after clear/cd.
  setProgress($, 'Connecting to the shared thread…', 'active')
  await activate($, session, () => !request.cancelled)
  await check()
  await startConversation($, session)
  // The band reports the join through the finished notice; the way back to the previous session stays in the debug log.
  $.ui.log(plan.owner
    ? `Joined Delta in Claude session ${session} at ${mounted.directory}, taking over mount owner ${plan.owner}.`
    : `Joined Delta in fresh Claude session ${session} at ${mounted.directory}. Resume the previous session with claude --resume ${plan.session} from ${plan.cwd}.`,
    { to: 'debug' })
  finishProgress($, 'Joined the shared thread', 'done')
}

/**
 * Ask Delta to keep the checkout of every worktree of a joined thread mounted for this session.
 * `folder` makes even a one-worktree thread's directory its thread folder, which Desktop opens as
 * a plain folder rather than a repository it would make yet another worktree of.
 */
async function mountThread(
  $: Runtime,
  binding: { session: string; thread?: string; locator?: string; owner?: string },
  options: { folder?: boolean; reportJoin?: boolean; form?: CommandForm } = {},
): Promise<MountedThread> {
  const owner = binding.owner ?? binding.session
  const args = [
    'thread', 'mount', binding.locator ?? binding.thread!, '--owner', owner,
    ...options.folder ? ['--folder'] : [],
  ]
  const join = !!options.reportJoin
  if (join) args.push('--join')
  // A first mount can materialize large checkouts, which the CLI waits for.
  return parseThreadMount(await readCommand($, args, 'thread mount', new AbortController().signal, MOUNT_TIMEOUT_MS,
    join ? commandFormEnv(options.form) : {}), owner)
}

function handoffPath(owner: string) { return `${pluginData}/handoffs/${owner}.json` }

/**
 * Hand a Desktop tab's join to a new Desktop session: mount the thread under an owner of its own,
 * record the hand-off, and open Desktop's new-session screen on the thread folder. Nothing in this
 * tab changes.
 */
async function offerHandoff($: Runtime, request: JoinRequest, status: ThreadState) {
  const owner = `desktop-${crypto.randomUUID()}`
  const check = () => assertJoinSession($, request.session, request)
  setProgress($, "Mounting the thread's worktrees…", 'active')
  const single = status.worktrees.status === 'available' && status.worktrees.items.length === 1
  const mounted = await mountThread(
    $, { session: request.session, thread: status.thread_id, locator: request.locator, owner },
    { folder: single, reportJoin: true, form: request.form },
  )
  const handoff: Handoff = {
    owner, thread: status.thread_id, locator: request.locator, directory: mounted.directory,
    created: await $.clock.now(),
  }
  try {
    await check()
    requireMounted(mounted, status.thread_id)
    await $.fs.write(handoffPath(owner), JSON.stringify(handoff))
    const link = newSessionLink(mounted.directory, HANDOFF_PROMPT)
    const opened = await $.process.run(['open', link], { timeoutMs: RELEASE_TIMEOUT_MS }).catch((error) => ({ exitCode: 1, stderr: String(error) }))
    stateFor(request.session).offered = handoff
    const thread = status.title?.trim() ? `“${status.title.trim()}”` : 'the thread'
    if (opened.exitCode === 0)
      setProgress($, `Press Enter in the new Claude Code Desktop session to join ${thread} there; this tab stays as it is. Desktop may ask you to trust the thread's folder. It waits 5 minutes.`, 'active')
    else {
      // Opening links from a plugin needs macOS's `open`; anywhere else the person opens it.
      setProgress($, `Open the link in this transcript, then press Enter in the new session to join ${thread} there. It waits 5 minutes.`, 'active')
      await $.ui.log(`Open this link to start a Claude Code session in the Delta thread's folder: ${link}`, { to: 'transcript' })
    }
    $.clock.after(HANDOFF_POLL_MS, () => watchHandoff($, request.session, handoff))
  } catch (error) {
    await releaseHandoff($, handoff)
    throw error
  }
}

/** Follow an offered hand-off until a new session claims it, or release it once it expires. */
async function watchHandoff($: Runtime, session: string, handoff: Handoff) {
  const runtime = stateFor(session)
  if (runtime.offered !== handoff) return
  if (!await $.fs.exists(handoffPath(handoff.owner))) {
    runtime.offered = undefined
    finishProgress($, 'Opened the thread in a new session', 'done')
    return
  }
  if (await $.clock.now() - handoff.created < HANDOFF_EXPIRY_MS) {
    $.clock.after(HANDOFF_POLL_MS, () => watchHandoff($, session, handoff))
    return
  }
  runtime.offered = undefined
  await releaseHandoff($, handoff)
  const text = `No session joined the Delta thread within 5 minutes, so Delta released its checkouts. Run /delta-join ${handoff.locator} to bring it back.`
  finishProgress($, text, 'done')
  await $.ui.log(text, { to: 'transcript' })
}

/**
 * Release a hand-off's mount and record. With `onlyUnclaimed`, a record a new session already
 * removed means that session owns the mount now, and nothing is released.
 */
async function releaseHandoff($: Runtime, handoff: Handoff, onlyUnclaimed = false) {
  if (onlyUnclaimed && !await $.fs.exists(handoffPath(handoff.owner)).catch(() => true)) return
  await $.process.run(['rm', '-f', '--', handoffPath(handoff.owner)]).catch(() => undefined)
  await unmountThread($, handoff.locator, handoff.owner)
}

/** The hand-off offered for a session starting in `directory`, if any. */
async function pendingHandoff($: Runtime, directory: string): Promise<Handoff | undefined> {
  const folder = `${pluginData}/handoffs`
  if (!await $.fs.exists(folder)) return
  for (const entry of await $.fs.list(folder)) {
    if (!entry.name.endsWith('.json')) continue
    let text: string
    try { text = await $.fs.read(`${folder}/${entry.name}`) as string } catch { continue }
    const handoff = parseHandoff(text)
    if (handoff && samePath(handoff.directory, directory)) return handoff
  }
}

/**
 * Join a hand-off in the session that started in its folder, before the first prompt arrives.
 * Failure is reported in the band and transcript, and holds prompts until /delta join is retried.
 */
async function claimHandoff($: Runtime, session: string, handoff: Handoff) {
  const request: JoinRequest = { session, cwd: handoff.directory, locator: handoff.locator }
  try {
    setProgress($, 'Joining the shared thread…', 'active')
    request.contractVersion = await requireContract($, session)
    await takeOverHandoff($, request, handoff)
  } catch (error) {
    if (request.cancelled) return
    const text = `Delta couldn't join the thread in this session: ${String(error)}. Run /delta-join ${handoff.locator} to retry.`
    stateFor(session).joinFailure = text
    setProgress($, text, 'error')
    await $.ui.log(text, { to: 'transcript' })
  }
}

/**
 * Join in the session a hand-off started in the thread's folder: claim the record first, so the
 * offering tab's expiry cannot release the mount, then take the mount over under the same owner
 * and join without clearing or moving.
 */
async function takeOverHandoff($: Runtime, request: JoinRequest, handoff: Handoff) {
  await $.process.run(['rm', '-f', '--', handoffPath(handoff.owner)])
  await completeJoin($, request.session, {
    session: request.session, cwd: request.cwd, locator: handoff.locator, thread: handoff.thread, owner: handoff.owner,
  }, request)
}

/** What a mount that joining or restoring can use: the right thread, and something to work in. */
function requireMounted(mounted: MountedThread, thread: string | undefined) {
  if (mounted.thread_id !== thread) throw new Error('Delta mounted a different thread; no session transition was attempted')
  if (!mounted.worktrees.length) throw new Error('This thread has no worktree to join')
}

/**
 * Move Claude into a mount's directory unless it is already there. Claude resumes in the directory
 * it was launched from, and `/cd` is the only way a plugin changes the session's directory.
 */
async function enterDirectory($: Runtime, session: string, directory: string, check: () => Promise<void>) {
  if (await isInDirectory($, directory)) return
  await requireJoinCommands($, ['cd'])
  await check()
  setProgress($, "Waiting for you to trust the thread's folder…", 'active')
  // Claude's trust prompt names only a path, so say what the folder is and which answer joins.
  await $.ui.log(
    `Delta put this thread's code in its own folder for this session. Claude Code asks before working in a new folder: choose "Yes, move here" to continue. "No, stay put" pauses Delta in this session until you run /delta-join again.`,
    { to: 'transcript' })
  await $.command.run({ command: 'cd', args: directory })
  await check()
  if (await $.session.id() !== session || !samePath(await $.session.cwd(), directory) ||
      !samePath(await $.session.root(), directory))
    throw new Error('Claude did not keep the session in the exact mounted directory; participation remains paused')
}

/**
 * Mount a joined session's worktrees again and put Claude in their directory. Mounting is
 * idempotent: it restores what was removed after the session's owner process last ran, and it
 * returns the directory Claude should work in now.
 */
async function restoreMounts($: Runtime, session: string, check: () => Promise<void>) {
  const binding = await serial(() => load($, session))
  await check()
  const mounted = await mountThread($, binding)
  await check()
  requireMounted(mounted, binding.thread)
  await enterDirectory($, session, mounted.directory, check)
  await serial(async () => {
    await check()
    await save($, { ...await load($, session), owner: binding.owner ?? session, directory: mounted.directory, mounts: mounted.worktrees })
  })
  stateFor(session).mounted = true
}

/**
 * Restore a resumed joined session in the background: prompts wait, and the band shows progress.
 * Mounting and `/cd` leave the session hook first, as join's do, since `/cd` waits for the idle prompt.
 */
function beginRestore($: Runtime, session: string) {
  const runtime = stateFor(session)
  if (runtime.restoring) return
  runtime.restoring = true
  setProgress($, "Restoring the thread's worktrees…", 'active')
  const owns = () => active === session && sessions.get(session) === runtime
  $.clock.after(0, async () => {
    try {
      await restoreMounts($, session, async () => {
        if (!owns()) throw new Error('The session ended while its worktrees were being restored')
      })
      const binding = await serial(() => load($, session))
      await startParticipation($, session, binding, owns)
      if (!owns()) return
      finishProgress($, `Restored ${binding.mounts?.length ?? 0} worktree${binding.mounts?.length === 1 ? '' : 's'}`, 'done')
      if (!runtime.captureFailure && binding.pending.length) void drain($, session).catch((error) => report($, error))
    } catch (error) {
      if (!owns()) return
      const text = `Delta couldn't restore this session's worktrees: ${String(error)}. Retry ${recoveryCommand(runtime.binding)}; the prompt was not submitted.`
      runtime.joinFailure = text
      setProgress($, text, 'error')
      await $.ui.log(text, { to: 'transcript' })
    } finally {
      runtime.restoring = undefined
    }
  })
}

/**
 * Ask Delta to release a joined session's checkouts, waiting only until the release is recorded.
 * Delta then uploads and deletes them in its own time, so nothing here waits for synchronization.
 * The request is awaited because Claude kills a request still running when it exits (a probe's
 * 0.3 s command was lost); if it is lost anyway, Delta releases a group whose owner process is gone.
 */
async function releaseMounts($: Runtime, session: string) {
  let binding: Binding | undefined
  try { binding = await $.store.get(key(session)) as Binding | undefined }
  catch { return }
  if (!binding?.joined || binding.session !== session || !binding.thread) return
  await unmountThread($, binding.locator ?? binding.thread, binding.owner ?? session)
}

/** Ask Delta to release `owner`'s mounts of `thread`; a failure is only logged, since exiting cannot wait on it. */
async function unmountThread($: Runtime, thread: string, owner: string) {
  try {
    const argv = [await resolveCli($), '--json', 'thread', 'unmount', thread, '--owner', owner]
    const result = await $.process.run(argv, {
      timeoutMs: RELEASE_TIMEOUT_MS, env: { DELTA_CLI_INTEGRATION: 'claude_code' },
    })
    if (result.exitCode !== 0) await $.ui.log(`Delta thread unmount failed: ${result.stderr.trim() || result.stdout.trim()}`, { to: 'debug' })
  } catch (error) { await $.ui.log(`Delta thread unmount did not run: ${String(error)}`, { to: 'debug' }) }
}

/** The worktrees of a joined thread changed: re-mount, then tell Claude and the person. */
function refreshMounts($: Runtime, session: string, listed: { reference: string }[]) {
  const runtime = stateFor(session)
  runtime.mountRefresh = (runtime.mountRefresh ?? Promise.resolve())
    .then(() => applyWorktrees($, session, listed))
    .catch((error) => {
      if (active !== session) return
      const text = `Delta couldn't update this session's worktrees: ${String(error)}`
      setProgress($, text, 'error')
      return $.ui.log(text, { to: 'transcript' })
    })
}

async function applyWorktrees($: Runtime, session: string, listed: { reference: string }[]) {
  const runtime = stateFor(session)
  if (active !== session || !runtime.mounted) return
  const binding = await serial(() => load($, session))
  const previous = binding.mounts
  if (!binding.joined || !previous) return
  // Every reconnect reports the current list; most of those change nothing.
  if (listed.length === previous.length && listed.every((tree) => previous.some((mount) => mount.reference === tree.reference))) return
  const mounted = await mountThread($, binding)
  if (active !== session || mounted.thread_id !== binding.thread) return
  await serial(async () => save($, { ...await load($, session), mounts: mounted.worktrees }))
  const { added, removed, moves } = worktreeChanges(previous, binding.directory, mounted)
  if (!added.length && !removed.length) return
  const names = (trees: { name: string }[]) => trees.map((tree) => tree.name).join(', ')
  const changes = [added.length ? `added ${names(added)}` : '', removed.length ? `removed ${names(removed)}` : ''].filter(Boolean).join('; ')
  finishProgress($, `Thread worktrees changed: ${changes}${moves ? ' · moving to the thread folder' : ''}`, 'done')
  await deliverNote($, session, [
    `[Delta] This thread's worktrees changed (${changes}). They are now:`,
    ...mounted.worktrees.map((tree) => `- ${tree.name}: ${tree.directory}`),
    moves ? `Delta will move this session to ${mounted.directory}, which links to each of them, once the current turn ends.`
      : `This session's directory is ${binding.directory}.`,
  ].join('\n'))
  if (moves) {
    runtime.moveTo = mounted.directory
    scheduleMove($, session)
  }
}

/** A hidden row for Claude's context, held back while a turn runs so it never lands inside one. */
async function deliverNote($: Runtime, session: string, text: string) {
  const runtime = stateFor(session)
  runtime.notes.push(text)
  if (!rowsHeld(session)) await flushNotes($, session)
}

async function flushNotes($: Runtime, session: string) {
  const runtime = stateFor(session)
  for (const text of runtime.notes.splice(0)) {
    $.ui.log(`Adding a row to Claude's context: ${text.split('\n', 1)[0]}`, { to: 'debug' })
    try { await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }) }
    catch (error) { $.ui.log(`Couldn't add a Delta worktree update to Claude's context: ${String(error)}`, { to: 'debug' }) }
  }
}

function scheduleMove($: Runtime, session: string) {
  const runtime = stateFor(session)
  if (!runtime.moveTo || runtime.moving || rowsHeld(session)) return
  runtime.moving = true
  $.clock.after(0, () => moveSession($, session))
}

/** Move Claude from a worktree's checkout to the thread folder, between turns. */
async function moveSession($: Runtime, session: string) {
  const runtime = stateFor(session)
  const directory = runtime.moveTo
  try {
    // A turn that began since is the one whose end moves the session.
    if (!directory || active !== session || rowsHeld(session)) return
    const binding = await serial(() => load($, session))
    if (!binding.directory || !await isInDirectory($, binding.directory)) { runtime.moveTo = undefined; return }
    const check = async () => { if (active !== session) throw new Error('The session ended during the move') }
    await enterDirectory($, session, directory, check)
    await serial(async () => save($, { ...await load($, session), directory }))
    runtime.moveTo = undefined
    resumeCheckout(runtime, 'verification')
    finishProgress($, 'Moved to the thread folder', 'done')
    await deliverNote($, session, `[Delta] This session's directory is now ${directory}. It links to each worktree of the thread.`)
    void drain($, session).catch((error) => report($, error))
  } catch (error) {
    runtime.moveTo = undefined
    if (active !== session) return
    const text = `Delta couldn't move Claude to the thread folder ${directory}: ${String(error)}. The session stays where it is; /cd there to work across every worktree.`
    setProgress($, text, 'error')
    await $.ui.log(text, { to: 'transcript' })
  } finally {
    runtime.moving = undefined
  }
}

/** Check a joined session's mounts, then watch the thread; the watch lifts the watcher pause once live. */
async function startParticipation($: Runtime, session: string, binding: Binding, owns: () => boolean) {
  if (binding.joined) await verifyCheckout($, binding)
  if (!owns()) return
  const ready = await startConversation($, session)
  if (owns() && feed.ready === ready) resumeCheckout(stateFor(session), 'watcher')
}

async function activate($: Runtime, session: string, isCurrent = () => true) {
  const epoch = ++sessionEpoch
  const ownsActivation = () => epoch === sessionEpoch && isCurrent()
  activatingSession = session
  try {
    const home = await $.env.get('HOME') ?? await $.env.get('USERPROFILE')
    const config = await $.env.get('CLAUDE_CONFIG_DIR') ?? (home ? `${home}/.claude` : undefined)
    if (!ownsActivation()) return
    if (!config) throw new Error('Cannot locate Claude configuration; set CLAUDE_CONFIG_DIR.')
    pluginData = `${config}/delta-plugin`
    outbox = `${pluginData}/outbox`
    if (active !== session) await stopConversation()
    if (!ownsActivation()) return
    active = session
    let binding = await serial(() => load($, session))
    if (!ownsActivation()) return
    // A session that resumes is live again: drop the end marker so bounded cleanup never removes it.
    if (binding.endedAt !== undefined) {
      const live = { ...binding }
      delete live.endedAt
      await serial(() => save($, live))
      binding = live
    }
    // A conversation Claude Code moved here from a recording session keeps recording, here.
    if (continuationCandidate(session, binding)) {
      const parent = await continuedFrom($, session)
      if (!ownsActivation()) return
      if (parent) binding = await adoptContinuation($, session, parent.session) ?? binding
      if (!ownsActivation()) return
    }
    const runtime = stateFor(session)
    runtime.binding = binding
    runtime.captureFailure ??= binding.captureFailure
    if (binding.joinTransition) {
      await report($, new Error(`The join directory transition is incomplete. Run /delta-join ${binding.joinTransition.locator} to retry the saved mount${binding.directory ? ` at ${binding.directory}` : ''}; prompts remain blocked.`))
      return
    }
    // A session Desktop started in a hand-off's folder joins it before its first prompt.
    if (!binding.snapshot && !binding.joined && !runtime.handoffClaim) {
      const handoff = await pendingHandoff($, await $.session.cwd())
      if (!ownsActivation()) return
      if (handoff) {
        runtime.handoffClaim = claimHandoff($, session, handoff)
        return
      }
    }
    endDeliveryFailures(runtime)
    scheduleOutboxCleanup($, binding)
    // Bounded store retention: entries for sessions that ended long ago are pruned only when they
    // hold nothing a later session would need. It never blocks activation.
    void pruneStore($).catch(() => {})
    // An automatic session whose activation never finished, for example because Delta was unreachable
    // when it started, resumes that activation rather than waiting for a thread it does not have yet.
    if (activationIncomplete(runtime)) {
      retryAutomaticActivation($, session, runtime)
      return
    }
    if (binding.snapshot && boundDirectory(binding)) {
      pauseCheckout(runtime, 'watcher')
      try { await requireContract($, session) }
      catch (error) {
        if (!ownsActivation()) return
        const text = `Delta participation is blocked: ${String(error)}`
        // Only an explicit /delta share or /delta join after updating Delta lifts this pause.
        pauseCheckout(runtime, 'delivery', text)
        runtime.joinFailure = text
        setProgress($, text, 'error')
        await $.ui.log(text, { to: 'transcript' })
        return
      }
      // A session whose mounts this process has not confirmed is resuming: Claude may be anywhere.
      if (binding.joined && !runtime.mounted) {
        beginRestore($, session)
        return
      }
      if (recordsOffline(session, binding)) {
        // Offline recording does not wait for the watcher: start it in the background and let a
        // prompt or the outbox proceed meanwhile.
        resumeCheckout(runtime, 'watcher')
        void startConversation($, session).catch((error) => { if (ownsActivation()) void report($, error) })
      } else {
        try { await startParticipation($, session, binding, ownsActivation) }
        catch (error) { if (ownsActivation()) await report($, error) }
      }
      // An automatic session follows Delta's background upload on its own timer, so the link appears
      // even when the watcher never becomes ready.
      if (ownsActivation() && binding.autoUpload) followUpload($, session)
      if (ownsActivation() && !isPaused(runtime)) await recoverExecution($, session)
    }
    if (ownsActivation() && !runtime.captureFailure && binding.thread && binding.pending.length)
      void drain($, session).catch((error) => report($, error))
    if (ownsActivation() && binding.children?.length)
      void restoreChildren($, session, binding).catch((error) => report($, error))
  } finally {
    if (epoch === sessionEpoch) activatingSession = ''
  }
}

/**
 * Organization id → name, filled by every organization list read, so the band can name the
 * organization a thread is shared with. The band itself reads the list at most once per process.
 */
const organizationNames = new Map<string, string>()
let currentOrganizationId: string | undefined
/** The account's personal organization, from the band's directory read, which also reads the login. */
let personalOrganizationIds = new Set<string>()
let organizationDirectory: Promise<void> | undefined

/** The account's organizations from `delta --json org list`, remembering their names for the band. */
/** Create a team organization through the CLI and remember its name for the band. */
async function createOrganization($: Runtime, name: string): Promise<Organization> {
  const created = createdOrganizationFrom(await command($, ['org', 'create', '--', name], 'org create'))
  organizationNames.set(created.id, created.name)
  return created
}

async function listOrganizations($: Runtime, timeoutMs?: number): Promise<Organization[]> {
  const organizations = organizationsFrom(await command($, ['org', 'list'], 'org list', undefined, timeoutMs))
  for (const organization of organizations) organizationNames.set(organization.id, organization.name)
  currentOrganizationId = (organizations.find((organization) => organization.current) ?? organizations[0])?.id
  return organizations
}

function loadOrganizationDirectory($: Runtime): Promise<void> {
  organizationDirectory ??= (async () => {
    const [organizations, login] = await Promise.all([listOrganizations($), readLogin($).catch(() => undefined)])
    personalOrganizationIds = new Set(organizations.filter((org) => isPersonalOrganization(org, login)).map((org) => org.id))
  })().catch(() => undefined)
  return organizationDirectory
}

/** The signed-in account's GitHub login, from `delta --json auth status`. */
async function readLogin($: Runtime): Promise<string | undefined> {
  const status = await command($, ['auth', 'status'], 'auth status')
  return typeof status?.account?.login === 'string' ? status.account.login : undefined
}

/** The name of an organization, or of the current one when the caller names none. */
function organizationName(id: string | undefined): string | undefined {
  return organizationNames.get(id ?? currentOrganizationId ?? '')
}

/** The organization a checkout's `.delta/settings.json` names, in any mode; undefined when it names none or can't be read. */
async function savedOrganization($: Runtime, root: string): Promise<string | undefined> {
  try { return readProjectPolicy(await setupEnv($).readFile(policyPath(root))).policy.organization }
  catch { return undefined }
}

/** The host bindings the setup wizard and onboarding run against. */
function setupEnv($: Runtime): SetupEnv {
  const session = active
  const epoch = sessionEpoch
  let cwd: string | undefined
  const check = async () => {
    if (active !== session || sessionEpoch !== epoch || await $.session.id() !== session ||
        (cwd !== undefined && !samePath(await $.session.cwd(), cwd)))
      throw new Error('The Claude session or folder changed during setup; the obsolete setup was stopped')
  }
  return {
    checkoutRoot: async () => {
      cwd = await $.session.cwd()
      await check()
      return checkoutRoot($)
    },
    // Linked worktrees share the common directory, so they share one onboarding marker. Git before
    // 2.31 has no `--path-format`, so the directory is resolved against the checkout root instead.
    gitCommonDir: async () => {
      try {
        const root = await checkoutRoot($)
        const result = await $.process.run(['git', 'rev-parse', '--git-common-dir'], { cwd: root })
        if (result.exitCode !== 0 || result.isStdoutTruncated) return undefined
        const lines = result.stdout.trim().split('\n')
        if (lines.length !== 1 || !lines[0]) return undefined
        return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(lines[0]) ? lines[0] : `${root}/${lines[0]}`
      } catch { return undefined }
    },
    contract: async () => {
      let progress: typeof feed.progress
      try {
        await check()
        await resolveCli($, true, (text) => {
          setProgress($, text, 'active')
          progress = feed.progress
        })
        await check()
        const contract = await readThreadContract($)
        await check()
        return contract
      } finally {
        if (progress && feed.progress === progress) clearProgress($)
      }
    },
    authenticate: async (notice) => {
      await requireAuthentication(await authenticationHost($), await resolveCli($), check, notice, '/delta-setup')
      await check()
    },
    organizations: () => listOrganizations($),
    login: () => readLogin($),
    createOrganization: (name) => createOrganization($, name),
    inviteMembers: async (organization, emails) =>
      inviteResultsFrom(await command($, ['org', 'invite', '--org', organization, '--', ...emails], 'org invite')),
    readFile: async (path) => await $.fs.exists(path) ? await $.fs.read(path) : undefined,
    writeFile: (path, text) => $.fs.write(path, text) as Promise<void>,
    // A joined thread is someone else's shared thread; an organization or unlisted one is already
    // visible beyond this account.
    sessionShared: async () => {
      const binding = stateFor(await $.session.id()).binding
      return !!binding?.joined || (!!binding?.visibility && binding.visibility !== 'private')
    },
    shareSession: async () => beginShare($, await $.session.id()),
  }
}

/**
 * How many of the plugin's own questions are open. `$.ui.ask` runs as an `AskUserQuestion` tool call,
 * which is the plugin talking to the person, not the conversation, so it is never recorded.
 */
let ownQuestions = 0

/** The interactive surface the wizard speaks through: `$.ui.ask`, when this Claude build has it. */
function claudeInteraction($: Runtime): Interaction {
  return {
    async ask(question, options) {
      let answer: unknown
      ownQuestions++
      try { answer = await $.ui.ask(question, options as never) }
      catch (error) {
        // A missing method is a build without the question API; a dismissed dialog rejects too.
        if (error instanceof TypeError) throw new InteractionUnavailable(String(error))
        throw new InteractionDismissed(String(error))
      }
      finally { ownQuestions-- }
      if (answer === undefined || answer === null || answer === '') throw new InteractionDismissed('dismissed')
      if (typeof answer === 'string') return answer
      const wrapped = answer as { label?: string; value?: string }
      return wrapped.label ?? wrapped.value ?? ''
    },
    log: async (text, to) => {
      // The transcript flattens an embedded newline to U+FFFD (see `showToPerson`), so a multi-line
      // message, like the policy file setup previews, goes out one entry per line.
      if (to !== 'transcript') return await $.ui.log(text, to ? { to } : undefined)
      for (const line of text.replace(/\n+$/, '').split('\n')) await $.ui.log(line, { to })
    },
  }
}

/** Log a notice to the transcript at most once per process. */
const noticesShown = new Set<string>()
async function notifyOnce($: Runtime, text: string) {
  if (noticesShown.has(text)) return
  noticesShown.add(text)
  await $.ui.log(text, { to: 'transcript' })
}

/** The source `classic.SessionStart` reported for each session, until the session ends. */
const sessionSources = new Map<string, string>()
/** The transcript path Claude last reported for each session in this process. */
const transcriptPaths = new Map<string, string>()

/** How much of a transcript's end is searched for the record of a continuation. */
const CONTINUATION_WINDOW_BYTES = 64 * 1024
/** A session that ended longer ago than this is not the one a starting session continues. */
const CONTINUATION_HORIZON_MS = 10 * 60 * 1000

/**
 * The session a transcript says its conversation continued in. Claude Code appends a
 * `continued-in` record when it moves a conversation to a background session (`/background`, or
 * opening the agents overview), and the new session starts with a copy under a new ID. The record
 * is undocumented and written on a best-effort basis, so its absence proves nothing.
 */
async function continuationOf($: Runtime, transcript: string): Promise<string | undefined> {
  const { size } = await $.fs.stat(transcript)
  let text = ''
  try { await readFrom($, transcript, Math.max(0, size - CONTINUATION_WINDOW_BYTES), (piece) => { text += piece }) }
  catch {
    if (size > FS_READ_LIMIT) return
    text = await $.fs.read(transcript) as string
  }
  let continuation: string | undefined
  for (const line of text.split('\n')) {
    if (!line.includes('"continued-in"')) continue
    try {
      const row = JSON.parse(line)
      if (row?.type === 'continued-in' && typeof row.continuedInSessionId === 'string') continuation = row.continuedInSessionId
    } catch { /* a partial first line from the window, or another row */ }
  }
  return continuation
}

/**
 * Whether `session` may continue another session's conversation: Claude Code reports a
 * continuation's start as a `fork` of the conversation, and it has recorded nothing of its own.
 */
function continuationCandidate(session: string, binding: Binding): boolean {
  return sessionSources.get(session) === 'fork' && !binding.thread && !binding.snapshot && !binding.joinTransition
}

/** The recording session whose conversation Claude Code continued as `session`, if any. */
async function continuedFrom($: Runtime, session: string): Promise<Binding | undefined> {
  // A Claude build without `$.store.keys` cannot enumerate the store; the continuation goes unrecorded.
  let keys: string[]
  try { keys = await $.store.keys() } catch { return }
  const now = await $.clock.now()
  for (const storeKey of keys) {
    if (!storeKey.startsWith('session:') || storeKey === key(session)) continue
    const candidate = await $.store.get(storeKey) as Binding | undefined
    if (!candidate?.thread || !candidate.snapshot) continue
    if (candidate.continuedIn === session) return candidate
    if (candidate.continuedIn || !candidate.transcript) continue
    if (candidate.endedAt !== undefined && candidate.endedAt < now - CONTINUATION_HORIZON_MS) continue
    try { if (await continuationOf($, candidate.transcript) === session) return candidate }
    catch { /* an unreadable transcript continues nothing */ }
  }
}

/**
 * Make `session` the recorder of the conversation it continues: it takes over the binding, keeps
 * recording as the same producer from the same sequence, and keeps the mount owner, so restoring
 * re-mounts the same checkouts under this process. The parent is marked first; from then on it
 * stages and delivers nothing, so the two never write the same sequence.
 */
async function adoptContinuation($: Runtime, session: string, parentSession: string): Promise<Binding | undefined> {
  return serial(async () => {
    const current = await load($, session)
    if (current.thread || current.snapshot) return
    const parent = await load($, parentSession)
    if (!parent.thread || (parent.continuedIn && parent.continuedIn !== session)) return
    await save($, { ...parent, continuedIn: session })
    const adopted: Binding = {
      ...parent, session, producer: producerOf(parent),
      owner: parent.joined ? parent.owner ?? parent.session : parent.owner,
      transcript: transcriptPaths.get(session),
    }
    delete adopted.continuedIn
    delete adopted.endedAt
    // Subagent bindings are stored under the session that ran them, which keeps delivering them.
    delete adopted.children
    // The copied transcript already shows the remote items the parent added for Claude.
    const ledger = await $.store.get(ledgerKey(parentSession))
    if (ledger !== undefined && await $.store.get(ledgerKey(session)) === undefined)
      await $.store.set(ledgerKey(session), ledger)
    await save($, adopted)
    await $.ui.log(`Delta: this conversation continued from Claude session ${parentSession}; recording carries on in this session.`, { to: 'debug' })
    return adopted
  })
}

/** Keep a recording session's transcript path current, since a `/cd` can move the file. */
async function rememberTranscript($: Runtime, session: string, transcript: string) {
  if (transcriptPaths.get(session) === transcript) return
  transcriptPaths.set(session, transcript)
  await serial(async () => {
    const current = await load($, session)
    if (current.thread && !current.continuedIn) await save($, current)
  })
}

/** Whether this session's conversation moved to another session, which now owns its mounts. */
async function handedOff($: Runtime, session: string): Promise<boolean> {
  const binding = await $.store.get(key(session)) as Binding | undefined
  if (!binding?.thread) return false
  if (binding.continuedIn) return true
  const transcript = transcriptPaths.get(session) ?? binding.transcript
  if (!transcript) return false
  let continuation: string | undefined
  try { continuation = await continuationOf($, transcript) } catch { return false }
  if (!continuation || continuation === session) return false
  // Marking here lets the continuation adopt even before its own start finds the record.
  await serial(async () => save($, { ...await load($, session), continuedIn: continuation }))
  return true
}

function newSessionFor(session: string): boolean {
  const source = sessionSources.get(session)
  return source === 'startup' || source === 'clear'
}

/**
 * A new session's capture boundary: row capture, `prompt.submit`, and `turn.start` wait on this until
 * the policy and contract decision is made. Before the decision the session holds no snapshot, so
 * activity let through early would be dropped; the promise resolves for every outcome, including a
 * refusal, and the contract check that bounds it is itself bounded by `CONTRACT_TIMEOUT_MS`.
 */
type CaptureDecision = { promise: Promise<void>; resolve: () => void }
const captureDecisions = new Map<string, CaptureDecision>()

/** Open the capture boundary for a session that is about to decide whether it records automatically. */
function beginCaptureDecision(session: string) {
  if (captureDecisions.has(session)) return
  let resolve!: () => void
  const promise = new Promise<void>((yes) => { resolve = yes })
  captureDecisions.set(session, { promise, resolve })
}

/** Resolve the boundary once made, whatever the outcome; a second call is harmless. */
function decideCapture(session: string) {
  captureDecisions.get(session)?.resolve()
  captureDecisions.delete(session)
}

/** Hold new-session activity until its capture boundary exists, or nothing when there is none. */
async function captureDecided(session: string): Promise<void> {
  await captureDecisions.get(session)?.promise
}

/**
 * Read a checkout's policy at a session's start: show a policy problem once, auto-activate a new
 * session when the policy records automatically, and offer setup when nothing configures the repo.
 * Everything here runs off the startup hook's critical path.
 */
async function startSession($: Runtime, session: string) {
  const env = setupEnv($)
  const newSession = newSessionFor(session)
  let root: string
  let policy: ProjectPolicy
  try {
    try { root = await checkoutRoot($) }
    // Outside a checkout there is nothing to record or offer.
    catch { return }
    const path = policyPath(root)
    try { policy = readProjectPolicy(await env.readFile(path)).policy }
    catch (error) {
      await notifyOnce($, `Delta settings at ${path} couldn't be read (${String(error)}). Until it's fixed, only sessions you share with /delta-share sync.`)
      return
    }
    if (policy.problem)
      await notifyOnce($, `Delta settings at ${path} couldn't be used (${policy.problem}). Until it's fixed, only sessions you share with /delta-share sync. Run /delta-setup to replace it.`)
    if (newSession && recordsAutomatically(policy) && await joinedBindingAt($, root))
      await notifyOnce($, `${root} is a worktree of a Delta thread a Claude session joined, so this session isn't recorded automatically. Run /delta-join with that thread's link to record in it.`)
    else if (newSession && recordsAutomatically(policy))
      await activateAutomatically($, session, root, { mode: policy.mode === 'private' ? 'private' : 'organization', organization: policy.organization! })
  } finally {
    // Nothing below records, so the session's activity never waits on the setup offer's dialog.
    decideCapture(session)
  }
  // Headless sessions get no reminder and are never offered setup; only an interactive surface shows them.
  if (!hasInteractiveSurface(await $.session.surfaces())) return
  stateFor(session).reminder = syncReminder(policy)
  $.ui.invalidate('ui.render')
  try {
    await offerOnboarding(env, claudeInteraction($), onboardingStore($), {
      root, configured: policy.configured, newSession, joined: !!stateFor(session).binding?.joined, joining: !!joining,
    }, (key) => { openOnboarding.set(session, key) })
  } finally {
    openOnboarding.delete(session)
  }
  // A setup the offer opened may have saved a setting; the band follows it.
  await refreshReminder($, session)
}

/** Re-read the checkout's setting after a setup, so the band's reminder follows what was saved. */
async function refreshReminder($: Runtime, session: string) {
  try {
    const root = await checkoutRoot($)
    stateFor(session).reminder = syncReminder(readProjectPolicy(await setupEnv($).readFile(policyPath(root))).policy)
  } catch { /* outside a checkout or unreadable: the band keeps what it had */ }
  $.ui.invalidate('ui.render')
}

/** The onboarding marker each session's still-open setup offer holds, cleared if the session ends first. */
const openOnboarding = new Map<string, string>()

function onboardingStore($: Runtime): OnboardingStore {
  return {
    get: (key) => $.store.get(key) as Promise<unknown>,
    set: (key, value) => $.store.set(key, value).then(() => undefined),
  }
}

/**
 * The band's reminder for a session while Delta does not sync it: a checkout with any setting points
 * to /delta-share, and one never set up to /delta-setup. A syncing session's band says `Syncing`
 * instead, so an automatic checkout's sessions show this only when they are not syncing, as a session
 * started before the setting was saved, or one Delta could not start.
 */
function syncReminder(policy: ProjectPolicy): SyncReminder {
  // Someone who chose a setting is not nudged toward setup every session.
  return policy.configured ? 'manual' : 'not set up'
}

/** Auto-activations already running in this process, so a repeated startup hook cannot create twice. */
const autoActivating = new Map<string, Promise<void>>()

/**
 * Create the thread a repository's policy asks for, request its upload intent, attach the checkout,
 * and start recording. Nothing drains or verifies the checkout until create, upload, and attach have
 * all succeeded: only then is the binding's thread and checkout made visible, so a row or prompt that
 * arrives mid-activation sees a session that is still simply local. Creation is idempotent by
 * external id, so an interrupted activation is safely re-run — from the next prompt, or a startup.
 *
 * The session's capture boundary is released once the contract gate and snapshot are settled, before
 * any network step, so a prompt or turn that arrives during create or attach is recorded
 * rather than dropped. Every await re-checks ownership: a session that ended, or that switched away
 * while a step was pending, leaves no half-initialized binding behind.
 */
function activateAutomatically($: Runtime, session: string, root: string, upload: AutoUpload): Promise<void> {
  const running = autoActivating.get(session)
  if (running) return running
  const epoch = sessionEpoch
  const ownsActivation = () => epoch === sessionEpoch && active === session
  const task = (async () => {
    const runtime = stateFor(session)
    if (active !== session || joining) return
    const existing = await serial(() => load($, session))
    if (!ownsActivation()) return
    // A session that already holds a thread, or a binding that is not ours, is never re-created.
    if (existing.thread || (existing.snapshot && !existing.autoUpload) || existing.joined || existing.joinTransition) return
    // A fresh session checks the account against the policy alongside the contract, so a repository
    // this account cannot record to is reported before anything is staged.
    const misconfiguration = existing.snapshot ? undefined : policyMisconfiguration($, upload.organization)
    try {
      // Refuse an incompatible CLI before persisting anything, so it leaves the session manual rather
      // than holding a half-initialized automatic binding.
      await requireContract($, session)
      if (!ownsActivation()) return
      const refusal = await misconfiguration
      if (!ownsActivation()) return
      const interactive = hasInteractiveSurface(await $.session.surfaces())
      if (!ownsActivation()) return
      if (refusal && !(refusal === SIGNED_OUT_REFUSAL && interactive)) {
        await stopAutomaticRecording($, session, root, refusal)
        return
      }
      // The session is new, so its snapshot is already taken: no history is exported, and live capture
      // starts with the first row. The intent is durable before any network, so a session whose server
      // is briefly unavailable retries from the next prompt. No thread or checkout is published yet,
      // so nothing drains against a checkout that is not attached or a thread that is not uploaded.
      if (!existing.snapshot) {
        const staged: Binding = { session, snapshot: true, next: 1, pending: [], checkout: root, autoUpload: upload }
        await serial(() => save($, staged))
        runtime.binding = staged
      }
      if (!ownsActivation()) return
      // The snapshot exists now, so new-session activity may pass; the network steps stay asynchronous.
      decideCapture(session)
      if (interactive) {
        // Authentication may wait on the browser for minutes. Capture locally first, so the person
        // can keep working and this same session uploads everything once sign-in finishes.
        const check = async () => {
          if (!ownsActivation()) throw new Error('Delta automatic sign-in stopped')
        }
        try {
          await requireAuthentication(await authenticationHost($), await resolveCli($), check, async (text) => {
            await check()
            setProgress($, 'Waiting for Delta sign-in…', 'active')
            await $.ui.log(text, { to: 'transcript' })
          }, '/delta-share')
        } catch (error) {
          if (!ownsActivation()) return
          // A cancelled or failed login needs an explicit retry, never another browser on each prompt.
          await stopAutomaticRecording($, session, root, {
            band: 'Not syncing: Delta sign-in incomplete · /delta-share',
            // An access requirement already says nothing was synced and how to retry.
            transcript: error instanceof AccessRequiredError ? error.message
              : `${error instanceof Error ? error.message : String(error)} This session isn't syncing. Run /delta-share to retry.`,
          })
          return
        }
        if (!ownsActivation()) return
        if (refusal === SIGNED_OUT_REFUSAL) {
          // Only the signed-in account can answer which organizations it belongs to.
          const afterSignIn = await policyMisconfiguration($, upload.organization)
          if (!ownsActivation()) return
          if (afterSignIn) {
            await stopAutomaticRecording($, session, root, afterSignIn)
            return
          }
        }
      }
      setProgress($, 'Connecting this session to Delta…', 'active')
      const created = await command($, ['thread', 'create', '--source', 'claude-code', '--external-id', session,
        '--organization', upload.organization, '--visibility', upload.mode], 'thread create')
      if (!ownsActivation()) return
      validateCreationReceipt(created)
      const attached = await command($, ['worktree', 'attach', root, '--thread', created.thread_id], 'worktree attach')
      if (!ownsActivation()) return
      validateAttachmentReceipt(attached, root)
      // Every step succeeded: now the thread and checkout become visible to drain and verification.
      await serial(async () => save($, {
        ...await load($, session), thread: created.thread_id, checkout: root, checkoutReference: attached.reference,
      }))
      if (!ownsActivation()) return
      runtime.binding = await serial(() => load($, session))
      void startConversation($, session).catch((error) => { if (ownsActivation()) void report($, error) })
      void drain($, session).catch((error) => { if (ownsActivation()) void report($, error) })
      // The band now follows Delta's background upload until Delta confirms it, whether or not the
      // watcher becomes ready: a status read is what reports the thread's link.
      clearProgress($)
      followUpload($, session)
    } catch (error) {
      if (!ownsActivation()) return
      // Retrying cannot change a permanent answer, so the session stops recording instead of queuing
      // records that would never be sent.
      if (classifyCommandFailure(error) === 'permanent') {
        await stopAutomaticRecording($, session, root, activationRefusal(error, upload.organization))
        return
      }
      // Only a staged session gets this far: everything before staging fails permanently.
      const text = `Delta couldn't start syncing this session: ${String(error)}. Nothing is lost; Delta retries on your next prompt.`
      setProgress($, text, 'error')
      await notifyOnce($, text)
    }
  })()
  autoActivating.set(session, task)
  void task.finally(() => { if (autoActivating.get(session) === task) autoActivating.delete(session) })
  return task
}

/** What the band and the transcript say when a repository's policy cannot record this session. */
type ActivationRefusal = { band: string; transcript: string }

const SIGNED_OUT_REFUSAL: ActivationRefusal = {
  band: 'Not syncing: sign in with `delta auth login`',
  transcript: "This repository syncs Claude Code sessions to DeltaDB, but Delta is signed out, so this session isn't syncing. Sign in with `delta auth login`; new sessions then sync automatically.",
}

function notMemberRefusal(organization: string): ActivationRefusal {
  const name = organizationName(organization)
  return {
    band: "Not syncing: your Delta account isn't in this repo's organization · /delta-share",
    transcript: `This repository syncs sessions to ${name ? `${name} (${organization})` : organization}, which your Delta account isn't a member of, so this session isn't syncing. Use /delta-share to share it with your own organization, ask to be added to ${name ?? 'that organization'}, or run /delta-setup if the settings name the wrong organization.`,
  }
}

/**
 * Check the signed-in account against the organization a policy records to. Only a definite answer
 * refuses: an empty or unreadable list (Delta not running, memberships not loaded yet) lets
 * activation proceed, and `thread create` checks membership again.
 */
async function policyMisconfiguration($: Runtime, organization: string): Promise<ActivationRefusal | undefined> {
  try {
    // Bounded like the contract check it runs beside, since new-session activity waits on both.
    const organizations = await listOrganizations($, CONTRACT_TIMEOUT_MS)
    if (organizations.length && !organizations.some((known) => known.id === organization))
      return notMemberRefusal(organization)
  } catch (error) {
    if (error instanceof DeltaCommandError && error.code === 'authentication_required') return SIGNED_OUT_REFUSAL
  }
}

/** Describe a permanent activation failure, recognizing the account problems a person can fix. */
function activationRefusal(error: unknown, organization: string): ActivationRefusal {
  if (error instanceof DeltaCommandError && error.reason === 'organization_not_member') return notMemberRefusal(organization)
  if (error instanceof DeltaCommandError && error.code === 'authentication_required') return SIGNED_OUT_REFUSAL
  if (error instanceof ContractRefusalError)
    return { band: `Not syncing: ${error.message}`, transcript: `This session isn't syncing: ${error.message}.` }
  const advice = error instanceof DeltaCommandError
    ? permanentFailureAdvice(error.code, true, error.reason) : 'Fix the cause, then start a new session'
  return {
    band: `Not syncing: ${advice}`,
    transcript: `Delta couldn't start syncing this session: ${error instanceof Error ? error.message : String(error)}. This session isn't syncing. ${advice}.`,
  }
}

/**
 * End automatic recording for a session the policy cannot record: drop any staged binding and its
 * outbox, so the session is simply manual again and nothing retries or grows, then report why. A
 * later /delta share exports the whole conversation from Claude's transcript, so nothing is lost.
 *
 * The band shows the refusal for the whole session. The transcript explains it once per repository
 * and refusal, remembered in the store, so every new session in a misconfigured repository stays quiet.
 */
async function stopAutomaticRecording($: Runtime, session: string, root: string, refusal: ActivationRefusal) {
  await serial(async () => {
    const binding = await load($, session)
    if (!binding.autoUpload || binding.thread) return
    await $.store.delete(key(session))
    const runtime = stateFor(session)
    runtime.binding = await load($, session)
    runtime.cleanedThrough = undefined
    // Inside `serial`, so a share that starts next cannot stage a record this removal deletes. The
    // outbox is only disk, so a failed removal leaves orphans, never a wrong binding.
    try { await collectAcknowledgedOutbox($, { session, root: outbox, next: binding.next, pending: [] }) }
    catch (error) {
      try { await $.ui.log(`Delta outbox removal after stopping automatic recording failed: ${String(error)}`, { to: 'debug' }) }
      catch {}
    }
  })
  finishProgress($, refusal.band, 'error')
  const marker = `auto-refused:${await setupEnv($).gitCommonDir() ?? root}`
  try {
    if (await $.store.get(marker) === refusal.transcript) return
    await $.store.set(marker, refusal.transcript)
  } catch { /* an unreadable marker only repeats the explanation */ }
  await $.ui.log(refusal.transcript, { to: 'transcript' })
}

/** How long after a session really ends its store entries may be removed; resuming into them dies past it. */
const STORE_HORIZON_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Remove the store entries (`session:` binding and `appended:` ledger) of sessions that really ended
 * before the horizon and hold nothing a later session would need. A binding without an end marker may
 * be live in another Claude process, so it is never removed, and neither is any session in use here.
 *
 * The store is shared by every Claude process and has no transactions, so each session is read,
 * checked, and deleted in turn: a resume elsewhere can only be lost in that one read-to-delete window.
 */
async function pruneStore($: Runtime) {
  // A Claude build without `$.store.keys` cannot enumerate the store, so retention is skipped there.
  let keys: string[]
  try { keys = await $.store.keys() } catch { return }
  const now = await $.clock.now()
  const ids = new Set(keys.flatMap((storeKey) => /^(?:session|appended):(.+)$/.exec(storeKey)?.[1] ?? []))
  for (const id of ids) {
    if (sessions.has(id)) continue
    const binding = await $.store.get(key(id)) as Binding | undefined
    if (typeof binding?.endedAt !== 'number' || binding.endedAt > now - STORE_HORIZON_MS ||
        binding.pending?.length || binding.captureFailure || binding.joinTransition) continue
    // A subagent's undelivered records keep its session, like the session's own.
    const recorded = await Promise.all((binding.children ?? []).map((agentId) =>
      $.store.get(childKey(id, agentId)) as Promise<ChildBinding | undefined>))
    if (recorded.some((child) => child?.pending.length)) continue
    for (const agentId of binding.children ?? []) await $.store.delete(childKey(id, agentId))
    await $.store.delete(key(id))
    await $.store.delete(ledgerKey(id))
  }
}

/** Begin the same publication flow `/delta share` runs, for the band's share control. */
function beginShare($: Runtime, session: string): boolean {
  if (sharing) return false
  if (stateFor(session).currentTurnId) {
    shareAfterTurn = session
    $.ui.invalidate('ui.render')
    return true
  }
  const request: ShareRequest = { session, cwd: '' }
  sharing = request
  setProgress($, 'Preparing to share…', 'active', [1, 5])
  $.clock.after(0, async () => {
    request.cwd = await $.session.cwd()
    await runShare($, request)
  })
  return true
}

/**
 * Begin the person's choice for a refused offline thread, from the band's controls. The command runs
 * off the hook, and its result clears the refusal so the queued records can drain.
 */
function beginRefusalResolution($: Runtime, session: string, kind: 'fork' | 'discard'): boolean {
  if (resolving || !stateFor(session).refusedOffline) return false
  resolving = true
  $.clock.after(0, async () => {
    try { await resolveRefusal($, session, kind) }
    catch (error) { await reportRefusal($, session, error) }
    finally { resolving = false }
  })
  return true
}

/**
 * Run the person's choice for the local changes Delta refused: **Fork & Restore** forks them into a
 * kept thread and then discards them from the original, while **Discard** discards them outright.
 * Either way the original is the server's view again when it finishes, a fork is named once, and the
 * queued records drain into the original.
 */
async function resolveRefusal($: Runtime, session: string, kind: 'fork' | 'discard'): Promise<void> {
  const state = sessions.get(session)
  if (!state || active !== session) return
  const thread = (await serial(() => load($, session))).thread
  if (!thread) return
  // Fork first: it copies the refused changes into a kept thread, and the discard then resets the original.
  const forked = kind === 'fork' ? parseThreadFork((await runRefusalCommand($, 'fork', thread)).stdout) : undefined
  checkResult(await runRefusalCommand($, 'discard', thread), 'thread discard')
  endDeliveryFailures(state)
  resumeCheckout(state, 'delivery')
  $.ui.invalidate('ui.render')
  if (forked)
    await notifyOnce($, `Delta kept this thread's offline changes in the new thread "${forked.thread_id}"; this thread carries on without them.`)
  await $.ui.log(kind === 'fork' ? "Delta forked this thread's offline changes into a kept thread." : "Delta discarded this thread's offline changes.", { to: 'debug' })
  void drain($, session).catch((error) => report($, error))
}

/** Run one `thread fork` or `thread discard` for a refused thread, failing with a typed error on a broken run. */
async function runRefusalCommand($: Runtime, kind: 'fork' | 'discard', thread: string): Promise<Awaited<ReturnType<Runtime['process']['run']>>> {
  const args = kind === 'fork' ? ['thread', 'fork', thread] : ['thread', 'discard', thread, '--force']
  let result: Awaited<ReturnType<Runtime['process']['run']>>
  try {
    result = await $.process.run([await resolveCli($), '--json', ...args], { timeoutMs: 120_000 })
  } catch (error) { throw new DeltaCommandError('process_failed', `thread ${kind} did not finish (${String(error)})`) }
  if (result.isStdoutTruncated || result.isStderrTruncated)
    throw new DeltaCommandError('command_failed', `thread ${kind} output was truncated`)
  return result
}

/** Show why the person's Fork & Restore or Discard did not resolve the refusal; the controls stay available. */
async function reportRefusal($: Runtime, session: string, error: unknown) {
  const state = sessions.get(session)
  if (!state || active !== session) return
  await $.ui.log(`Delta could not resolve this thread's offline changes: ${String(error)}. The records stay queued.`, { to: 'transcript' })
  try { $.ui.invalidate('ui.render') } catch {}
}

/** Run `/delta setup` for the active session and answer with what it did. */
async function setupCommand($: Runtime): Promise<string> {
  if (!hasInteractiveSurface(await $.session.surfaces())) return HEADLESS_REFUSAL
  const outcome = await runSetupWizard(setupEnv($), claudeInteraction($))
  if (outcome.status === 'wrote') await refreshReminder($, await $.session.id())
  return outcome.text
}

/**
 * Decide who a `/delta share` makes the session visible to: the addresses typed after the command, or
 * the person's answer to the question. A string is the command's answer when nothing is shared.
 */
async function chooseAudience($: Runtime, session: string, typed: string[]): Promise<ShareAudience | string> {
  if (typed.length) return { kind: 'invite', emails: typed }
  const binding = stateFor(session).binding
  await loadOrganizationDirectory($)
  const organization = (binding ? threadOrganization(binding) : undefined) ??
    await savedOrganization($, await checkoutRoot($)) ?? currentOrganizationId
  // A personal organization has nobody to share with, and a thread already shared with its organization stays shared.
  const team = personalOrganizationIds.has(organization ?? '') || binding?.visibility === 'organization' ? undefined
    : organizationName(organization) ?? 'your organization'
  try {
    return await chooseShareAudience(claudeInteraction($), { team, synced: sessionSyncs(binding) })
  } catch (error) {
    if (error instanceof InteractionDismissed) return ''
    if (error instanceof InteractionUnavailable)
      return 'This Claude build cannot show /delta-share\'s question. Update Claude Code, or type the email addresses to invite after /delta-share.'
    throw error
  }
}

/** Run one `/delta` action, such as `share` or `join <link>`, from `/delta` or its menu command. */
async function runDeltaCommand($: Runtime, action: string, form: CommandForm): Promise<{ text?: string }> {
  // A share, join, or setup started now would sign in again beside the wait, so it asks about that instead.
  if (/^(?:setup|share|join)\b/.test(action) && await offerToStopWaiting($)) return {}
  // The setup wizard only writes the checkout's policy; it needs no session binding or activation.
  if (action === 'setup') return { text: await setupCommand($) }
  const locator = /^join\s+(\S+)$/.exec(action)?.[1]
  const organization = /^org\s+(?:(list|current)|(switch)\s+(\S+))$/.exec(action)
  const invite = /^org\s+invite\b\s*(.*)$/.exec(action)?.[1]
  // `/delta share` asks who should see the session; addresses typed after it answer that up front.
  const shareArguments = /^share(?:\s+(.*))?$/.exec(action)?.[1] ?? ''
  const shareEmails = emailsIn(shareArguments)
  const shareAction = /^share\b/.test(action) && (!shareArguments.trim() || shareEmails.length > 0)
  if (!shareAction && !locator && !organization && invite === undefined)
    return { text: 'Usage: /delta share [<email>…] | /delta join <shared-link-or-thread> | /delta setup | /delta org list | /delta org current | /delta org switch <ID> | /delta org invite <email>…' }
  if (joining) return { text: 'A Delta join is already in progress. Wait for its result.' }
  if (sharing) return { text: 'A Delta share is already in progress. Wait for its result.' }
  if (organization)
    return organizationCommand($, organization[1] ? [organization[1]] : ['switch', '--', organization[3]!])
  if (invite !== undefined) {
    const emails = emailsIn(invite)
    if (!emails.length) {
      // The current organization is known once anything has listed them; otherwise link the dashboard itself.
      const members = currentOrganizationId ? membersUrl(currentOrganizationId) : DASHBOARD_URL
      return { text: `Usage: /delta-org invite <email> [<email>…]. Invites people to your current Delta organization. To invite many people at once, use the dashboard: ${members}` }
    }
    return organizationCommand($, ['invite', '--', ...emails])
  }
  const session = await $.session.id()
  try {
    if (session !== active || !stateFor(session).binding) await activate($, session)
    // Sharing and joining report through the band and ask through dialogs, which only these surfaces have.
    if (!hasInteractiveSurface(await $.session.surfaces()))
      return { text: `${locator ? '/delta-join' : '/delta-share'} needs an interactive Claude Code terminal or Desktop Code tab. Print mode, SDK sessions, and cloud runners aren't supported.` }
    if (locator) {
      if (stateFor(session).currentTurnId || stateFor(session).promptEntering)
        return { text: 'Wait for the current Claude turn to finish before joining.' }
      const request = { session, cwd: await $.session.cwd(), locator, form }
      joining = request
      setProgress($, 'Checking access to the shared thread…', 'active')
      $.clock.after(0, () => join($, request))
      // Progress belongs to the band; a command with no text adds no transcript row.
      return {}
    }
    if (stateFor(session).currentTurnId)
      return { text: 'Wait for the current Claude turn to finish before sharing.' }
    const request: ShareRequest = { session, cwd: await $.session.cwd(), form, choose: { emails: shareEmails } }
    sharing = request
    setProgress($, 'Preparing to share…', 'active', [1, 5])
    $.clock.after(0, () => runShare($, request))
    // Progress belongs to the band; a command with no text adds no transcript row.
    return {}
  }
  catch (error) {
    // Only activation can fail here; the share or join itself runs on the clock and reports there.
    const text = shareFailureText(error, locator ? `/delta-join ${locator}` : recoveryCommand(stateFor(session).binding))
    setProgress($, text, 'error')
    return { text }
  }
}

export function register(on: On) {
  on('prompt.submit', async ($, e, next) => {
    // A hand-off's opening line only started this session, which has joined by now. It becomes a
    // one-word turn that the thread never records, rather than a message to the thread or a
    // dropped prompt Desktop would show as blocked.
    const opening = stateFor(await $.session.id())
    if (opening.handoffClaim) {
      const claim = opening.handoffClaim
      await claim
      if (opening.handoffClaim === claim) opening.handoffClaim = undefined
      if (!opening.joinFailure && !e.turnId && e.text.trim() === HANDOFF_PROMPT) {
        opening.localTurn = {}
        return next({ ...e, text: HANDOFF_ACKNOWLEDGEMENT })
      }
    }
    const operation = promptGate({ joining: !!joining, sharing: !!sharing })
    if (operation === 'joining') return { drop: 'Delta is joining in a fresh session. Wait for the join result before submitting a prompt.' }
    if (operation === 'sharing') return { drop: 'Delta is sharing this session. Wait for the share result before submitting a prompt.' }
    const session = await $.session.id()
    const runtime = stateFor(session)
    if (runtime.joinFailure) return { drop: `${runtime.joinFailure} The prompt was not submitted.` }
    // A new session's prompt waits for its capture boundary, so a prompt typed right after `/clear` or
    // sent headlessly is recorded rather than lost before the snapshot exists.
    await captureDecided(session)
    // A hot reload can install this hook without replaying session.start.
    if (active !== session || !runtime.binding) {
      try { await activate($, session) }
      catch (error) {
        return { drop: `Delta conversation initialization failed: ${String(error)}. The prompt was not submitted.` }
      }
    }
    const blocked = promptGate({
      transition: !!runtime.binding?.joinTransition, snapshot: !!runtime.binding?.snapshot,
      restoring: !!runtime.restoring, movePending: !!runtime.moveTo, steering: !!e.turnId,
    })
    if (blocked === 'transition')
      return { drop: `The Delta join directory transition is incomplete. Run /delta-join ${runtime.binding!.joinTransition!.locator} to retry; the prompt was not submitted.` }
    if (blocked === 'restoring')
      return { drop: "Delta is restoring this thread's worktrees. Wait for the band to say they are restored, then try again. The prompt was not submitted." }
    if (blocked === 'moving')
      return { drop: "Delta is moving Claude to the thread folder between turns. Try again in a moment. The prompt was not submitted." }
    // Claude Code can start a continuation before the parent's transcript names it; look once more.
    if (runtime.binding && continuationCandidate(session, runtime.binding) && !runtime.continuationRechecked) {
      runtime.continuationRechecked = true
      const parent = await continuedFrom($, session)
      if (parent && await adoptContinuation($, session, parent.session)) {
        try { await activate($, session) }
        catch (error) { return { drop: `Delta couldn't continue recording this conversation: ${String(error)}. The prompt was not submitted.` } }
        if (runtime.restoring) return { drop: "Delta is restoring this thread's worktrees for the continued conversation. Wait for the band to say they are restored, then try again. The prompt was not submitted." }
      }
    }
    if (!runtime.binding?.snapshot) return next(e)
    // A session that records offline does not wait for the watcher and never drops a prompt for a
    // delivery pause: the pause stops delivery, and this prompt retries delivery and any incomplete
    // automatic activation once. A poison record simply stays queued, its notice shown once.
    const offline = recordsOffline(session, runtime.binding)
    // An unfinished automatic activation records locally and retries from here, whether or not the
    // CLI has answered its contract yet; there is no thread to watch or verify until it completes.
    const incomplete = activationIncomplete(runtime)
    if (offline || incomplete) {
      if (runtime.pauses.has('delivery')) resumeCheckout(runtime, 'delivery')
      retryAutomaticActivation($, session, runtime)
    } else if (runtime.pauses.has('delivery')) {
      // Watching again cannot lift a refusal, so do not restart the watcher for one.
      return { drop: `${runtime.pauses.get('delivery') ?? pauseNotice(runtime)} The prompt was not submitted.` }
    }
    // A session that does not record offline still recovers the watcher here and refuses if it cannot.
    if (!offline && !incomplete && (!runtime.binding.thread || isPaused(runtime) || feed.session !== session || feed.connection !== 'live')) {
      try { await startConversation($, session) }
      catch (error) { return { drop: `The Delta watcher is not ready: ${String(error)}. ${recoveryAdvice(runtime.binding)}.` } }
    }
    if (e.turnId) {
      const execution = runtime.binding.execution
      if (!ownsSteering(execution, e.turnId))
        return { drop: 'This Claude turn no longer owns the shared conversation.' }
      return next(e)
    }
    try {
      if (runtime.captureFailure || runtime.binding.captureFailure)
        throw new Error(`local conversation capture is paused; ${recoveryAdvice(runtime.binding)} before continuing`)
      // A prompt that arrives mid-activation records locally while create, upload, and attach finish.
      if (!activationIncomplete(runtime)) {
        await verifyCheckout($, runtime.binding)
        if (isPaused(runtime)) throw new Error(pauseNotice(runtime))
      }
    } catch (error) {
      // Offline, an unanswered checkout check says nothing about the checkout: the records stay
      // queued and retry, so the prompt proceeds rather than being dropped. A non-retryable refusal
      // or a local persistence failure still stops it.
      if (!(offline && classifyCommandFailure(error) === 'transient' && !isPaused(runtime))) {
        const text = `Delta is not ready for this prompt: ${String(error)}. The prompt was not submitted.`
        // The band names a worktree or directory that is not ready, until a prompt finds it ready.
        if (error instanceof JoinNotReadyError) pauseCheckout(runtime, 'verification', error.message)
        return { drop: text }
      }
    }
    // Remote activity that already completed precedes the prompt; later rows wait for its turn.
    // Like a native Delta send, the turn this prompt starts takes over any running remote turn.
    await settleRemote($, session)
    let result: Awaited<ReturnType<typeof next>>
    try {
      runtime.promptEntering = true
      await feed.settling
      result = await next(e)
    } catch (error) {
      runtime.promptEntering = false
      void settleRemote($, session)
      throw error
    }
    if (result.drop !== undefined) {
      runtime.promptEntering = false
      void settleRemote($, session)
    }
    return result
  }).catch(() => ({ drop: 'Delta could not safely prepare this shared turn. Retry after the watcher is ready.' }))

  // A spawn names its agent only once it resolves, and the agent's first hooks may run before that,
  // so they are held until the spawn says whether the agent is recorded.
  on('agent.spawn', async ($, e, next) => {
    // The plugin's own spawn for a thread Claude runs: the subagent is that thread's, not a new one's.
    if (adoption && e.resume === undefined && e.prompt === adoption.prompt) {
      const result = await next(e)
      if (!('deny' in result) && result.agentId) await adoptThread($, result.agentId)
      return result
    }
    const session = await $.session.id()
    const resumed = e.resume?.agentId
    const records = (resumed !== undefined && children.has(resumed)) ||
      (recordsChildren(session) && recordsSubagent(e) &&
        (e.parentAgentId === undefined || children.has(e.parentAgentId)))
    if (!records) {
      const result = await next(e)
      const agentId = 'deny' in result ? undefined : result.agentId ?? resumed
      if (agentId && !children.has(agentId)) {
        unrecordedAgents.add(agentId)
        earlyChildSteps.delete(agentId)
      }
      return result
    }
    // The spawn stays pending until its child is registered: the agent's prompt can arrive between
    // the spawn resolving and this hook getting to run again.
    pendingSpawns++
    const spawn = { parent: e.parentAgentId ?? session, name: childName(e) }
    spawning.push(spawn)
    let result: Awaited<ReturnType<typeof next>>
    try {
      result = await next(e)
      const agentId = 'deny' in result ? undefined : result.agentId ?? resumed
      if (agentId) {
        try {
          await adoptChild($, session, agentId, {
            parent: e.parentAgentId ?? session, name: childName(e), foreground: !e.background,
            resumed: resumed !== undefined,
          })
          // Claude hands a resumed run its message as a row this plugin does not record, so the
          // message is recorded here, as it was sent rather than with the history it came with.
          const child = children.get(agentId)
          if (resumed !== undefined && child) {
            const text = child.promptText ?? e.prompt
            child.promptText = undefined
            await onChild($, agentId, (child) =>
              recordChildMessage($, child, { role: 'user', content: [{ type: 'text', text }] }, `resume:${crypto.randomUUID()}`))
          }
        } catch (error) { await $.ui.log(`Delta could not record the subagent ${agentId}: ${String(error)}`, { to: 'debug' }) }
      }
    } finally {
      pendingSpawns--
      spawning.splice(spawning.indexOf(spawn), 1)
      // What an agent no spawn named did is not recorded.
      if (!pendingSpawns) earlyChildSteps.clear()
    }
    return result
  })

  on('classic.WorktreeCreate', async ($, e, next) => {
    // Claude names a subagent's isolated worktree after the agent. A recorded subagent works in a
    // fork of its parent's worktrees in Delta instead, so its work merges back there.
    const agentId = /^agent-(.+)$/.exec(e.name)?.[1]
    const session = await $.session.id()
    // The hook runs in the spawning loop: a subagent's names it, the main loop's names none.
    const parent = (e as { agent_id?: string }).agent_id ?? session
    const spawn = spawning.find((entry) => entry.parent === parent)
    if (agentId && spawn && recordsChildren(session)) {
      try {
        // A session whose recording is starting forks once its thread exists, if that is soon.
        const activating = autoActivating.get(session)
        if (activating) {
          const expiry = new AbortController()
          await Promise.race([activating.catch(() => undefined),
            $.clock.sleep(FORK_ACTIVATION_WAIT_MS, { signal: expiry.signal }).catch(() => undefined)])
          expiry.abort()
        }
        const directory = await forkChild($, session, agentId, parent, spawn.name)
        if (directory) return { worktreePath: directory }
      } catch (error) {
        await $.ui.log(`Delta could not fork the worktrees of the subagent ${agentId}; Claude makes its own: ${String(error)}`, { to: 'debug' })
      }
    }
    return next(e)
  })

  on('classic.WorktreeRemove', async ($, e, next) => {
    const session = await $.session.id()
    for (const child of children.values()) {
      if (child.session !== session) continue
      const binding = await loadChild($, child).catch(() => undefined)
      if (!binding?.mountOwner || !binding.reference || !binding.directories?.some((directory) => samePath(directory, e.worktree_path))) continue
      // Delta deletes its checkout once its changes are uploaded; the fork stays in the thread.
      await unmountThread($, binding.reference, binding.mountOwner)
      return {}
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // Claude 2.1.299+ raises turn.start inside a child agent's or teammate's own loop, with
    // `agentId` set. That loop is not the shared conversation: only the main loop's turns may
    // bind `currentTurnId` or open an execution. A recorded subagent's turn is its own thread's.
    if (e.agentId !== undefined) {
      if (mayRecordChild(e.agentId)) {
        // The child's own hook is the only place its working directory can be read.
        const cwd = await $.session.cwd()
        await onChild($, e.agentId, (child) => beginChildTurn($, child, e.turnId, cwd))
      }
      return next(e)
    }
    const session = await $.session.id()
    await captureDecided(session)
    const runtime = stateFor(session)
    runtime.currentTurnId = e.turnId
    if (runtime.localTurn && !runtime.localTurn.turnId) runtime.localTurn.turnId = e.turnId
    if (!runtime.binding?.snapshot || isLocalTurn(runtime, e.turnId)) return next(e)
    try {
      await beginExecution($, session, e.turnId)
      // A session that records offline keeps its turn while the watcher is down, and a delivery pause
      // stops delivery rather than Claude: observation and delivery are not required to record, and a
      // transient refusal queues rather than stopping the turn. A verification pause still stops it.
      const offline = recordsOffline(session, runtime.binding)
      const blockingPause = offline ? runtime.pauses.has('verification') : isPaused(runtime)
      const observationDown = !offline && !activationIncomplete(runtime) &&
        (feed.session !== session || feed.connection !== 'live')
      if (blockingPause || runtime.captureFailure || observationDown)
        await loseExecution($, session, runtime.nativeTurns.get(e.turnId)!, 'Delta observation or capture is unavailable')
      else void drain($, session).catch((error) => report($, error))
    } catch (error) {
      // A hook's return value cannot prevent this turn. Cancel the local ID when
      // its durable start/binding could not be saved; never run uncorrelated output.
      await $.turn.abort({ turnId: e.turnId })
      await recordCaptureFailure($, session, error)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const result = await next(e)
      if (mayRecordChild(e.agentId)) {
        // A run found going when recording started attaches its own checkout now, read from its hook.
        const cwd = await $.session.cwd()
        await onChild($, e.agentId, (child) => endChildTurn($, child, e.turnId, stopReasonOf(e), cwd))
        const child = children.get(e.agentId)
        if (child) {
          await finishChildRun($, child)
          await reportClaudeRun($, child)
        }
      }
      return result
    }
    const session = await $.session.id()
    const runtime = stateFor(session)
    const sequence = runtime.nativeTurns.get(e.turnId) ??
      (runtime.binding?.execution?.turnId === e.turnId ? runtime.binding.execution.sequence : undefined)
    if (runtime.currentTurnId === e.turnId) runtime.currentTurnId = undefined
    if (isLocalTurn(runtime, e.turnId)) runtime.localTurn = undefined
    runtime.promptEntering = false
    runtime.nativeTurns.delete(e.turnId)
    const result = await next(e)
    if (sequence !== undefined) runtime.tools.forgetUnpaired(sequence)
    if (sequence !== undefined) {
      try { await endExecution($, session, sequence, () => true, 'bounded', stopReasonOf(e)) }
      catch (error) { await report($, error) }
    }
    // Release the remote rows held back while this turn ran now that its finish is staged: delivered
    // within the budget, or queued in the outbox behind any later records. Each
    // row waits for a redraw to be drawn, and drawing is the host's business after the hook returns,
    // so this runs on its own rather than holding a host that may exit at the turn's end. A later
    // prompt or live event reuses the same settling task, so nothing settles or draws twice.
    if (runtime.currentTurnId === undefined) {
      void settleRemote($, session)?.catch((error) => report($, error))
      scheduleMove($, session)
      if (shareAfterTurn === session) {
        shareAfterTurn = undefined
        beginShare($, session)
      }
    }
    return result
  })

  // The band above the prompt: the connection, the thread's link to click or copy, and who is here
  // or whose agent is working. It draws only while a Delta conversation is active, yields to a
  // survey, and takes at most the band's rows. Draining the queued message rows here also gives
  // them the hook context their own command needs.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await drainMessages($)
    if (!statusShown() || e.props.hasSurvey) return next(e)
    const maxRows = Math.max(0, e.props.maxRows)
    if (maxRows === 0) return next(e)
    const terminal = e.surface === 'terminal'
    const columns = Math.max(0, e.props.bodyColumns)
    const band = renderBand(await statusView($), { columns, terminal, rows: maxRows })
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const spans = (segments: StatusSegment[]) =>
      segments.map((segment, index) => <Text key={String(index)} {...segmentProps(segment)}>{segment.text}</Text>)
    const { text, href, ownRow, copy } = band.link ?? {}
    // A followable link is a real hyperlink on every surface, so a terminal can open it however it
    // handles clicks. The terminal's Link takes no label: where Claude does not treat the terminal as
    // hyperlink-capable, a labelled Link prints its label and then its URL, the same text twice, while
    // an unlabelled one prints the URL once. While a share or join runs, the link is shown dim and not
    // offered.
    let link = null
    if (text && href) link = terminal ? <Link href={href} /> : <Link href={href} label={text} />
    else if (text) link = <Text {...segmentProps({ text, dim: true })}>{text}</Text>
    let copier = null
    if (href && copy?.copied) copier = <Text color="green">{copyText(copy)}</Text>
    // Taking the band's focus lands on the copy control, so Enter copies; a hotkey hint would read
    // as though the key worked from the prompt, where it only types.
    else if (href && copy) copier = <Button key="copy" plain dimColor autoFocus label={copy.label}
      onPress={(press) => { void copyLink($, href, press.surface).catch((error) => report($, error)) }} />
    // A private thread offers the same publication `/delta share` runs; the band does not repeat it
    // once the thread is shared with the organization.
    const sharer = band.share ? <Button key="share" plain dimColor label={band.share.label}
      onPress={() => { if (feed.session) beginShare($, feed.session) }} /> : null
    // A refused offline thread offers the person the choice that resolves it.
    const conflict = band.conflict ? [
      <Button key="fork" plain dimColor label={band.conflict.fork}
        onPress={() => { if (feed.session) beginRefusalResolution($, feed.session, 'fork') }} />,
      <Button key="discard" plain dimColor label={band.conflict.discard}
        onPress={() => { if (feed.session) beginRefusalResolution($, feed.session, 'discard') }} />,
    ] : []
    // Every control is set apart by the same gap the band's other segments use.
    const controls = [copier, sharer, ...conflict].filter((control) => control !== null)
      .flatMap((control, index) => index ? [<Text key={`gap-${index}`}>{'  '}</Text>, control] : [control])
    const inline = link && !ownRow
    const rows = [
      <Box key="band" flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Box flexDirection="row">
          <Text wrap="truncate-end">
            <Text {...segmentProps(band.mark)}>{band.mark.text}</Text>
            {spans(band.label)}
            {inline ? '  ' : ''}{inline ? link : null}
            {band.audience?.length ? <Text>{'  '}{spans(band.audience)}</Text> : null}
            {controls.length ? '  ' : ''}
          </Text>
          {controls}
        </Box>
        {band.right.length ? <Text wrap="truncate-end">{spans(band.right)}</Text> : null}
      </Box>,
      link && ownRow ? <Text key="link">{'  '}{link}</Text> : null,
      band.detail && maxRows >= 2 ? <Text key="detail" wrap="truncate-end">{'  '}{spans(band.detail)}</Text> : null,
    ].filter((part) => part !== null)
    // Another participant's working agent reads like Claude's own working line: unshaded, above the
    // band, where its finished calls then land in the transcript.
    const activity = band.activity ? <Text key="activity" wrap="truncate-end">{spans(band.activity)}</Text> : null
    const childActivity = band.childActivity ? <Text key="children" wrap="truncate-end">{spans(band.childActivity)}</Text> : null
    // The desktop's own card sets the band apart. The terminal shades it, a status bar the width of
    // the band, so it reads as part of the input area rather than another transcript row.
    if (!terminal) return <Box flexDirection="column">{activity}{childActivity}{rows}</Box>
    const bar = <Box key="bar" flexDirection="column" width={columns} paddingX={1} backgroundColor={await barShade($)}>{rows}</Box>
    if (!activity && !childActivity) return bar
    return <Box flexDirection="column" width={columns}>
      {activity ? <Box paddingX={1}>{activity}</Box> : null}
      {childActivity ? <Box paddingX={1}>{childActivity}</Box> : null}
      {bar}
    </Box>
  })

  // The plugin's own command output row: a remote message, event, tool call or comment draws here, from this
  // plugin's own data rather than the row's stored text, which carries none of it.
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    const id = shownItemId(e.props.args)
    if (e.props.command !== 'delta' || id === undefined) return next(e)
    const view = feed.view
    const item = view?.items.get(id)
    const { Box, Text, Markdown } = $.ui.resolve(e)
    if (view?.wasRemoved(id)) return <Box />
    const commentId = keyedComment(id)
    if (commentId !== undefined) {
      const comment = view?.comments.get(commentId)
      if (!view || !comment) return <Text dimColor>A Delta comment that is not in this session.</Text>
      // What the comment refers to is earlier material: dim, behind a gutter, elided. The comment
      // itself is new and draws in full, like a message.
      const parent = view.commentParent(comment)
      const target = view.commentTarget(comment)
      const reply = comment.chain !== comment.id
      const quoted = commentQuote(comment, parent, target, view.items, (e.viewport?.columns ?? 80) - 2)
      return <Box flexDirection="column">
        <Text wrap="truncate-end">
          {reply ? <Text dimColor>{'↳ '}</Text> : null}
          <Text bold color={personColor(personKey(comment.author))}>{commentAuthor(comment)}</Text>
          <Text dimColor>{` ${commentAction(comment, parent, target)}${comment.routed_to ? ' · sent to a subthread' : ''}`}</Text>
        </Text>
        {quoted.map((line, index) => <Text key={`quote-${index}`} dimColor wrap="truncate-end">
          {'│ '}{line.before}<Text {...line.emphasis && (line.before || line.after) ? { underline: true } : {}}>{line.marked}</Text>{line.after}
        </Text>)}
        <Markdown key="delta-comment" text={commentMarkdown(comment, view.thread)} />
      </Box>
    }
    // After a restart, the stored row can draw before the watch supplies its content.
    if (!view || !item) return <Text dimColor>A Delta item that is not in this session.</Text>
    // An item with nothing left to draw, such as an agent message that only held a comment reply.
    if (!isDrawnItem(item)) return <Box />
    if (isEventItem(item)) return <Box flexDirection="column">
      <Text dimColor>Delta activity</Text>
      <Markdown key="delta-event" text={itemMarkdown(item, view.thread)} />
    </Box>
    // An author keeps the color the band gives them; a person's message and their agent's are told apart by label.
    const agent = item.kind !== 'user_message'
    if (item.kind === 'tool_call') {
      // One line, like Claude's own tool rows: the tool in bold, its key input dim, a failure in red.
      // A single Text of spans never wraps a part on its own; the input gives way first, in its
      // middle, so its start and its end (a path's file, a command's last argument) both stay.
      const { name, author, status, statusText, shown } = toolRowParts(item, e.viewport?.columns ?? 80)
      return <Text wrap="truncate-end">
        <Text bold color={authorColor(item)}>{author}</Text>
        <Text dimColor>{' › '}</Text>
        <Text bold>{name}</Text>
        {shown ? <Text dimColor>{` ${shown}`}</Text> : null}
        {statusText ? <Text color={status === 'failed' ? 'red' : 'yellow'}>{statusText}</Text> : null}
      </Text>
    }
    return <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Text bold color={authorColor(item)}>{itemAuthor(item)}</Text>
        <Text dimColor>{agent ? '(agent)' : '(person)'}</Text>
      </Box>
      <Markdown key="delta-message" text={itemMarkdown(item, view.thread)} />
    </Box>
  })
  on('session.end', async ($, e, next) => {
    sessionSources.delete(e.sessionId)
    // A setup offer still open when its session ends was never decided, so the next session offers it again.
    const offer = openOnboarding.get(e.sessionId)
    openOnboarding.delete(e.sessionId)
    if (offer) {
      try { await releaseOnboarding(onboardingStore($), offer) }
      catch { /* the offer then simply stays consumed, as before */ }
    }
    // A session that ended can never reach its capture boundary; release anything held on it.
    decideCapture(e.sessionId)
    if (sharing?.session === e.sessionId) {
      sharing.cancelled = true
      sharing = undefined
    }
    if (shareAfterTurn === e.sessionId) shareAfterTurn = undefined
    // The session's subagents end with it. Their saved state stays, so the next activation closes
    // a turn left open and delivers what they queued.
    for (const [agentId, child] of children) {
      if (child.session !== e.sessionId) continue
      child.retryTimer?.cancel()
      children.delete(agentId)
    }
    if (joining && e.sessionId === (joining.fresh ?? joining.session) &&
        !(joining.clearing && e.reason === 'clear' && e.sessionId === joining.session)) {
      joining.cancelled = true
      joining = undefined
    }
    if (activatingSession === e.sessionId) {
      sessionEpoch++
      activatingSession = ''
    }
    if (active === e.sessionId) active = ''
    const runtime = stateFor(e.sessionId)
    runtime.mounted = undefined
    runtime.restoring = undefined
    runtime.moveTo = undefined
    runtime.notes = []
    runtime.nativeTurns.clear()
    runtime.tools.clear()
    runtime.lostTurns.clear()
    runtime.heldRows = undefined
    runtime.retryTimer?.cancel()
    runtime.retryTimer = undefined
    runtime.uploadRefresh?.cancel()
    runtime.uploadRefresh = undefined
    runtime.uploadRefreshAttempts = 0
    runtime.currentTurnId = undefined
    runtime.promptEntering = false
    runtime.reminder = undefined
    if (feed.session === e.sessionId) await stopConversation()
    // A resumed session re-checks the CLI's contract, as a fresh process's first participation does.
    contractVerified.delete(e.sessionId)
    titleReaders.delete(e.sessionId)
    // A joined or shared session keeps reporting through its transition; an ordinary end clears it.
    if (!joining && !sharing) clearProgress($)
    // Rows not yet saved and a running outbox cleanup still belong to this state.
    if (!runtime.unsaved.length && !runtime.cleanupTask && sessions.get(e.sessionId) === runtime)
      sessions.delete(e.sessionId)
    // Every end, including a clear or a switch, marks when this session stopped here: only a marked
    // binding can be pruned, since an unmarked one may be live in another Claude process.
    try {
      const stored = await $.store.get(key(e.sessionId)) as Binding | undefined
      if (stored?.session === e.sessionId && stored.endedAt === undefined)
        await $.store.set(key(e.sessionId), { ...stored, endedAt: await $.clock.now() })
    } catch { /* a session that cannot record its end is simply never pruned */ }
    // Exiting ends the session's use of its checkouts. A clear is the join's own transition and a
    // resume only switches sessions, so neither releases them. A conversation that moved to another
    // session keeps its checkouts there; its subagents' stay with this session and are released.
    if (releasesMounts(e.reason)) {
      if (!await handedOff($, e.sessionId)) await releaseMounts($, e.sessionId)
      const ended = await $.store.get(key(e.sessionId)).catch(() => undefined) as Binding | undefined
      await releaseThreadMounts($, e.sessionId, ended?.children ?? [])
    }
    // An offered hand-off nobody opened goes with the tab that offered it.
    const offered = runtime.offered
    runtime.offered = undefined
    if (offered && releasesMounts(e.reason)) await releaseHandoff($, offered, true)
    return next(e)
  })

  // A changed theme changes the status bar's shade.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    barTheme = undefined
    $.ui.invalidate('ui.render')
    return result
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'delta', description: 'Share or join a Delta session, set up syncing, or choose an organization', argumentHint: 'share [<email>…] | join <shared-link-or-thread> | setup | org list | org current | org switch <ID>' })
    // Plugin commands cannot declare subcommands, so each `/delta` action is also its own command and
    // appears in the slash-command menu.
    await $.command.register({ name: 'delta-share', description: 'Delta: sync this session and its code to DeltaDB, and choose who sees it', argumentHint: '[<email>…]' })
    // Claude's menu shows a command's description but not its argument hint, so the description carries the format.
    await $.command.register({ name: 'delta-join', description: 'Delta: join a shared conversation. Needs its link: /delta-join <link>', argumentHint: '<shared-link-or-thread>' })
    await $.command.register({ name: 'delta-setup', description: 'Delta: choose which sessions in this repository sync to DeltaDB' })
    await $.command.register({ name: 'delta-org', description: 'Delta: manage your organization. /delta-org list, current, switch <ID>, or invite <email>', argumentHint: 'list | current | switch <ID> | invite <email>…' })
    const result = await next(e)
    const session = await $.session.id()
    try { await activate($, session) }
    catch (error) { await report($, error) }
    // Claude delivers the first prompt only after this hook returns, so a session started for a
    // hand-off finishes joining here, and its opening line meets a joined session. Waiting in
    // `prompt.submit` instead would count the join against that hook's 10-second budget, while
    // the Delta commands the join runs here are `$` calls, which that budget never counts. The
    // claim reports its own failure.
    await stateFor(session).handoffClaim
    return result
  })

  // Claude names a session in its transcript file, not through any hook, so the title is read there
  // when a turn ends: the title Claude chose for the first prompt, or a `/rename` made since.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (typeof e.transcript_path === 'string' && e.transcript_path)
      void $.session.id().then((session) => rememberTranscript($, session, e.transcript_path)).catch(() => {})
    // The turn's end never waits for the title, and nothing about the title can fail it.
    if (typeof e.transcript_path === 'string' && e.transcript_path)
      void $.session.id().then((session) => recordTitle($, session, e.transcript_path)).catch(() => {})
    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    sessionSources.set(e.session_id, typeof e.source === 'string' ? e.source : '')
    if (typeof e.transcript_path === 'string' && e.transcript_path) transcriptPaths.set(e.session_id, e.transcript_path)
    // A new session's capture boundary opens before anything can reach a hook, and `startSession`
    // resolves it once the policy and contract decision is made.
    if (newSessionFor(e.session_id)) beginCaptureDecision(e.session_id)
    const result = await next(e)
    if (joining) {
      // A join runs its own transition and never auto-activates, so nothing waits on this session.
      decideCapture(e.session_id)
      return result
    }
    try { await activate($, e.session_id) }
    catch (error) { await report($, error) }
    // Only a new session (startup or clear) is auto-activated; a resume, compaction, or fork keeps
    // whatever policy it had. The offer and activation never delay a prompt.
    $.clock.after(0, () => { void startSession($, e.session_id).catch((error) => { void report($, error) }) })
    return result
  })

  on('command.run', { command: 'delta' }, async ($, e) => {
    const action = e.args.trim()
    // The plugin's own rows reach this handler, and nothing else: a person who types the internal
    // form gets the usage text below. The argument is an item id, never content.
    const internal = shownItemId(action)
    // A plugin's own run reads this plugin's name; anyone else who types the internal form is a
    // person or another plugin, and gets the usage text below.
    if (internal !== undefined && e.origin?.kind === 'plugin' && e.origin.name === $.plugin.name)
      return { text: SHOW_ANSWER }
    return runDeltaCommand($, action, 'delta_subcommand')
  })
  on('command.run', { command: 'delta-share' }, async ($, e) => runDeltaCommand($, `share ${e.args.trim()}`.trim(), 'dedicated_command'))
  on('command.run', { command: 'delta-join' }, async ($, e) => e.args.trim()
    ? runDeltaCommand($, `join ${e.args.trim()}`, 'dedicated_command')
    : { text: 'Usage: /delta-join <link>. Paste the Delta link someone shared with you, such as /delta-join https://delta.dev/join/…, or a thread ID.' })
  on('command.run', { command: 'delta-setup' }, async ($, e) => runDeltaCommand($, `setup ${e.args.trim()}`.trim(), 'dedicated_command'))
  on('command.run', { command: 'delta-org' }, async ($, e) => e.args.trim()
    ? runDeltaCommand($, `org ${e.args.trim()}`, 'dedicated_command')
    : { text: 'Usage: /delta-org list (your organizations), /delta-org current (the selected one), /delta-org switch <ID>, or /delta-org invite <email>… (invite people to the selected one).' })

  on('session.append', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      const stored = await next(e)
      if ('deny' in stored || !mayRecordChild(agentId)) return stored
      const message = capturedMessage(stored.message, e.door)
      if (message) await onChild($, agentId, (child) => {
        // A run the plugin started on a thread is recorded as prompted with the message alone, not
        // the thread history it was handed with it. The prompt may arrive before the run is bound.
        if (child.promptText !== undefined && e.door === 'prompt' && message.content.some((block) => block.type === 'text')) {
          const text = child.promptText
          child.promptText = undefined
          return recordChildMessage($, child, { role: 'user', content: [{ type: 'text', text }] }, stored.uuid)
        }
        return recordChildMessage($, child, message, stored.uuid)
      })
      return stored
    }
    // The plugin's own `show` run is stored rewritten, so neither the model nor a resumed session's
    // copy of these rows names the internal command or its item id.
    const shown = shownCommandRewrite($.plugin.name, e)
    if (shown !== undefined) return next({ ...e, message: { ...e.message, content: shown } })
    if (!capturedMessage(e.message, e.door)) return next(e)
    const session = await $.session.id()
    // A row from a brand-new session waits for its capture boundary, so a prompt or its output that
    // reaches a hook before the snapshot is staged is recorded under the session's new thread.
    await captureDecided(session)
    const runtime = stateFor(session)
    // The hand-off's one-word turn, its prompt included, stays out of the thread.
    if (runtime.localTurn) return next(e)
    // A composer prompt is this person's own input. Its turn's start record is
    // only written at turn.start, after this row, so the row is held to be
    // recorded under that turn; a prompt sent into a running turn names it now.
    const ownPrompt = e.door === 'prompt' && e.message.role === 'user'
    const assistant = e.message.role === 'assistant'
    if (gate) await gate
    inFlight++
    try {
      const stored = await next(e)
      if (!('deny' in stored) && runtime.binding?.snapshot) {
        const message = capturedMessage(stored.message, e.door)
        if (message) {
          rememberToolResults(runtime.tools, message)
          const updates = messageUpdates(message, stored.uuid, runtime.tools.structuredResults,
            { root: boundDirectory(runtime.binding), omitted: runtime.tools.omitted }).map(liveActivity)
          // Output from the turn Claude is running waits for that turn's scoped start record, so
          // it names its own turn rather than the turn before it. The prompt starting a turn is
          // held the same way, because its start record is written after its row.
          const turnSequence = assistant ? contentTurn(runtime)
            : ownPrompt ? runtime.binding?.execution?.sequence : undefined
          const hold = ownPrompt ? !runtime.binding?.execution
            : assistant && turnSequence === undefined && runtime.currentTurnId !== undefined
          if (hold) {
            // A composer prompt is held for whichever turn starts next; output is held for the
            // turn Claude is running, and dropped if that turn never owns its start.
            holdRows(runtime, updates, ownPrompt ? undefined : runtime.currentTurnId)
          } else {
            for (const update of updates) {
              const tool = update.sessionUpdate === 'tool_call_update' && typeof update.toolCallId === 'string'
                ? update.toolCallId : undefined
              if (tool && !runtime.tools.toolTurns.has(tool)) runtime.tools.toolTurns.set(tool, turnSequence)
              await persistUpdates($, session, [update], tool ? runtime.tools.toolTurns.get(tool) : turnSequence)
            }
          }
          for (const block of message.content) {
            if (block.type === 'tool_result' && typeof block.tool_use_id === 'string')
              runtime.tools.settle(block.tool_use_id, 'row')
          }
          if (!hold && !runtime.captureFailure && runtime.binding.thread)
            void drain($, session).catch((error) => report($, error))
        }
      }
      return stored
    } finally {
      inFlight--
      if (!inFlight && quiet) { quiet(); quiet = undefined }
    }
  })

  on('session.send', async ($, e, next) => {
    const session = await $.session.id()
    if (typeof e.to !== 'string' || !recordsChildren(session)) return next(e)
    const sender = e.agentId !== undefined && children.has(e.agentId) ? e.agentId : session
    try {
      const sent = await sendToThread($, session, sender, e.to, e.text, (to, text) => next({ ...e, to, text }))
      return sent ?? await next(e)
    } catch (error) {
      return { isDelivered: false, reason: `Delta could not run that thread here: ${String(error)}` }
    }
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      const result = await next(e)
      const id = e.tool_use_id
      if (id && mayRecordChild(agentId) && 'result' in result && result.result !== undefined)
        await onChild($, agentId, (child) =>
          recordChildToolResult($, child, { tool: e.tool, tool_use_id: id, input: e }, result.result, !!result.isError))
      return result
    }
    if (ownQuestions && e.tool === 'AskUserQuestion') return next(e)
    const session = await $.session.id()
    const runtime = stateFor(session)
    if (runtime.localTurn) return next(e)
    // The turn this call belongs to is fixed now, so a later result row keeps it even after the
    // turn ends. While Claude runs a turn whose scoped start is not yet written, the call waits
    // for that start so it does not name the turn before it.
    const turnSequence = contentTurn(runtime)
    if (e.tool_use_id && turnSequence !== undefined) runtime.tools.toolTurns.set(e.tool_use_id, turnSequence)
    const hold = turnSequence === undefined && runtime.currentTurnId !== undefined
    if (e.tool_use_id && isOmittedTool(e.tool)) runtime.tools.omitted.add(e.tool_use_id)
    try {
      const result = await next(e)
      if (gate) await gate
      if (!runtime.binding?.snapshot || !e.tool_use_id || runtime.tools.omitted.has(e.tool_use_id) ||
          !('result' in result) || result.result === undefined) return result
      const root = boundDirectory(runtime.binding)
      const update = resultUpdate(e.tool_use_id, e.tool, result.result, !!result.isError, root)
      runtime.tools.structuredResults.set(e.tool_use_id, update)
      const row = runtime.tools.toolResults.get(e.tool_use_id)
      const updates = (row
        ? messageUpdates({ role: 'user', content: [row] }, `tool-result:${e.tool_use_id}`, runtime.tools.structuredResults)
        // Keep structured output visible in Delta without closing before the model's result text arrives.
        // The call's input row may not be stored yet, so this record names the call itself; the event
        // carries the tool's arguments beside its reserved keys.
        : [{ ...update, status: 'in_progress', name: e.tool,
          ...toolInfo(e.tool, e, root) }]).map(liveActivity)
      if (hold) holdRows(runtime, updates, runtime.currentTurnId)
      else await persistUpdates($, session, updates, turnSequence)
      if (!hold && !runtime.captureFailure && runtime.binding.thread)
        void drain($, session).catch((error) => report($, error))
      return result
    } finally {
      if (e.tool_use_id) {
        // Only a shared session ever records the result row that would pair with this call.
        if (runtime.binding?.snapshot) runtime.tools.settle(e.tool_use_id, 'call')
        else runtime.tools.forget(e.tool_use_id)
      }
    }
  })
}
