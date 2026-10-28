/**
 * Each Claude session's state in this process and its binding in the store: which session is recorded
 * now, the join and share in flight, checkout pauses, and loading and saving bindings one at a time.
 */
import type { EventName, HookFor, MatchedHook, Timer } from 'claude-code'
import type { SyncReminder } from '../band/band'
import { type Execution, restoreBinding } from './binding'
import type { Entry } from '../subagents/children'
import type { Update } from '../recording/content'
import type { CleanupPlan } from '../recording/delivery'
import type { Handoff } from '../sharing/handoff'
import type { JoinPlan, JoinRequest } from '../sharing/join'
import { DrawnRows } from '../watch/row-delivery'
import type { ShareRequest } from '../sharing/share'
import type { ShareAudience } from '../sharing/share-audience'
import { errorText } from './text'
import { DeltaSendError, type ThreadMount, type ThreadUpload } from '../cli/thread-commands'
import { ToolRecords } from '../recording/tool-records'
import type { Host } from './host'

/** The hook registered for event `E` with matcher `M`, for a handler body that lives in a feature module. */
type HookOf<E extends EventName, M> = [M] extends [undefined] ? HookFor<E> : MatchedHook<E, M>
/** The event a hook on `E`, registered with matcher `M`, receives. */
export type HookEvent<E extends EventName, M = undefined> = Parameters<HookOf<E, M>>[1]
/** The `next` a hook on `E`, registered with matcher `M`, receives. */
export type HookNext<E extends EventName, M = undefined> = Parameters<HookOf<E, M>>[2]
/** The upload a repository's policy asks an automatic session for. */
export type AutoUpload = { mode: 'private' | 'organization'; organization: string }
export type Binding = {
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
   * The checkout this session worked in until it and the thread both changed while the session was
   * closed. Delta left it untouched and moved the session to a checkout of the thread's own.
   */
  movedFrom?: string
  /** Local identity saved before membership, so a lost attach receipt cannot create another worktree. */
  pendingWorktree?: { directory: string; reference: string }
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
export function producerOf(binding: { session: string; producer?: string }): string {
  return binding.producer ?? binding.session
}

const encoder = new TextEncoder()
/**
 * The session this process records: `session` is the one activation last made current, `epoch`
 * counts activations and session ends so work begun under an earlier one can tell it is stale, and
 * `activating` names the session an activation is underway for.
 */
export const activation = { session: '', epoch: 0, activating: '' }

/**
 * A check that `session` is still the recorded session, under the activation current when the check
 * was made: it turns false once the session ends, another is recorded, or this one is activated again.
 */
export function stillActive(session: string): () => boolean {
  const epoch = activation.epoch
  return () => activation.session === session && activation.epoch === epoch
}
let queue: Promise<unknown> = Promise.resolve()
/**
 * The join and the share running now, and a share asked for while its session's turn ran, with whom;
 * that one starts when the turn ends.
 */
export const requests: { join?: JoinRequest; share?: ShareRequest; shareAfterTurn?: { session: string; audience?: ShareAudience } } = {}
/**
 * `watcher`: observation is not live; the next live watch connection lifts it.
 * `verification`: a checkout check failed; a passing check lifts it.
 * `delivery`: Delta refused a record or the thread; only explicit share/join recovery lifts it.
 */
type CheckoutPause = 'watcher' | 'verification' | 'delivery'
/** One row waiting for its turn's start record, with the tool identity it later attributes. */
export type HeldRow = { update: Update; toolId?: string; turnId?: string }
export type SessionState = {
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
  /**
   * Mounts are being restored for a resumed session; prompts wait. Separate from `mounted`, not a phase
   * of it: a restore mounts first and keeps prompts waiting until the watch has started.
   */
  restoring?: true
  /** A saved checkout's mount is being restored while prompts proceed and record locally. */
  restoringCheckout?: true
  /** Where Claude has to move between turns, because its worktree is no longer the thread's one directory. */
  moveTo?: string
  /**
   * A move is running. It outlasts `moveTo`, which a move clears before telling Claude where it went,
   * so a target that arrives meanwhile waits for the next turn's end rather than starting a second move.
   */
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
export const sessions = new Map<string, SessionState>()

export function stateFor(session: string): SessionState {
  let state = sessions.get(session)
  if (!state) {
    state = {
      notes: [], unsaved: [], pauses: new Map(), retryAttempts: 0, tools: new ToolRecords(), nativeTurns: new Map(),
      aborting: new Set(), lostTurns: new Set(), drawn: new DrawnRows(),
    }
    sessions.set(session, state)
  }
  return state
}

/** `notice` tells the person what to do, and is shown when a prompt is refused because of this pause. */
export function pauseCheckout(state: SessionState, reason: CheckoutPause, notice?: string) {
  state.pauses.set(reason, notice)
}

export function resumeCheckout(state: SessionState, reason: CheckoutPause) {
  state.pauses.delete(reason)
}

export function isPaused(state: SessionState) {
  return state.pauses.size > 0
}

export function pauseNotice(state: SessionState) {
  return [...state.pauses.values()].find((notice) => notice !== undefined)
    ?? `checkout sharing is paused; ${recoveryAdvice(state.binding)}`
}

export function serial<T>(task: () => Promise<T>): Promise<T> {
  const running = queue.then(task, task)
  queue = running.catch(() => {})
  return running
}

export function key(session: string) { return `session:${session}` }
export function ledgerKey(session: string) { return `appended:${session}` }
export function drawnRowKey(session: string, row: string) { return `drawn:${session}:${row}` }

export function recoveryCommand(binding?: Binding) {
  const locator = binding?.joinTransition?.locator ?? (binding?.joined ? binding.locator ?? binding.thread : undefined)
  return locator ? `/delta-join ${locator}` : '/delta-share'
}

/**
 * What to tell a person to do next when Delta is not ready. A session this plugin created itself
 * recovers on its own, so its advice never names `/delta share`, which stays the explicit publish
 * action for a manual session.
 */
export function recoveryAdvice(binding?: Binding): string {
  return binding?.autoUpload ? 'automatic recording retries on your next prompt' : `run ${recoveryCommand(binding)}`
}

/** The transcript path Claude last reported for each session in this process. */
const transcriptPaths = new Map<string, string>()

/** The transcript path Claude last reported for a session in this process. */
export function transcriptPathOf(session: string): string | undefined {
  return transcriptPaths.get(session)
}

/** Remember the transcript path Claude reported for a session, which its next save stores; whether it changed. */
export function rememberTranscriptPath(session: string, transcript: string): boolean {
  if (transcriptPaths.get(session) === transcript) return false
  transcriptPaths.set(session, transcript)
  return true
}

/** An ended session's transcript path is forgotten; a later save keeps the path it stored. */
export function forgetTranscriptPath(session: string) {
  transcriptPaths.delete(session)
}

export async function save(host: Host, value: Binding, isCurrent = () => true) {
  // A recording session keeps its transcript's latest path, so a continuation can find the record
  // Claude Code appends there.
  const transcript = transcriptPathOf(value.session)
  if (transcript && value.thread && value.transcript !== transcript) value = { ...value, transcript }
  await host.store.set(key(value.session), value)
  // A session already ended and pruned must not be recreated by a late write.
  const state = sessions.get(value.session)
  if (state && isCurrent()) state.binding = value
}

/**
 * The binding saved under `storeKey`, as this plugin wrote it. Only this plugin writes binding keys,
 * so the value is taken to have a binding's shape; `restoreBinding` checks the fields delivery needs.
 */
export async function storedBinding(host: Host, storeKey: string): Promise<Binding | undefined> {
  return await host.store.get(storeKey) as Binding | undefined
}

export async function load(host: Host, session: string): Promise<Binding> {
  const previous = await storedBinding(host, key(session))
  if (!previous || previous.session !== session) return { session, snapshot: false, next: 1, pending: [] }
  return restoreBinding(previous)
}

export async function digest(input: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(input))
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The directory a binding's records are checked against, or undefined while setup is incomplete. */
export function boundDirectory(binding?: Binding): string | undefined {
  if (!binding?.thread) return
  return binding.joined ? binding.directory : binding.checkout
}

export async function report(host: Host, error: unknown) {
  // A delivery failure was already shown, with its retry or pause, where it was classified.
  if (error instanceof DeltaSendError) return
  const text = `Delta sharing paused: ${errorText(error)}. ${recoveryAdvice(sessions.get(activation.session)?.binding)}.`
  await host.ui.status(text)
  await host.ui.log(text)
}

/**
 * A session that ended cancels the share it ran and a share it asked for after its turn, and the
 * join it ran, unless the end is that join's own `/clear` of the session it joins from.
 */
export function cancelRequestsOf(session: string, reason: string) {
  if (requests.share?.session === session) {
    requests.share.cancelled = true
    requests.share = undefined
  }
  if (requests.shareAfterTurn?.session === session) requests.shareAfterTurn = undefined
  if (requests.join && session === (requests.join.fresh ?? requests.join.session) &&
      !(requests.join.clearing && reason === 'clear' && session === requests.join.session)) {
    requests.join.cancelled = true
    requests.join = undefined
  }
}

/** A session that ended is no longer recorded here, and an activation underway for it is stale. */
export function endActivationOf(session: string) {
  if (activation.activating === session) {
    activation.epoch++
    activation.activating = ''
  }
  if (activation.session === session) activation.session = ''
}

/** Drop what an ended session held for its turns, mounts and timers; its binding and unsaved rows stay. */
export function resetRuntime(runtime: SessionState) {
  runtime.mounted = undefined
  runtime.restoring = undefined
  runtime.restoringCheckout = undefined
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
}

/** Forget an ended session's state, unless rows not yet saved or a running outbox cleanup still need it. */
export function forgetRuntime(session: string, runtime: SessionState) {
  if (!runtime.unsaved.length && !runtime.cleanupTask && sessions.get(session) === runtime)
    sessions.delete(session)
}

/**
 * Mark when a session stopped here, on every end, a clear or a switch included: only a marked binding
 * can be pruned, since an unmarked one may be live in another Claude process.
 */
export async function markEnded(host: Host, session: string) {
  try {
    const stored = await storedBinding(host, key(session))
    if (stored?.session === session && stored.endedAt === undefined)
      await host.store.set(key(session), { ...stored, endedAt: await host.clock.now() })
  } catch { /* a session that cannot record its end is simply never pruned */ }
}
