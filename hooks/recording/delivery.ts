/**
 * Recording a session into its thread: staging records in the outbox, delivering them in order with
 * retries, turn executions, checkout verification, capture failures, and refused offline changes.
 */
import type { ApiMessage } from 'claude-code'
import { activationIncomplete, captureDecided, noticeSession, outbox } from '../setup/activation'
import type { Entry } from '../subagents/children'
import { capturedMessage, isOmittedTool, messageUpdates, resultUpdate, toolInfo, type Update } from './content'
import { deliveryFailure, deliveryRetryDelay } from './delivery-policy'
import { requireContract, threadAppend, threadDiscard, threadFork, threadStatus, verifiedContract } from '../cli/delta-cli'
import { isAskingOwnQuestion, notifyOnce } from '../setup/interaction'
import { isJsonObject } from '../core/json'
import {
  acknowledgedOutboxFiles, acknowledgedPrefix, appendBatch, outboxChunks, outboxRemoval, pendingRecordTurn,
} from './outbox'
import { pathKey, samePath } from '../core/paths'
import {
  activation, type Binding, boundDirectory, digest, type HookEvent, type HookNext, isPaused, load, pauseCheckout,
  producerOf, recoveryAdvice, recoveryCommand, report, requests, resumeCheckout, type Runtime, save, serial, sessions,
  type SessionState, stateFor, stillActive,
} from '../core/session-state'
import { children, deliverChild, stopReasonOf } from '../subagents/subagents'
import {
  appendFailure, classifyCommandFailure, DeltaCommandError, DeltaSendError, JoinNotReadyError, permanentFailureAdvice,
  type ThreadTurn, validateJoinedMounts, validateThreadCheckout, validateThreadFrontier,
} from '../cli/thread-commands'
import { errorText } from '../core/text'
import type { ToolRecords } from './tool-records'
import { liveFor, rememberStatus } from '../watch/watch'
import { settleRemote, storeShownRow } from '../watch/rows'
import { scheduleMove } from '../sharing/join'
import { shownCommandRewrite } from '../watch/row-delivery'
import { beginAppend, beginShare, endAppend, waitForSnapshot } from '../sharing/share'

export type RecordBody = { update: Update; turnSequence?: number }
export type CleanupPlan = { session: string; root: string; next: number; pending: { sequence: number; files: string[] }[] }
const LIVE_ACTIVITY_ORIGIN = {
  work_origin: 'external_agent',
  interaction_surface: 'cli',
} as const
type LiveActivityKind = 'user_message' | 'agent_message' | 'agent_thought' | 'tool_call' | 'edit'
let drainTask: Promise<void> | undefined
/** A Keep or Discard the band started, so its two controls cannot both run at once. */
let resolving = false
/**
 * Whether this session records offline, with `append --acknowledge local` answering without the
 * server. An automatic or shared session does once its CLI is verified: it writes to its own thread,
 * and Delta's background uploader pushes what it acknowledged locally. A joined session writes into
 * someone else's thread, so it keeps server-confirmed delivery and holds Claude while Delta is
 * unreachable.
 */
export function recordsOffline(session: string, binding: Binding | undefined): boolean {
  return !!binding && !binding.joined && verifiedContract(session) !== undefined
}

export function rememberToolResults(tools: ToolRecords, message: ApiMessage) {
  for (const block of message.content) {
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string')
      tools.toolResults.set(block.tool_use_id, block)
    else if (block.type === 'tool_use' && typeof block.id === 'string' && isOmittedTool(block.name))
      tools.omitted.add(block.id)
  }
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
export function liveActivity(update: Update): Update {
  let activityKind: LiveActivityKind | undefined
  if (update.sessionUpdate === 'user_message' || update.sessionUpdate === 'agent_message' ||
      update.sessionUpdate === 'agent_thought') activityKind = update.sessionUpdate
  else if (update.sessionUpdate === 'tool_call_update') {
    const structuredEdit = Array.isArray(update.content) &&
      update.content.some((item) => isJsonObject(item) && item.type === 'diff')
    activityKind = structuredEdit ? 'edit' : 'tool_call'
  }
  if (!activityKind) return update
  const metadata = isJsonObject(update._meta) ? update._meta : {}
  const delta = isJsonObject(metadata.delta) ? metadata.delta : {}
  return {
    ...update,
    _meta: { ...metadata, delta: { ...delta, ...LIVE_ACTIVITY_ORIGIN, activity_kind: activityKind } },
  }
}

export async function stageRecord($: Runtime, binding: Binding, body: RecordBody): Promise<Binding> {
  // The continuing session stages under the same producer; a second writer would reuse its sequences.
  if (binding.continuedIn)
    throw new Error(`this conversation continues in Claude session ${binding.continuedIn}, which records it`)
  return stageOutboxRecord($, producerOf(binding), binding, body)
}

/** Stage one record in the outbox folder `folder`, which holds one recorded conversation's records. */
export async function stageOutboxRecord<T extends { next: number; pending: Entry[] }>(
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

export async function collectAcknowledgedOutbox($: Runtime, plan: CleanupPlan) {
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
export function scheduleOutboxCleanup($: Runtime, binding: Binding) {
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
  }).catch((error) => reportCleanupIssue($, binding.session, `Delta outbox cleanup failed: ${errorText(error)}`))
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
      // A redraw is best effort; the band reads the cleared error at its next draw anyway.
      try { if (hadError) $.ui.invalidate('ui.render') } catch {}
    } catch (error) {
      const message = `Delivered Delta records could not be removed from the local outbox: ${errorText(error)}. Delivery can continue; cleanup retries on later acknowledgments or session activation.`
      await reportCleanupIssue($, session, message)
      return
    }
  }
}

