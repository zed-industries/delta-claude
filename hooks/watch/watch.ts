/**
 * Watching the recorded thread with `delta thread watch`: the connection, other participants' turns
 * and presence, and following the thread's upload. Their rows reach Claude's transcript through rows.tsx.
 */
import type { Timer } from 'claude-code'
import {
  clearDoneNotice, finishProgress, reportedProgress, stopBandTimers, syncSpinner
} from '../band/band'
import { reconnectDelay } from '../cli/command-outcomes'
import { conversationText, itemDisplay, type Ledger, RemoteView } from './conversation'
import { drain, loseExecution, observeTurn, recordsOffline } from '../recording/delivery'
import { threadStatus, threadWatch, watchEvents } from '../cli/delta-cli'
import { refreshMounts } from '../sharing/join'
import { PresenceTracker } from './presence'
import { announceThought } from './row-delivery'
import {
  activation, type Binding, boundDirectory, ledgerKey, load, pauseCheckout, producerOf, recoveryAdvice, report,
  requests, resumeCheckout, type Runtime, save, serial, sessions, stateFor,
} from '../core/session-state'
import { personKey, statusCurrentTurn, type StatusState, threadTurnOwned, type TurnStatus } from '../band/status'
import { recordsChildren } from '../subagents/subagents'
import {
  DeltaCommandError, permanentFailureAdvice, type ThreadReady, type ThreadStatus, type ThreadTurn,
  validateJoinedMounts, validateThreadCheckout, validateThreadFrontier, type WatchChild, type WatchEvent,
} from '../cli/thread-commands'
import { errorText } from '../core/text'
import { observeThreads } from '../subagents/thread-runs'
import { settleRemote, showToPerson, stopRows } from './rows'

type ReadyGate = { promise: Promise<ThreadReady>; resolve: (ready: ThreadReady) => void; reject: (error: unknown) => void }
/**
 * Another participant's running turn, as the band reports it: `since` is when the watch first
 * reported it and `heard` when the thread last changed during it.
 */
export type RemoteTurn = { turnId: string | null; name: string; id?: string; since?: number; heard?: number }
const MAX_RECONNECT_DELAY = 30_000
/** How long a lost connection may take to come back before the band says it is reconnecting. */
const RECONNECT_GRACE_MS = 4_000

type StopProcess = () => Promise<unknown>
/**
 * A drop the band is reporting. Within `grace` after a live watch dropped, the band still looks live;
 * once the grace has run out, or for a watch that was never live, it says the watch is reconnecting.
 */
type Outage = { grace?: Timer }
/**
 * Where the watch connection is. Each phase has only the fields it needs: a live watch always has its
 * process and readiness, only a retrying one has an interruption, only a failed one an error. Read it
 * again after every `await`; a phase narrowed before one may be stale after it.
 */
type Connection =
  | { phase: 'stopped' }
  /** Stopped on a failure; its session stays so the band can say so. No `error` when startup failed before launch. */
  | { phase: 'failed'; session: string; error?: string }
  /** An attempt is starting, spawning or reading its snapshot; `outage` is a drop it recovers from. */
  | {
    phase: 'connecting'; session: string; cancel: AbortController; gate: ReadyGate
    outage?: Outage; stopProcess?: StopProcess; ready?: ThreadReady
  }
  | { phase: 'live'; session: string; cancel: AbortController; gate: ReadyGate; ready: ThreadReady; stopProcess: StopProcess }
  /**
   * The attempt's process ended; it is torn down before the watch retries or stops. Whoever waited on
   * its readiness got `ready` if it had gone live, else `failure`, and a caller arriving meanwhile gets
   * the same.
   */
  | {
    phase: 'dropped'; session: string; cancel: AbortController; outage?: Outage
    ready?: ThreadReady; failure: unknown
  }
  /** Backing off between attempts; `interruption` says why, for a prompt refused meanwhile. */
  | { phase: 'retrying'; session: string; cancel: AbortController; interruption: string; outage: Outage }
export const presence = new PresenceTracker()
export const feed: {
  revision: number
  connection: Connection
  view?: RemoteView
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
} = {
  revision: 0, connection: { phase: 'stopped' }, turn: { state: 'idle' }, children: [], openSince: new Map(),
}

/** The session whose thread is being watched, if any. */
export function watchedSession(): string | undefined {
  const connection = feed.connection
  return connection.phase === 'stopped' ? undefined : connection.session
}

/** Whether `session`'s watch is live. */
export function liveFor(session: string): boolean {
  return feed.connection.phase === 'live' && feed.connection.session === session
}

/** Whether the watch is backing off between attempts. */
export function isRetrying(): boolean {
  return feed.connection.phase === 'retrying'
}

