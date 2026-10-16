import type { ApiMessage, EngineInterface, On, RenderSurface, TextProps, Timer } from 'claude-code'
import { capturedMessage, isOmittedTool, messageUpdates, resultUpdate, toolInfo, type Update } from './content'
import { ToolRecords } from './tool-records'
import { acknowledgedOutboxFiles, acknowledgedPrefix, appendBatch, appendOutboxRecord, outboxChunks, outboxRemoval } from './outbox'
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
  JoinNotReadyError, contractRefusal, contractVersion, parseThreadContract, parseThreadMount, parseThreadStatus, parseWatchEvent,
  validateJoinedMounts, parseThreadFork, validateThreadFrontier, validateThreadCheckout, OFFLINE_CONTRACT_VERSION, PLUGIN_CONTRACT_VERSION, TITLE_CONTRACT_VERSION, JOIN_INTENT_CONTRACT_VERSION,
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
  DASHBOARD_URL, HEADLESS_REFUSAL, InteractionDismissed, InteractionUnavailable, createdOrganizationFrom, emailsIn, inviteResultsFrom, membersUrl, offerOnboarding,
  organizationsFrom, releaseOnboarding, runSetupWizard,
  type Interaction, type OnboardingStore, type Organization, type SetupEnv,
} from './setup'
import { DeltaCli } from './cli'
import { PendingAuthenticationError, requireAuthentication, type AuthenticationHost } from './auth'
import {
  HANDOFF_ACKNOWLEDGEMENT, HANDOFF_EXPIRY_MS, HANDOFF_PROMPT, newSessionLink, parseHandoff, type Handoff,
} from './handoff'

type Runtime = EngineInterface
type Entry = { sequence: number; files: string[]; digest: string }
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
   * Set on a session this plugin created from the repository's policy: what it uploads. Such a
   * session may participate while its thread is still local-only.
   */
  autoUpload?: AutoUpload
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
type ShareRequest = { session: string; cwd: string; cancelled?: boolean; form?: CommandForm }
/** How a person ran a share or join: `/delta share` (`delta_subcommand`) or `/delta-share` (`dedicated_command`). */
type CommandForm = 'delta_subcommand' | 'dedicated_command'

/** The CLI environment that labels the command a share or join reports with how it was run, for Delta's telemetry. */
function commandFormEnv(form: CommandForm | undefined): Record<string, string> {
  return form ? { DELTA_CLI_COMMAND_FORM: form } : {}
}

const encoder = new TextEncoder()
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
/** A Keep or Discard the band started, so its two controls cannot both run at once. */
let resolving = false
/**
 * Sessions whose CLI build already answered a compatible recording contract, each with the range it
 * reported so the negotiated version and its offline capability are both known; a refusal is never
 * remembered.
 */
const contractVerified = new Map<string, number>()
/**
 * Whether this session records offline, on a CLI that speaks the contract where
 * `append --acknowledge local` answers without the server. An automatic or
 * shared session does: it writes to its own thread, and Delta's background uploader pushes what it
 * acknowledged locally. A joined session writes into someone else's thread, so it keeps
 * server-confirmed delivery and holds Claude while Delta is unreachable.
 */
function recordsOffline(session: string, binding: Binding | undefined): boolean {
  return !!binding && !binding.joined && (contractVerified.get(session) ?? 0) >= OFFLINE_CONTRACT_VERSION
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
        const status = await readThreadStatus($, stateFor(session).binding?.locator ?? baseline.thread_id, session, inspection.signal)
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
        '--source', 'claude-code', '--external-id', session]
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
          } else if (event.type === 'worktrees') refreshMounts($, session, event.worktrees)
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
  if (binding?.visibility === 'organization' || binding?.upload?.organization_id) void loadOrganizationDirectory($)
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
    share: binding?.visibility === 'private' ? {
      label: state?.currentTurnId ? 'Share after this turn' : `Share with ${organizationName(binding.upload?.organization_id) ?? 'organization'}`,
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

/** Who can see the thread, apart from whether it has a link: `Private`, `Shared with <org>`, or `Unlisted`. */
function audienceLabel(binding: Binding | undefined): string | undefined {
  if (!binding?.visibility) return undefined
  if (binding.visibility === 'private') return 'Private'
  if (binding.visibility === 'unlisted') return 'Unlisted'
  return `Shared with ${organizationName(binding.upload?.organization_id) ?? 'your organization'}`
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
    void readThreadStatus($, binding.locator ?? binding.thread, session)
      .then((status) => rememberStatus($, session, status))
      // An unanswered read says nothing about the upload; ask again after the next delay.
      .catch(() => followUpload($, session))
  })
}