/**
 * Whether Claude works in `directory`: it is the session's project root and the shell is there or
 * below it. Claude's own `cd` in a Bash call moves the shell's directory within the project, so a
 * subdirectory is still the same checkout.
 */
export async function isInDirectory($: Runtime, directory: string) {
  const root = await $.session.root()
  if (!samePath(root, directory)) return false
  const current = await $.session.cwd()
  const cwd = pathKey(current, root, directory)
  directory = pathKey(directory, root)
  return cwd === directory || cwd.startsWith(directory.endsWith('/') ? directory : `${directory}/`)
}

/** A joined session runs only with Claude in its directory, so Claude's tools reach every mounted worktree. */
async function requireJoinedDirectory($: Runtime, binding: Binding) {
  if (await $.session.id() !== binding.session || !binding.directory || !await isInDirectory($, binding.directory))
    throw new JoinNotReadyError(`This joined session must run in ${binding.directory}. Run /cd ${binding.directory}, then ${recoveryCommand(binding)}; no other checkout will be attached`)
}

/** Status observes the common owner's mounts; watcher lifetime is not checkout ownership. */
export async function verifyCheckout($: Runtime, binding: Binding) {
  if (!boundDirectory(binding))
    throw new Error('the checkout has not been attached; saved messages remain queued')
  if (binding.joined) await requireJoinedDirectory($, binding)
  const status = await threadStatus($, binding.locator ?? binding.thread!, producerOf(binding))
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
    const delivering = () => activation.session === session && sessions.has(session) && !isPaused(sessions.get(session)!)
    while (delivering()) {
      const binding = await serial(async () => load($, session))
      // A conversation that continued in another session delivers from there.
      if (!binding.thread || !binding.pending.length || binding.continuedIn) return true
      // A recovered outbox checks the CLI's contract before its first append, so an incompatible CLI
      // records nothing. An answer that arrives after the session ended or was activated again belongs
      // to that earlier lifetime: it neither appends nor reports, and the current one checks for itself.
      const current = stillActive(session)
      try { await requireContract($, session) }
      catch (error) {
        if (!delivering() || !current()) return false
        throw error
      }
      if (!delivering() || !current()) return false
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
export async function appendPending(
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
  const result = await threadAppend($, target, collected.input)
  const { count, fenced } = acknowledgedPrefix(result.stdout, target.thread,
    batch.map((entry, index) => ({ sequence: entry.sequence, turnSequence: turnSequences[index] })))
  const failure = result.exitCode !== 0 ? appendFailure(result.stdout, result.stderr, result.exitCode)
    : count !== batch.length ? new DeltaCommandError('invalid_acknowledgment', 'the append acknowledgment did not match the records sent')
      : undefined
  return { count, fenced, failure }
}

/** A turn's scoped running record, naming this plugin's version and where Claude runs when known. */
export async function runningUpdate($: Runtime): Promise<Update> {
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

export async function loseExecution($: Runtime, session: string, sequence: number, reason: string, isCurrent = () => true) {
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

export async function observeTurn($: Runtime, session: string, turn: ThreadTurn, isCurrent = () => true) {
  const execution = stateFor(session).binding?.execution
  if (!isCurrent() || !execution || execution.sequence !== turn.sequence || execution.endSequence) return
  if (turn.status === 'superseded')
    await loseExecution($, session, turn.sequence, 'Shared execution was superseded', isCurrent)
}

export async function recoverExecution($: Runtime, session: string) {
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

export async function drain($: Runtime, session: string): Promise<void> {
  if (activation.session !== session || isPaused(stateFor(session))) return
  if (drainTask) {
    await drainTask
    if (activation.session !== session || isPaused(stateFor(session))) return
    if ((await serial(() => load($, session))).pending.length) return drain($, session)
    return
  }
  const task = drainPending($, session).then(async (delivered) => {
    const state = sessions.get(session)
    if (!delivered || activation.session !== session || !state) return
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
  if (!state || activation.session !== session) throw new DeltaSendError(error.message, false)
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

export function endDeliveryFailures(state: SessionState) {
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
  if (!state || activation.session !== session || state.retryTimer) return
  const delay = deliveryRetryDelay(state.retryAttempts++, retryAfterMs)
  // A timer rather than a sleep: the hook that hit the failure may finish long before the retry.
  state.retryTimer = $.clock.after(delay, () => {
    state.retryTimer = undefined
    if (activation.session === session) void drain($, session).catch((error) => report($, error))
  })
}

async function recordCaptureFailure($: Runtime, session: string, error: unknown) {
  const state = stateFor(session)
  state.captureFailure = errorText(error)
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

export async function flushUnsaved($: Runtime, session: string) {
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

/**
 * Begin the person's choice for a refused offline thread, from the band's controls. The command runs
 * off the hook, and its result clears the refusal so the queued records can drain.
 */
export function beginRefusalResolution($: Runtime, session: string, kind: 'fork' | 'discard'): boolean {
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
  if (!state || activation.session !== session) return
  const thread = (await serial(() => load($, session))).thread
  if (!thread) return
  // Fork first: it copies the refused changes into a kept thread, and the discard then resets the original.
  const forked = kind === 'fork' ? await threadFork($, thread) : undefined
  await threadDiscard($, thread)
  endDeliveryFailures(state)
  resumeCheckout(state, 'delivery')
  $.ui.invalidate('ui.render')
  if (forked)
    await notifyOnce($, `Delta kept this thread's offline changes in the new thread "${forked.thread_id}"; this thread carries on without them.`)
  await $.ui.log(kind === 'fork' ? "Delta forked this thread's offline changes into a kept thread." : "Delta discarded this thread's offline changes.", { to: 'debug' })
  void drain($, session).catch((error) => report($, error))
}

/** Show why the person's Fork & Restore or Discard did not resolve the refusal; the controls stay available. */
async function reportRefusal($: Runtime, session: string, error: unknown) {
  const state = sessions.get(session)
  if (!state || activation.session !== session) return
  await $.ui.log(`Delta could not resolve this thread's offline changes: ${errorText(error)}. The records stay queued.`, { to: 'transcript' })
  // A redraw is best effort; the band shows the refusal again at its next draw.
  try { $.ui.invalidate('ui.render') } catch {}
}

/**
 * The main loop's turn started: bind it as the current turn and open its execution, or lose the
 * execution at once when observation or capture is unavailable.
 */
export async function startTurn($: Runtime, e: HookEvent<'turn.start'>, next: HookNext<'turn.start'>) {
  const session = await $.session.id()
  await noticeSession($, session)
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
      !liveFor(session)
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
}

/**
 * The main loop's turn ended: stage its finish, then release the remote rows held while it ran, move
 * Claude if it must, and start a share asked for during the turn.
 */
export async function completeTurn($: Runtime, e: HookEvent<'turn.complete'>, next: HookNext<'turn.complete'>) {
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
    if (requests.shareAfterTurn?.session === session) {
      const { audience } = requests.shareAfterTurn
      requests.shareAfterTurn = undefined
      beginShare($, session, audience)
    }
  }
  return result
}

/** A row the main conversation kept is recorded, or held for the turn it belongs to. */
export async function recordRow($: Runtime, e: HookEvent<'session.append'>, next: HookNext<'session.append'>) {
  // A session Claude starts after `/clear` has no start hook of its own: its first row, the command's, is the first
  // thing this plugin sees of it, and the rows after it wait on the capture boundary this opens.
  await noticeSession($)
  // The plugin's own `show` run is stored rewritten, so neither the model nor a resumed session's
  // copy of these rows names the internal command or its item id. Its output row names the item
  // until then, which is how the row is tied to what it draws.
  const shown = shownCommandRewrite($.plugin.name, e)
  if (shown !== undefined) {
    const stored = await next({ ...e, message: { ...e.message, content: shown.content } })
    if (!('deny' in stored)) await storeShownRow($, stored.uuid, shown)
    return stored
  }
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
  await beginAppend()
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
    endAppend()
  }
}

/** The main conversation's tool call: its result is recorded under the turn that made the call. */
export async function recordToolCall($: Runtime, e: HookEvent<'tool.call'>, next: HookNext<'tool.call'>) {
  if (isAskingOwnQuestion() && e.tool === 'AskUserQuestion') return next(e)
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
    await waitForSnapshot()
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
}