/** Whether `ready` is still the current watch's readiness, so the watch it came from has not been replaced. */
export function isCurrentReady(ready: ThreadReady): boolean {
  const connection = feed.connection
  return (connection.phase === 'connecting' || connection.phase === 'live') && connection.ready === ready
}

/**
 * The watch as the band reports it. Within a drop's grace the band carries on as if live; past it, or
 * for a watch that was never live, it says reconnecting. `actual` is the real phase's connection, for
 * what must not pretend: the spinner, and whether the children list is current.
 */
export function watchStatus(): {
  connection: StatusState['connection']; actual: StatusState['connection']; reconnecting: boolean; error?: string
} {
  const connection = feed.connection
  switch (connection.phase) {
    case 'stopped': return { connection: 'stopped', actual: 'stopped', reconnecting: false }
    case 'failed':
      return { connection: 'stopped', actual: 'stopped', reconnecting: false, ...connection.error ? { error: connection.error } : {} }
    case 'live': return { connection: 'live', actual: 'live', reconnecting: false }
    case 'connecting':
    case 'dropped':
    case 'retrying': {
      const actual = connection.phase === 'retrying' ? 'retrying' : 'connecting'
      const outage = connection.outage
      return { connection: outage?.grace ? 'live' : actual, actual, reconnecting: !!outage && !outage.grace }
    }
    default: {
      const unreachable: never = connection
      return unreachable
    }
  }
}

/** The drop a connection is recovering from, if any. */
function outageOf(connection: Connection): Outage | undefined {
  return connection.phase === 'connecting' || connection.phase === 'dropped' || connection.phase === 'retrying'
    ? connection.outage : undefined
}

/** Move the watch to `next`, ending a drop's grace that `next` does not carry on, and redraw the band. */
function enter($: Runtime, next: Connection) {
  const outage = outageOf(feed.connection)
  if (outage && outage !== outageOf(next)) outage.grace?.cancel()
  feed.connection = next
  syncSpinner($)
  $.ui.invalidate('ui.render')
}

/** A new attempt begins, its readiness waiting on `gate`, still recovering from whatever drop it carries. */
function attemptStarted($: Runtime, gate: ReadyGate) {
  const current = feed.connection
  if (current.phase !== 'connecting' && current.phase !== 'retrying')
    throw new Error(`A Delta watch attempt started while ${current.phase}`)
  enter($, { phase: 'connecting', session: current.session, cancel: current.cancel, gate, outage: current.outage })
}

/** The attempt's process is running; stopping the watch stops it. */
function spawned(stopProcess: StopProcess) {
  if (feed.connection.phase === 'connecting') feed.connection.stopProcess = stopProcess
}

/** The thread answered `ready`; the attempt goes live once its snapshot and inspection are done. */
function becameReady(ready: ThreadReady) {
  if (feed.connection.phase === 'connecting') feed.connection.ready = ready
}

/** The snapshot is complete and inspection passed: the watch is live, and any drop is over. */
function goLive($: Runtime) {
  const current = feed.connection
  if (current.phase === 'live') return
  if (current.phase !== 'connecting' || !current.ready || !current.stopProcess)
    throw new Error('The Delta watch went live before it was ready')
  enter($, {
    phase: 'live', session: current.session, cancel: current.cancel, gate: current.gate,
    ready: current.ready, stopProcess: current.stopProcess,
  })
}

/**
 * The attempt's process ended with `failure`. A live watch's drop starts the band's grace; one still
 * connecting keeps its outage.
 */
function dropped($: Runtime, failure: unknown) {
  const current = feed.connection
  if (current.phase !== 'connecting' && current.phase !== 'live') return
  let outage = current.phase === 'connecting' ? current.outage : undefined
  if (current.phase === 'live') {
    const started: Outage = {}
    const grace = $.clock.after(RECONNECT_GRACE_MS, () => {
      if (started.grace !== grace) return
      started.grace = undefined
      $.ui.invalidate('ui.render')
    })
    started.grace = grace
    outage = started
  }
  enter($, {
    phase: 'dropped', session: current.session, cancel: current.cancel, outage, failure,
    ...current.phase === 'live' ? { ready: current.ready } : {},
  })
}

/** Back off before the next attempt. A watch that was never live has no grace: it is reconnecting at once. */
function retrying($: Runtime, interruption: string) {
  const current = feed.connection
  if (current.phase !== 'dropped') return
  enter($, {
    phase: 'retrying', session: current.session, cancel: current.cancel, interruption, outage: current.outage ?? {},
  })
}