/** Sign-in's view of the session; `$` stays in this file, as Claude Code's loader requires. */
async function authenticationHost($: Runtime): Promise<AuthenticationHost> {
  return {
    interactive: hasInteractiveSurface(await $.session.surfaces()),
    windows: await $.env.get('OS') === 'Windows_NT',
    sleep: (milliseconds, signal) => $.clock.sleep(milliseconds, { signal }),
    spawn: (argv) => $.process.spawn({ argv }),
  }
}

async function resolveCli($: Runtime, allowInstall = false) {
  return cli.resolve((argv, init) => $.process.run(argv, {
    ...init, env: { ...init?.env, DELTA_CLI_INTEGRATION: 'claude_code' },
  }), allowInstall,
    (text) => setProgress($, text, 'active'), await $.env.get('OS') === 'Windows_NT'
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
 * Refuse to record against a CLI whose recording contract this plugin does not speak. Runs once per
 * session; a refusal or a process failure is not remembered, so updating Delta and retrying re-checks.
 */
async function requireContract($: Runtime, session: string) {
  if (contractVerified.has(session)) return
  const range = await readThreadContract($)
  const refusal = contractRefusal(range)
  if (refusal) throw new Error(refusal)
  contractVerified.set(session, contractVersion(range!))
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

function rememberToolResults(state: SessionState, message: ApiMessage) {
  for (const block of message.content) {
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string')
      state.tools.toolResults.set(block.tool_use_id, block)
    else if (block.type === 'tool_use' && typeof block.id === 'string' && isOmittedTool(block.name))
      state.tools.omitted.add(block.id)
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
  await $.store.set(key(value.session), value)
  // A session already ended and pruned must not be recreated by a late write.
  const state = sessions.get(value.session)
  if (state && isCurrent()) state.binding = value
}

async function load($: Runtime, session: string): Promise<Binding> {
  const previous = await $.store.get(key(session)) as (Binding & {
    lastClaim?: number; execution?: Execution & { claim?: number }
  }) | undefined
  if (!previous || previous.session !== session) return { session, snapshot: false, next: 1, pending: [] }
  return restoreBinding(previous)
}

async function digest(input: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(input))
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function stageRecord($: Runtime, binding: Binding, body: RecordBody): Promise<Binding> {
  const sequence = binding.next
  const line = JSON.stringify({ schemaVersion: 1, sequence, ...body }) + '\n'
  const files: string[] = []
  for (const chunk of outboxChunks(line, sequence)) {
    const path = `${outbox}/${binding.session}/${sequence}-${files.length}.json`
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
  if (!runtime) return
  runtime.cleanupPlan = {
    session: binding.session, root: outbox, next: binding.next,
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
  const status = await readThreadStatus($, binding.locator ?? binding.thread!, binding.session)
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

/** Resolves true only when every pending record was delivered; stopping early because of a pause or session change is not success. */
async function drainPending($: Runtime, session: string): Promise<boolean> {
    while (active === session && sessions.has(session) && !isPaused(sessions.get(session)!)) {
      const binding = await serial(async () => load($, session))
      if (!binding.thread || !binding.pending.length) return true
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
      // Keep stdout well below process.run's 4 MiB capture limit.
      const batch: Entry[] = []
      const turnSequences: (number | undefined)[] = []
      let collected = { input: '', bytes: 0, count: 0 }
      for (const entry of binding.pending) {
        const { line, turnSequence } = appendOutboxRecord(await readRecord($, entry), entry.sequence)
        const next = appendBatch(collected, line)
        if (!next) break
        collected = next
        batch.push(entry)
        turnSequences.push(turnSequence)
        if (collected.bytes >= 2_000_000) break
      }
      const argv = [await resolveCli($), '--json', 'thread', 'append', binding.locator ?? binding.thread,
        '--source', 'claude-code', '--external-id', session,
        ...recordsOffline(session, binding) ? ['--acknowledge', 'local'] : []]
      let result: Awaited<ReturnType<Runtime['process']['run']>>
      try {
        result = await $.process.run(argv, {
          stdin: collected.input, timeoutMs: 120_000, env: { DELTA_CLI_INTEGRATION: 'claude_code' },
        })
      } catch (error) { throw new DeltaCommandError('process_failed', `append did not finish (${String(error)})`) }
      if (result.isStdoutTruncated || result.isStderrTruncated)
        throw new DeltaCommandError('command_failed', 'append output was truncated, so no acknowledgment is assumed')
      const { count, fenced } = acknowledgedPrefix(result.stdout, binding.thread,
        batch.map((entry, index) => ({ sequence: entry.sequence, turnSequence: turnSequences[index] })))
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
      if (result.exitCode !== 0 || count !== batch.length)
        throw result.exitCode !== 0 ? appendFailure(result.stdout, result.stderr, result.exitCode)
          : new DeltaCommandError('invalid_acknowledgment', 'the append acknowledgment did not match the records sent')
    }
    return false
}

async function beginExecution($: Runtime, session: string, turnId: string) {
  await serial(async () => {
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
    let binding = await load($, session)
    // A delayed completion must not close this new turn. Finish only the stored
    // predecessor, then persist the new start and local identity in one manifest.
    if (binding.execution && !binding.execution.endSequence) {
      binding = await stageRecord($, binding, {
        turnSequence: binding.execution.sequence, update: { sessionUpdate: 'state_update', state: 'idle' },
      })
    }
    const sequence = binding.next
    binding = await stageRecord($, binding, {
      turnSequence: sequence, update: {
        sessionUpdate: 'state_update', state: 'running',
        ...producerVersion || executionLocation ? { _meta: { delta: {
          ...producerVersion ? { producer_version: producerVersion } : {},
          ...executionLocation ? { execution_location: executionLocation } : {},
        } } } : {},
      },
    })
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
 * Record the session's title for its thread when it changed since the last one recorded. Only a
 * shared session names its thread; a joined session takes part in someone else's. A CLI whose
 * contract predates titles would refuse the record and pause sharing, so it is never sent one.
 * Nothing here can fail a turn or sharing: a title that cannot be read or staged is skipped, and
 * the next turn's end tries again.
 */
async function recordTitle($: Runtime, session: string, transcript: string) {
  const binding = stateFor(session).binding
  if (!binding?.snapshot || binding.joined || !binding.thread) return
  if ((contractVerified.get(session) ?? 0) < TITLE_CONTRACT_VERSION) return
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

async function share($: Runtime, request: ShareRequest): Promise<string> {
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
  await requireAuthentication(await authenticationHost($), await resolveCli($), check, async (text) => {
    await check()
    setProgress($, 'Waiting for Delta sign-in…', 'active')
    await $.ui.log(text, { to: 'transcript' })
  })
  await check()
  // Every recorded path is shown relative to the checkout this share attaches.
  const root = await checkoutRoot($)
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
          rememberToolResults(runtime, message)
          const updates = messageUpdates(message, `snapshot:${index}`, runtime.tools.structuredResults,
            { root, omitted: runtime.tools.omitted })
          for (const update of updates) state = await stageRecord($, state, { update })
        }
        // Commit the complete immutable plan and its pending receipts together. Until
        // this succeeds, neither a retry nor a CLI invocation can see a partial import.
        await save($, { ...state, snapshot: true })
      })
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
  if (!binding.thread) {
    const created = await command($, ['thread', 'create', '--source', 'claude-code', '--external-id', session], 'thread create', check)
    validateCreationReceipt(created)
    if (!created.created) {
      const status = await readThreadStatus($, created.thread_id, session)
      validateThreadFrontier(status, { session, thread: created.thread_id, next: binding.next, pending: binding.pending })
      // A durable identity always precedes append. A staged plan alone may have
      // been regenerated after losing the binding, so it cannot prove lineage.
      if (status.producer!.next_sequence !== 1)
        throw new Error('This Delta producer already contains records, but its local thread identity and receipts are missing. Restore the matching producer state or start a new Claude session; do not reset or reuse sequence numbers. The existing Delta conversation was preserved.')
    }
    // Persist identity before further fallible commands; creation is idempotent if this write fails.
    await serial(async () => save($, { ...await load($, session), thread: created.thread_id }))
    binding = await serial(() => load($, session))
  }
  await assertShareSession($, request)
  await stopConversation()
  await assertShareSession($, request)
  // Only now that the watcher is stopped is its pause true; the restarted watch lifts it once live.
  // A session that records offline does not wait for the watcher and takes no such pause.
  if (!recordsOffline(session, binding)) pauseCheckout(runtime, 'watcher')
  setProgress($, 'Attaching the checkout…', 'active', [3, 5])
  const attached = await command($, ['worktree', 'attach', root, '--thread', binding.thread!], 'worktree attach', check)
  validateAttachmentReceipt(attached, root)
  await serial(async () => {
    const current = await load($, session)
    if ((current.checkout && !samePath(current.checkout, root)) ||
        (current.checkoutReference !== undefined && current.checkoutReference !== attached.reference))
      throw new Error('Delta returned a different checkout reference or directory; the existing binding was preserved')
    await save($, { ...current, checkout: root, checkoutReference: attached.reference })
  })
  await assertShareSession($, request)
  setProgress($, 'Publishing the thread…', 'active', [4, 5])
  const shared = await command($, ['thread', 'share', binding.thread!, '--visibility', 'organization'], 'thread share', check,
    undefined, commandFormEnv(request.form))
  validatePublicationReceipt(shared, binding.thread)
  await serial(async () => save($, { ...await load($, session), url: shared.url }))
  await assertShareSession($, request)
  await startConversation($, session)
  await assertShareSession($, request)
  setProgress($, 'Syncing files…', 'active', [5, 5])
  await drain($, session)
  if (isPaused(runtime))
    throw new Error('checkout sharing is paused; saved messages remain queued until reattachment succeeds')
  if (runtime.captureFailure || runtime.unsaved.length)
    throw new Error('a live row could not be saved locally; fix the outbox error and retry /delta-share')
  await verifyCheckout($, await load($, session))
  await assertShareSession($, request)
  return shared.url
}

/**
 * Run a share on the clock so `/delta share` returns at once: the band reports progress, and once
 * the share succeeds it keeps the link on hand, so nothing is added to the transcript.
 */
async function runShare($: Runtime, request: ShareRequest) {
  const { session } = request
  try {
    const url = await share($, request)
    finishProgress($, 'Shared', 'done')
    await $.ui.log(`Delta share link: ${url}`, { to: 'debug' })
  } catch (error) {
    if (request.cancelled || sharing !== request) return
    const text = `Delta sharing failed: ${String(error)}. Fix the issue and retry ${recoveryCommand(stateFor(session).binding)}; saved records retain their sequence.`
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
    await requireContract($, request.session)
    // `/clear` ends the old session and removes its cached contract before the fresh session mounts.
    request.contractVersion = contractVerified.get(request.session) ?? PLUGIN_CONTRACT_VERSION
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
    const text = `Delta join failed: ${String(error)}. ${invalidLocator
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
  // This session runs against the same CLI build `join` already verified for this process.
  contractVerified.set(session, request.contractVersion ?? PLUGIN_CONTRACT_VERSION)
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
  const join = !!options.reportJoin &&
    (contractVerified.get(binding.session) ?? PLUGIN_CONTRACT_VERSION) >= JOIN_INTENT_CONTRACT_VERSION
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
    await requireContract($, session)
    request.contractVersion = contractVerified.get(session) ?? PLUGIN_CONTRACT_VERSION
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
  organizationDirectory ??= listOrganizations($).then(() => undefined, () => undefined)
  return organizationDirectory
}

/** The name of an organization, or of the current one when the caller names none. */
function organizationName(id: string | undefined): string | undefined {
  return organizationNames.get(id ?? currentOrganizationId ?? '')
}

/** The host bindings the setup wizard and onboarding run against. */
function setupEnv($: Runtime): SetupEnv {
  return {
    checkoutRoot: () => checkoutRoot($),
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
    contract: () => readThreadContract($),
    organizations: () => listOrganizations($),
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

/** The interactive surface the wizard speaks through: `$.ui.ask`, when this Claude build has it. */
function claudeInteraction($: Runtime): Interaction {
  return {
    async ask(question, options) {
      let answer: unknown
      try { answer = await $.ui.ask(question, options as never) }
      catch (error) {
        // A missing method is a build without the question API; a dismissed dialog rejects too.
        if (error instanceof TypeError) throw new InteractionUnavailable(String(error))
        throw new InteractionDismissed(String(error))
      }
      if (answer === undefined || answer === null || answer === '') throw new InteractionDismissed('dismissed')
      if (typeof answer === 'string') return answer
      const wrapped = answer as { label?: string; value?: string }
      return wrapped.label ?? wrapped.value ?? ''
    },
    log: async (text, to) => { await $.ui.log(text, to ? { to } : undefined) },
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
    if (newSession && recordsAutomatically(policy))
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
      // Refuse a CLI that cannot record offline before persisting anything, so an incompatible build
      // leaves the session manual rather than holding a half-initialized automatic binding.
      await requireContract($, session)
      if (!ownsActivation()) return
      const version = contractVerified.get(session) ?? PLUGIN_CONTRACT_VERSION
      if (version < OFFLINE_CONTRACT_VERSION) {
        // Auto mode cannot record without a CLI that speaks the offline contract; say so once.
        await notifyOnce($, 'Update Delta to sync sessions automatically; this version is too old. Until then, only sessions you share with /delta-share sync.')
        return
      }
      const refusal = await misconfiguration
      if (!ownsActivation()) return
      if (refusal) {
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
    await $.store.delete(key(id))
    await $.store.delete(ledgerKey(id))
  }
}

/** Begin the same publication flow `/delta share` runs, for the band's share control. */
function beginShare($: Runtime, session: string): boolean {
  if (sharing || stateFor(session).currentTurnId) return false
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

/** Run one `/delta` action, such as `share` or `join <link>`, from `/delta` or its menu command. */
async function runDeltaCommand($: Runtime, action: string, form: CommandForm): Promise<{ text?: string }> {
  // The setup wizard only writes the checkout's policy; it needs no session binding or activation.
  if (action === 'setup') return { text: await setupCommand($) }
  const locator = /^join\s+(\S+)$/.exec(action)?.[1]
  const organization = /^org\s+(?:(list|current)|(switch)\s+(\S+))$/.exec(action)
  const invite = /^org\s+invite\b\s*(.*)$/.exec(action)?.[1]
  if (action !== 'share' && !locator && !organization && invite === undefined)
    return { text: 'Usage: /delta share | /delta join <shared-link-or-thread> | /delta setup | /delta org list | /delta org current | /delta org switch <ID> | /delta org invite <email>…' }
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
  let shareRequest: ShareRequest | undefined
  try {
    if (session !== active || !stateFor(session).binding) await activate($, session)
    if (locator) {
      if (!hasInteractiveSurface(await $.session.surfaces()))
        return { text: '/delta-join requires an interactive Claude Code terminal or Desktop Code tab. Print mode and SDK sessions have no interactive surface for the session transition.' }
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
    const request = { session, cwd: await $.session.cwd(), form }
    sharing = shareRequest = request
    setProgress($, 'Preparing to share…', 'active', [1, 5])
    if (hasInteractiveSurface(await $.session.surfaces())) {
      $.clock.after(0, () => runShare($, request))
      return {}
    }
    // Cloud and other headless hosts cannot show the band or be relied on to forward
    // background UI notices. Keep the command open so its caller receives the outcome.
    const url = await share($, request)
    finishProgress($, 'Shared', 'done')
    if (sharing === request) sharing = undefined
    return { text: `Delta share link: ${url}` }
  }
  catch (error) {
    if (error instanceof PendingAuthenticationError) {
      if (sharing === shareRequest) sharing = undefined
      return { text: error.message }
    }
    const text = `Delta sharing failed: ${String(error)}. Fix the issue and retry ${locator ? `/delta-join ${locator}` : recoveryCommand(stateFor(session).binding)}; saved records retain their sequence.`
    if (!shareRequest || sharing === shareRequest) {
      if (sharing === shareRequest) sharing = undefined
      setProgress($, text, 'error')
    }
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

  on('turn.start', async ($, e, next) => {
    // Claude 2.1.299+ raises turn.start inside a child agent's or teammate's own loop, with
    // `agentId` set. That loop is not the shared conversation: only the main loop's turns may
    // bind `currentTurnId` or open an execution.
    if (e.agentId !== undefined) return next(e)
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
    if (e.agentId !== undefined) return next(e)
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
      const stopReason = e.isAborted || e.reason === 'aborted' ? 'cancelled'
        : e.reason === 'answer' ? 'end_turn'
        : e.reason === 'refusal' ? 'refusal'
        : e.reason === 'error' ? 'error' : undefined
      try { await endExecution($, session, sequence, () => true, 'bounded', stopReason) }
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
    // resume only switches sessions, so neither releases them.
    if (releasesMounts(e.reason)) await releaseMounts($, e.sessionId)
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
    await $.command.register({ name: 'delta', description: 'Share or join a Delta session, set up syncing, or choose an organization', argumentHint: 'share | join <shared-link-or-thread> | setup | org list | org current | org switch <ID>' })
    // Plugin commands cannot declare subcommands, so each `/delta` action is also its own command and
    // appears in the slash-command menu.
    await $.command.register({ name: 'delta-share', description: 'Delta: sync this session and its code to DeltaDB, and share it with your organization' })
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
    // The turn's end never waits for the title, and nothing about the title can fail it.
    if (typeof e.transcript_path === 'string' && e.transcript_path)
      void $.session.id().then((session) => recordTitle($, session, e.transcript_path)).catch(() => {})
    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    sessionSources.set(e.session_id, typeof e.source === 'string' ? e.source : '')
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
    if (e.agentId !== undefined) return next(e)
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
          rememberToolResults(runtime, message)
          const updates = messageUpdates(message, stored.uuid, runtime.tools.structuredResults,
            { root: boundDirectory(runtime.binding), omitted: runtime.tools.omitted })
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

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
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
      const updates = row
        ? messageUpdates({ role: 'user', content: [row] }, `tool-result:${e.tool_use_id}`, runtime.tools.structuredResults)
        // Keep structured output visible in Delta without closing before the model's result text arrives.
        // The call's input row may not be stored yet, so this record names the call itself; the event
        // carries the tool's arguments beside its reserved keys.
        : [{ ...update, status: 'in_progress', name: e.tool,
          ...toolInfo(e.tool, e, root) }]
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