/** Stop on a failure, keeping the session so the band can say what went wrong. */
function failWatch($: Runtime, error?: string) {
  const current = feed.connection
  if (current.phase === 'stopped' || current.phase === 'failed') return
  enter($, { phase: 'failed', session: current.session, ...error ? { error } : {} })
}

/** The cancellation of the watch attempt running now, if any. */
function cancelOf(connection: Connection): AbortController | undefined {
  return 'cancel' in connection ? connection.cancel : undefined
}

function newReadyGate(): ReadyGate {
  let resolve!: ReadyGate['resolve']
  let reject!: ReadyGate['reject']
  const promise = new Promise<ThreadReady>((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

/** Watch the session's thread, or wait on the watch already starting for it; resolves once it is ready. */
export async function startConversation($: Runtime, session: string): Promise<ThreadReady> {
  if (!boundDirectory(stateFor(session).binding))
    throw new Error('Thread setup is incomplete; run /delta-share to finish explicit creation, attachment, and publication')
  const watching = feed.connection
  if (watching.phase !== 'stopped' && watching.phase !== 'failed' && watching.session === session) {
    if (watching.phase === 'retrying') throw new Error(watching.interruption)
    if (watching.phase === 'dropped') {
      if (watching.ready) return watching.ready
      throw watching.failure
    }
    return watching.gate.promise
  }
  const stopping = stopConversation()
  const revision = feed.revision
  const cancel = new AbortController()
  const ownsStartup = () => feed.revision === revision && cancelOf(feed.connection) === cancel && !cancel.signal.aborted
  // The check above returns a directory only for a binding with a thread.
  const thread = stateFor(session).binding!.thread!
  const readiness = newReadyGate()
  enter($, { phase: 'connecting', session, cancel, gate: readiness })
  let launched = false
  try {
    await stopping
    if (!ownsStartup()) throw new Error('Thread watcher startup was cancelled')
    // This plugin alone writes the ledger; its thread and items are checked before it is used.
    const saved = await $.store.get(ledgerKey(session)) as Ledger | undefined
    if (!ownsStartup()) throw new Error('Thread watcher startup was cancelled')
    feed.view = new RemoteView(thread, saved?.thread === thread && saved.items !== null && typeof saved.items === 'object'
      ? saved : { thread, items: {} })
    launched = true
    void consumeConversation($, session, revision, cancel.signal, readiness).catch((error) => {
      if (!ownsStartup()) return
      const current = feed.connection
      if ('gate' in current) current.gate.reject(error)
      const binding = stateFor(session).binding!
      failWatch($, `Delta watcher failed: ${errorText(error)}. ${recoveryAdvice(binding)} to reconnect.`)
    })
    return await readiness.promise
  } catch (error) {
    if (ownsStartup() && !launched) {
      cancel.abort()
      failWatch($)
    }
    readiness.reject(error)
    throw error
  }
}

export async function stopConversation() {
  feed.revision++
  const previous = feed.connection
  feed.connection = { phase: 'stopped' }
  cancelOf(previous)?.abort()
  outageOf(previous)?.grace?.cancel()
  stopBandTimers()
  if ('gate' in previous) previous.gate.reject(new Error('Thread watcher stopped'))
  const stop = previous.phase === 'connecting' || previous.phase === 'live' ? previous.stopProcess : undefined
  feed.view = undefined
  feed.turn = { state: 'idle' }
  presence.reset()
  feed.threadTurn = undefined
  feed.producerTurn = undefined
  feed.ownTurnId = undefined
  feed.remoteTurn = undefined
  feed.children = []
  feed.openSince.clear()
  // A stopped pass still saves the rows it added; finish that save before a new watch loads or writes the ledger.
  const settling = stopRows()
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
      goLive($)
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
        const status = await threadStatus($, watched?.locator ?? baseline.thread_id,
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
      attemptStarted($, readiness)
      const binding = await serial(() => load($, session))
      if (!ownsObserver()) return
      const watched = binding.locator ?? binding.thread
      if (!boundDirectory(binding) || !watched)
        throw new Error('No attached thread selected; run /delta-share from the intended Git checkout')
      // Delta shows the signed-in person in the thread as taking part through Claude Code while this
      // watch runs; the stop below and each reconnect end and renew it.
      stream = await threadWatch($, watched, {
        externalId: producerOf(binding), participate: true, proceed: ownsObserver,
      })
      if (!stream) return
      const running = stream
      spawned(() => running.return({ code: null, signal: 'SIGTERM' }))
      const events = watchEvents(stream, (text) => { stderr = (stderr + text).slice(-4000) })
      while (true) {
        if (inspectionFailed) throw inspectionError
        // Only the currently pending next() listens for inspection failure. A single
        // never-settled failure promise would retain a listener per watch line.
        const inspectionFailure = new Promise<never>((_, reject) => { rejectInspection = reject })
        const piece = await Promise.race([events.next(), inspectionFailure])
        rejectInspection = undefined
        if (!ownsObserver()) return
        if (piece.done)
          throw new Error(`Delta watcher stopped (${piece.value.code ?? piece.value.signal ?? 'unknown'}). ${stderr}`)
        const event = piece.value
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
          becameReady(event)
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
    } catch (error) {
      failure = error
    } finally {
      connected = false
      rejectInspection = undefined
      inspection.abort()
      signal.removeEventListener('abort', cancelInspection)
      try { if (stream) await stream.return({ code: null, signal: 'SIGTERM' }) }
      catch (error) { failure ??= error }
    }
    if (!ownsObserver()) return
    readiness.reject(failure)
    dropped($, failure)
    // A session that records offline keeps working when the watcher drops: its records stay queued
    // and drain retries, so nothing pauses and no running turn is lost.
    if (!recordsOffline(session, stateFor(session).binding)) {
      pauseCheckout(stateFor(session), 'watcher')
      const running = stateFor(session).binding?.execution
      if (running) await loseExecution($, session, running.sequence, 'The Delta watcher disconnected', ownsObserver)
      if (!ownsObserver()) return
    }
    if (failure instanceof DeltaCommandError && failure.hints.retryable === false) {
      // A retryable failure is a lost connection, but a non-retryable one needs a person:
      // reconnecting cannot bring back a deleted thread or restored access on its own.
      const notice = `Delta sharing paused: ${failure.message}. ${permanentFailureAdvice(failure.code, !!stateFor(session).binding?.autoUpload, failure.reason)}, then ${recoveryAdvice(stateFor(session).binding)}.`
      pauseCheckout(stateFor(session), 'delivery', notice)
      failWatch($, notice)
      await $.ui.log(notice, { to: 'transcript' })
      return
    }
    readiness = newReadyGate()
    // A child that emits one event then exits is not a healthy connection.
    const ended = await $.clock.now()
    if (!ownsObserver()) return
    if (ended - started >= MAX_RECONNECT_DELAY) attempts = 0
    const delay = reconnectDelay(attempts)
    attempts++
    // The transcript says why once; the band waits out a brief drop before showing it.
    const interruption = `Connection interrupted: ${errorText(failure)} Retrying in ${delay / 1000}s.`
    retrying($, interruption)
    if (attempts === 1) await $.ui.log(interruption, { to: 'transcript' })
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
    const name = conversationText(turn.user?.name ?? '').trim()
    const started: RemoteTurn = { turnId: turn.turn_id, name, ...turn.user ? { id: personKey(turn.user) } : {} }
    feed.remoteTurn = started
    // A new turn counts its time, and its quiet, from when it is first reported.
    void $.clock.now().then((now) => { started.since ??= now })
  } else if (remote && feed.remoteTurn) {
    feed.remoteTurn.turnId ??= turn.turn_id
    // Delta reports a turn before it knows who requested it, then again once it does.
    const name = conversationText(turn.user?.name ?? '').trim()
    if (name) feed.remoteTurn.name = name
    if (name || turn.user?.user_id) feed.remoteTurn.id = personKey(turn.user)
  }
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

/**
 * The thread facts a status read carries into the binding: its link, its audience, and Delta's
 * background upload. A URL alone says nothing about who can see the thread, so they stay separate.
 */
export function statusFields(status: ThreadStatus): Pick<Binding, 'url' | 'visibility' | 'upload' | 'uploaded'> {
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
export async function rememberStatus($: Runtime, session: string, status: ThreadStatus) {
  if (activation.session !== session) return
  let published = false
  await serial(async () => {
    const current = await load($, session)
    if (activation.session !== session || !current.thread) return
    const next = { ...current, ...statusFields(status) }
    published = !!current.autoUpload && !current.uploaded && !!next.uploaded
    await save($, next)
  })
  // The first upload ends the way a share does, unless a share or join is drawing its own steps.
  if (published && watchedSession() === session && !reportedProgress() && !requests.share && !requests.join)
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
export function followUpload($: Runtime, session: string) {
  const state = sessions.get(session)
  if (!state || activation.session !== session) return
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
    if (activation.session !== session || !binding?.thread) return
    void threadStatus($, binding.locator ?? binding.thread, producerOf(binding))
      .then((status) => rememberStatus($, session, status))
      // An unanswered read says nothing about the upload; ask again after the next delay.
      .catch(() => followUpload($, session))
  })
}

/** Stop watching if the watch is this session's. */
export async function stopWatching(session: string) {
  if (watchedSession() === session) await stopConversation()
}
