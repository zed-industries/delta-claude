/**
 * Recording Claude's subagents, each into a child thread of its own: their bindings, turns, records,
 * checkouts and delivery.
 */
import type { ApiMessage, FsEntry, Timer } from 'claude-code'
import { outbox } from '../setup/activation'
import { restoreBinding } from '../core/binding'
import { type ChildBinding, childKey, childName, childOutbox, recordsSubagent, sentBy } from './children'
import {
  capturedMessage, isOmittedTool, messageUpdates, recordedToolResults, resultUpdate, toolInfo,
} from '../recording/content'
import { isJsonObject } from '../core/json'
import {
  appendPending, collectAcknowledgedOutbox, liveActivity, type RecordBody, recordsOffline, recordsPlans,
  rememberToolResults, runningUpdate, stageOutboxRecord,
} from '../recording/delivery'
import { deliveryRetryDelay } from '../recording/delivery-policy'
import {
  hasWorktreeMount, stopWorktreeMount, threadCreate, threadWatch, verifiedContract, watchEvents,
} from '../cli/delta-cli'
import { attachWorktree, awaitCheckoutReleased, mountCheckout } from '../sharing/checkout'
import { samePath } from '../core/paths'
import { deliverNote } from '../watch/rows'
import {
  boundDirectory, type HeldRow, type HookEvent, type HookNext, load, save, serial, stateFor,
} from '../core/session-state'
import type { Host } from '../core/host'
import { snapshotMessages } from '../recording/snapshot'
import { errorText } from '../core/text'
import { CHILD_CONTRACT_VERSION, classifyCommandFailure, DeltaCommandError } from '../cli/thread-commands'
import { capturesEdits, type EditCapture, startCapture } from '../recording/edit-capture'
import { ToolRecords } from '../recording/tool-records'
import { recordThreadSummary } from '../recording/thread-summary'
import { adoptThread, isAdoptionSpawn, releaseThreadMountWhenIdle, reportClaudeRun } from './thread-runs'

/**
 * A recorded subagent in this process. Claude stays its executor; Delta records it as an ordinary
 * child thread under the thread of the loop that spawned it, through an outbox of its own.
 */
export type ChildRuntime = {
  session: string
  agentId: string
  /** The producer external ID of the loop whose agent sends this run's prompt. */
  sender: string
  /** A foreground child runs inside its parent's turn, so stopping it ends that turn. */
  foreground: boolean
  tools: ToolRecords
  pendingCaptures: Set<EditCapture>
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
  /** The release of its checkout mount in flight, which every caller shares. */
  finishingCheckout?: Promise<void>
  /**
   * Settles once this run's checkout is mounted. A resumed run's tools wait for it while `holdsTools`,
   * and the run's end waits for it before it stops the mount.
   */
  checkoutMounted?: { promise: Promise<void>; resolve: () => void; holdsTools: boolean }
  /**
   * What the next prompt Claude runs it with is recorded as: the message that was sent, without the
   * thread history Claude was handed with it.
   */
  promptText?: string
}
export const children = new Map<string, ChildRuntime>()
/** Agents never recorded here: other kinds of agent, and agents spawned by one that is not recorded. */
const unrecordedAgents = new Set<string>()
/** Agents whose first hook is finding out whether they are recorded, which their other hooks wait for. */
const discoveries = new Map<string, Promise<ChildRuntime | undefined>>()

export function stopReasonOf(e: { isAborted?: boolean; reason?: string }): 'end_turn' | 'cancelled' | 'refusal' | 'error' | undefined {
  return e.isAborted || e.reason === 'aborted' ? 'cancelled'
    : e.reason === 'answer' ? 'end_turn'
    : e.reason === 'refusal' ? 'refusal'
    : e.reason === 'error' ? 'error' : undefined
}

/** Run `step` in order with the child's other steps; a failure is reported and never fails a hook. */
export function childStep(host: Host, child: ChildRuntime, step: () => Promise<void>): Promise<void> {
  const running = child.queue.then(step, step)
  child.queue = running.catch(() => {})
  return running.catch((error) => reportChild(host, child, error))
}

/**
 * The recorded child `agentId`, or undefined for an agent this session does not record. This plugin
 * hooks no `agent.spawn`: the organization's built-in guard keeps that event from the plugins a person
 * installs whenever the organization provides the agent, and Claude then says each one's hook was
 * skipped. So the first hook an agent's loop raises finds out, and its other hooks wait for that.
 */
export function childFor(host: Host, agentId: string): Promise<ChildRuntime | undefined> {
  const known = children.get(agentId)
  if (known || unrecordedAgents.has(agentId)) return Promise.resolve(known)
  let discovery = discoveries.get(agentId)
  if (!discovery) {
    // A failure leaves the agent unknown, so its next hook asks again.
    discovery = discoverChild(host, agentId).catch(async (error) => {
      try { await host.ui.log(`Delta could not record the subagent ${agentId}: ${String(error)}`, { to: 'debug' }) }
      catch { /* reporting never fails a hook */ }
      return undefined
    }).finally(() => { discoveries.delete(agentId) })
    discoveries.set(agentId, discovery)
  }
  return discovery
}

/** The binding saved for a recorded subagent, as this plugin wrote it; see `storedBinding`. */
export async function storedChildBinding(host: Host, session: string, agentId: string): Promise<ChildBinding | undefined> {
  return await host.store.get(childKey(session, agentId)) as ChildBinding | undefined
}

export async function loadChild(host: Host, child: { session: string; agentId: string }): Promise<ChildBinding> {
  const stored = await storedChildBinding(host, child.session, child.agentId)
  if (!stored) throw new Error(`the recorded subagent ${child.agentId} lost its saved state`)
  return restoreBinding(stored)
}

export async function saveChild(host: Host, binding: ChildBinding) {
  await host.store.set(childKey(binding.session, binding.agentId), binding)
}

export function stageChildRecord(host: Host, binding: ChildBinding, body: RecordBody): Promise<ChildBinding> {
  return stageOutboxRecord(host, childOutbox(binding.session, binding.agentId), binding, body)
}

/** Whether this session records the agents it spawns: it records, and its CLI speaks children. */
export function recordsChildren(session: string): boolean {
  const binding = stateFor(session).binding
  return !!binding?.snapshot && !binding.joinTransition &&
    (verifiedContract(session) ?? 0) >= CHILD_CONTRACT_VERSION
}

/**
 * Decide whether the agent `agentId`, whose loop raised its first hook here, is recorded, and start
 * recording it if so; Claude lists an agent before its loop raises anything. A child this session
 * recorded before, as a resumed one, goes on recording. Otherwise an ordinary subagent a recorded loop
 * started is recorded, unless it ran before, unrecorded: its history is not ours. The plugin's own spawn
 * for a thread Claude runs is that thread's.
 */
async function discoverChild(host: Host, agentId: string): Promise<ChildRuntime | undefined> {
  const session = await host.session.id()
  if (!recordsChildren(session)) return unrecorded(agentId)
  const stored = await storedChildBinding(host, session, agentId)
  if (stored) return children.get(agentId) ?? addChild(session, agentId, stored.parent, false)
  const agent = (await host.agent.list()).find((listed) => listed.id === agentId)
  if (!agent || !recordsSubagent(agent)) return unrecorded(agentId)
  if (isAdoptionSpawn(agent.description)) return adoptThread(host, agentId) ?? unrecorded(agentId)
  const parent = agent.parentId ?? session
  if (parent !== session && !children.has(parent)) return unrecorded(agentId)
  const messages = await host.session.agentMessages({ agentId })
  if (Array.isArray(messages) && messages.some((message) => message.role === 'assistant')) return unrecorded(agentId)
  const known = children.get(agentId)
  if (known) return known
  // An agent another plugin spawns runs in the background, as does one Claude said it launched there.
  // One that starts beside a waiting Agent call of its parent before its own call answers `async_launched`
  // counts as foreground until that answer: no hook the guard lets through says sooner.
  const background = agent.spawnedBy !== undefined || launchedInBackground.delete(agentId)
  const child = addChild(session, agentId, parent, !background && (waitingCalls.get(parent) ?? 0) > 0)
  // Saving is the child's first step, so none of its steps can run before its state exists.
  await childStep(host, child, async () => {
    await saveChild(host, { session, agentId, parent, name: childName(agent), next: 1, pending: [] })
    await rememberChild(host, session, agentId)
  })
  void deliverChild(host, child)
  return child
}

function unrecorded(agentId: string): undefined {
  unrecordedAgents.add(agentId)
  launchedInBackground.delete(agentId)
  return undefined
}

/** Per loop, how many of its Agent calls that wait for their subagent are running; see `followAgentCall`. */
const waitingCalls = new Map<string, number>()
/** Agents Claude launched in the background before their loop raised anything here. */
const launchedInBackground = new Set<string>()

/**
 * Run a model's Agent call, counting the calls of each loop that wait for their subagent: a subagent
 * that starts while one of its parent's runs is in the foreground, and taking it over stops that turn.
 * Claude may still launch it in the background, as its definition can ask, which the call's answer says.
 */
export async function followAgentCall<R>(host: Host, e: HookEvent<'tool.call'>, run: () => Promise<R>): Promise<R> {
  const call: unknown = e
  const loop = e.agentId ?? await host.session.id()
  const waits = isJsonObject(call) && call.run_in_background !== true
  if (waits) waitingCalls.set(loop, (waitingCalls.get(loop) ?? 0) + 1)
  try {
    const result = await run()
    const answer: unknown = result
    const record = isJsonObject(answer) ? answer.result : undefined
    if (isJsonObject(record) && record.status === 'async_launched' && typeof record.agentId === 'string') {
      const child = children.get(record.agentId)
      if (child) child.foreground = false
      else launchedInBackground.add(record.agentId)
    }
    return result
  } finally {
    if (waits) {
      const left = (waitingCalls.get(loop) ?? 0) - 1
      if (left > 0) waitingCalls.set(loop, left)
      else waitingCalls.delete(loop)
    }
  }
}

/** Begin a child's turn: close any turn left open, stage its scoped start, and place its held rows. */
async function beginChildTurn(host: Host, child: ChildRuntime, turnId: string, cwd: string) {
  child.currentTurnId = turnId
  let binding = await loadChild(host, child)
  if (binding.awaitingSnapshot) return
  const running = await runningUpdate(host)
  if (binding.execution)
    binding = await stageChildRecord(host, binding, {
      turnSequence: binding.execution.sequence, update: { sessionUpdate: 'state_update', state: 'idle' },
    })
  const sequence = binding.next
  binding = await stageChildRecord(host, binding, { turnSequence: sequence, update: running })
  binding.execution = { sequence, turnId }
  binding.lastTurnSequence = sequence
  const rows = child.heldRows
  child.heldRows = []
  for (const { update, toolId, turnId: owner } of rows) {
    if (owner !== undefined && owner !== turnId) continue
    if (toolId && !child.tools.toolTurns.has(toolId)) child.tools.toolTurns.set(toolId, sequence)
    binding = await stageChildRecord(host, binding, { update, turnSequence: sequence })
  }
  const resumed = !!binding.thread
  binding = await placeChild(host, binding, cwd)
  await saveChild(host, binding)
  if (binding.checkout) {
    let resolve!: () => void
    const promise = new Promise<void>((settle) => { resolve = settle })
    // Delta may hold edits made since the last run, such as a takeover's, that the mount brings in.
    child.checkoutMounted = { promise, resolve, holdsTools: resumed }
  }
  void deliverChild(host, child)
}

/**
 * Decide, at a child's first turn, whether it works in its parent's checkout, whose worktrees its
 * thread then shares, or apart from it. A run in a checkout of its own, such as an isolated worktree,
 * attaches that checkout to the child's thread while it runs there.
 */
async function placeChild(host: Host, binding: ChildBinding, cwd: string): Promise<ChildBinding> {
  const root = await gitRoot(host, cwd)
  const directory = root ?? cwd
  if (binding.sharesParentCheckout === undefined) {
    const parent = await parentDirectories(host, binding)
    binding.sharesParentCheckout = parent.some((candidate) => samePath(candidate, directory))
    binding.directories = binding.sharesParentCheckout ? parent : [directory]
  }
  // An adopted thread, or a child an earlier version forked, runs where Delta already keeps its worktrees,
  // so nothing is attached for it.
  if (!binding.sharesParentCheckout && !binding.adopted && !binding.mountOwner && root && !binding.checkout) binding.checkout = root
  return binding
}

/**
 * The directories a child's parent works in: the session's checkout, or a joined session's directory
 * and each worktree mounted for it; or the directories a recorded parent subagent works in.
 */
export async function parentDirectories(host: Host, binding: Pick<ChildBinding, 'session' | 'parent'>): Promise<string[]> {
  if (binding.parent !== binding.session)
    return (await loadChild(host, { session: binding.session, agentId: binding.parent })).directories ?? []
  const session = stateFor(binding.session).binding
  const bound = boundDirectory(session)
  if (!bound) return []
  if (!session?.joined) return [bound]
  // A joined session works in one worktree's checkout and adds the others' as working directories.
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
export async function endChildTurn(host: Host, child: ChildRuntime, turnId: string | undefined,
    stopReason: 'end_turn' | 'cancelled' | 'refusal' | 'error' | undefined, cwd?: string) {
  if (turnId !== undefined && child.currentTurnId === turnId) child.currentTurnId = undefined
  let binding = await loadChild(host, child)
  const snapshot = !!binding.awaitingSnapshot
  if (snapshot) {
    binding = await snapshotChild(host, child, binding)
    if (cwd) binding = await placeChild(host, binding, cwd)
    await saveChild(host, binding)
  }
  const execution = binding.execution
  // A run found going when recording started has no Claude turn id; any end of it ends that turn.
  if (!execution || (execution.turnId !== undefined && execution.turnId !== turnId)) {
    if (snapshot) void deliverChild(host, child)
    return
  }
  binding = await stageChildRecord(host, binding, {
    turnSequence: execution.sequence, update: {
      sessionUpdate: 'state_update', state: 'idle',
      ...stopReason ? { stopReason } : {},
      ...stopReason === 'error' ? { error: { code: -32603, message: 'External producer reported an error' } } : {},
    },
  })
  delete binding.execution
  await saveChild(host, binding)
  child.turnWatch?.stop()
  child.tools.forgetUnpaired(execution.sequence)
  void deliverChild(host, child)
}

/**
 * Stage the rows of one message a child's loop stored. A prompt is attributed to the agent that
 * sent it. Like the session's own rows, a row waits for the turn start that fixes its sequence.
 */
export async function recordChildMessage(host: Host, child: ChildRuntime, message: ApiMessage, id: string) {
  let binding = await loadChild(host, child)
  if (binding.awaitingSnapshot) return
  const plans = recordsPlans(child.session)
  rememberToolResults(child.tools, message, plans)
  const root = childRoot(binding)
  const updates = messageUpdates(message, id, child.tools.structuredResults,
    { root, omitted: child.tools.omitted, plans })
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
      binding = await stageChildRecord(host, binding, {
        update, turnSequence: tool ? child.tools.toolTurns.get(tool) : turn ?? binding.lastTurnSequence,
      })
    }
    await saveChild(host, binding)
  }
  for (const block of message.content) {
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') child.tools.settle(block.tool_use_id, 'row')
  }
  void deliverChild(host, child)
}

/** Stage a child's tool result as its call hook saw it, with the structured output a row lacks. */
async function recordChildToolResult(host: Host, child: ChildRuntime,
    call: { tool: string; tool_use_id: string; input: unknown }, result: unknown, isError: boolean) {
  let binding = await loadChild(host, child)
  // The call's row may not be stored yet, so the tool's name decides its omission too.
  if (binding.awaitingSnapshot || child.tools.omitted.has(call.tool_use_id) ||
      isOmittedTool(call.tool, recordsPlans(child.session))) return
  const root = childRoot(binding)
  const update = resultUpdate(call.tool_use_id, call.tool, result, isError, root)
  child.tools.structuredResults.set(call.tool_use_id, update)
  const row = child.tools.toolResults.get(call.tool_use_id)
  const updates = (row
    ? messageUpdates({ role: 'user', content: [row] }, `tool-result:${call.tool_use_id}`, child.tools.structuredResults)
    : [{ ...update, status: 'in_progress', name: call.tool, ...toolInfo(call.tool, call.input, root) }]).map(liveActivity)
  const turn = child.tools.toolTurns.get(call.tool_use_id) ?? binding.execution?.sequence ?? binding.lastTurnSequence
  for (const update of updates) binding = await stageChildRecord(host, binding, { update, turnSequence: turn })
  await saveChild(host, binding)
  child.tools.settle(call.tool_use_id, 'call')
  void deliverChild(host, child)
}

/**
 * Record the whole transcript of a child that ran before this session recorded: within the turn
 * recorded for a run still going then, else as history.
 */
export async function snapshotChild(host: Host, child: ChildRuntime, binding: ChildBinding): Promise<ChildBinding> {
  const messages = await host.session.agentApiMessages(child.agentId)
  if (!Array.isArray(messages)) throw new Error(`the transcript of subagent ${child.agentId} is unavailable`)
  const root = childRoot(binding)
  const summaries = await host.session.agentMessages({ agentId: child.agentId })
  if (!Array.isArray(summaries)) throw new Error(`the transcript of subagent ${child.agentId} is unavailable`)
  const results = recordedToolResults(summaries, root)
  const tools = new ToolRecords()
  const turnSequence = binding.execution?.sequence
  const plans = recordsPlans(child.session)
  for (const [index, message] of snapshotMessages(messages).entries()) {
    rememberToolResults(tools, message, plans)
    const updates = messageUpdates(message, `snapshot:${index}`, results, { root, omitted: tools.omitted, plans })
    for (const update of updates)
      binding = await stageChildRecord(host, binding, { update: sentBy(update, child.sender), ...turnSequence ? { turnSequence } : {} })
  }
  delete binding.awaitingSnapshot
  await saveChild(host, binding)
  return binding
}

async function gitRoot(host: Host, cwd: string): Promise<string | undefined> {
  try {
    const result = await host.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd })
    return result.exitCode === 0 && !result.isStdoutTruncated ? result.stdout.trim() || undefined : undefined
  } catch { return undefined }
}

/**
 * Create the child's thread, attach a checkout of its own, and deliver its queued records. A child
 * whose parent has no thread yet waits for the next delivery. One delivery runs at a time; asking
 * again while one runs makes it go round once more.
 */
export function deliverChild(host: Host, child: ChildRuntime): Promise<void> {
  if (child.delivering) {
    child.redeliver = true
    return child.delivering
  }
  const task = (async () => {
    do {
      child.redeliver = false
      await deliverChildOnce(host, child)
    } while (child.redeliver)
    child.retryAttempts = 0
  })().catch((error) => failChildDelivery(host, child, error))
  child.delivering = task.finally(() => { child.delivering = undefined })
  return child.delivering
}

async function deliverChildOnce(host: Host, child: ChildRuntime) {
  if (child.refused || !children.has(child.agentId)) return
  const session = await serial(() => load(host, child.session))
  child.waitingForParent = !session.thread
  if (!session.thread) return
  let binding = await loadChild(host, child)
  if (!binding.thread) {
    // Whether its thread shares its parent's worktrees is known once the child starts working.
    if (binding.sharesParentCheckout === undefined) return
    const parent = child.session === binding.parent ? session.locator ?? session.thread : await childReference(host, child, binding.parent)
    child.waitingForParent = !parent
    if (!parent) return
    const created = await createChildThread(host, child.agentId, parent, binding.name,
      binding.sharesParentCheckout ? 'shared' : undefined)
    await childStep(host, child, async () => {
      await saveChild(host, { ...await loadChild(host, child), thread: created.thread_id, reference: created.reference })
    })
    binding = await loadChild(host, child)
  }
  // The thread exists from here on: it was recorded already, or the creation above saved it.
  const { thread, reference } = binding
  if (!thread || !reference) {
    // A thread without a reference cannot be written to; with nothing to send, that is no failure.
    if (binding.pending.length || (binding.checkout && !binding.checkoutReference))
      throw new Error(`the recorded subagent ${child.agentId} has no thread`)
    return
  }
  if (binding.checkout && !binding.checkoutReference) {
    const attachedReference = await attachWorktree(host, binding.checkout, thread)
    await childStep(host, child, async () => {
      await saveChild(host, { ...await loadChild(host, child), checkoutReference: attachedReference })
    })
    binding = await loadChild(host, child)
  }
  if (binding.checkout && binding.checkoutReference) {
    await mountCheckout(host, { session: child.session, checkout: binding.checkout, checkoutReference: binding.checkoutReference })
    child.checkoutMounted?.resolve()
  }
  if (children.get(child.agentId) === child) {
    for (const capture of child.pendingCaptures) capture.submit(reference)
    child.pendingCaptures.clear()
  }
  watchChildTurn(host, child, binding)
  while (binding.pending.length) {
    const { count, fenced, failure } = await appendPending(host, {
      reference, thread, externalId: child.agentId,
      local: recordsOffline(child.session, session),
    }, binding.pending)
    if (count) {
      let acknowledged!: ChildBinding
      await childStep(host, child, async () => {
        const current = await loadChild(host, child)
        acknowledged = { ...current, pending: current.pending.slice(count) }
        await saveChild(host, acknowledged)
      })
      // Delivery runs one at a time per child, so its cleanup needs no queue of its own.
      void collectAcknowledgedOutbox(host, {
        session: childOutbox(child.session, child.agentId), root: outbox, next: acknowledged.next,
        pending: acknowledged.pending.map((entry) => ({ sequence: entry.sequence, files: [...entry.files] })),
      }).catch((error) => reportChild(host, child, error))
    }
    // Delta fenced the running turn: someone took the child over in Delta, so Claude stops it.
    const running = binding.execution?.sequence
    if (running !== undefined && fenced.includes(running)) takeOverChild(host, child, running)
    if (failure) throw failure
    binding = await loadChild(host, child)
  }
  // A checkout of its own is attached only while the child runs there; once nothing runs and what it
  // recorded is delivered, the thread keeps Delta's copy and the checkout is Claude's again.
  if (!binding.execution && binding.checkoutReference) await finishChildCheckout(host, child)
}

/** Create or reuse the subagent `agentId`'s child thread under `parent`, sharing its parent's worktrees when it works in them. */
async function createChildThread(host: Host, agentId: string, parent: string, name: string,
    worktrees: 'shared' | undefined): Promise<{ thread_id: string; reference: string }> {
  const created = await threadCreate(host, { externalId: agentId, parent: { reference: parent, name, worktrees } })
  if (typeof created.reference !== 'string' || !created.reference)
    throw new Error("thread create: Delta returned no reference for the subagent's thread")
  return { thread_id: created.thread_id, reference: created.reference }
}

function takeOverChild(host: Host, child: ChildRuntime, sequence: number) {
  if (child.stoppedTurn === sequence) return
  child.stoppedTurn = sequence
  void stopChild(host, child)
}

/**
 * While a child's turn runs, watch its thread so a stop or a message in Delta, which supersedes that
 * turn, stops Claude within moments rather than at the child's next append, which a long tool call
 * can hold back. A watch that fails is reported and not retried: the next append's fence still stops
 * the turn.
 */
function watchChildTurn(host: Host, child: ChildRuntime, binding: ChildBinding) {
  const sequence = binding.execution?.sequence
  const reference = binding.reference
  if (sequence === undefined || !reference || child.turnWatch?.sequence === sequence) return
  child.turnWatch?.stop()
  let stopped = false
  let stream: ReturnType<Host['process']['spawn']> | undefined
  const watch = {
    sequence,
    stop: () => {
      stopped = true
      void stream?.return({ code: null, signal: 'SIGTERM' }).catch(() => {})
    },
  }
  child.turnWatch = watch
  void (async () => {
    stream = await threadWatch(host, reference, {
      externalId: child.agentId,
      // The turn may have ended while the delivery that asked for this watch ran.
      proceed: async () => !stopped && (await loadChild(host, child)).execution?.sequence === sequence,
    })
    // A stop while the watch was spawning found no process to end; the `finally` below ends it.
    if (!stream || stopped) return
    for await (const event of watchEvents(stream)) {
      if (stopped) return
      const turn = event.type === 'producer.turn' ? event : event.type === 'ready' ? event.producer?.turn : undefined
      if (turn?.sequence === sequence && turn.status === 'superseded') {
        if ((await loadChild(host, child)).execution?.sequence === sequence) takeOverChild(host, child, sequence)
        return
      }
    }
  })().catch((error) => reportChild(host, child, error)).finally(() => {
    watch.stop()
    if (child.turnWatch === watch) child.turnWatch = undefined
  })
}

/** How long a child's `turn.complete` hook delivers before ending its mount; see `finishChildRun`. */
const CHILD_FINISH_DELIVERY_BUDGET_MS = 3_000

/**
 * After a child's run ends, deliver what it recorded within a short budget, then end its
 * checkout mount. The attachment remains available in the thread after Claude removes its
 * checkout; delivery that takes longer continues on its own.
 */
async function finishChildRun(host: Host, child: ChildRuntime) {
  const expiry = new AbortController()
  await Promise.race([
    deliverChild(host, child),
    host.clock.sleep(CHILD_FINISH_DELIVERY_BUDGET_MS, { signal: expiry.signal }).catch(() => undefined),
  ])
  expiry.abort()
  await finishChildCheckout(host, child)
}

/** End a child's mount once no run of it is going on, retaining its worktree in the thread for later review. */
function finishChildCheckout(host: Host, child: ChildRuntime): Promise<void> {
  child.finishingCheckout ??= finishChildCheckoutOnce(host, child).finally(() => { child.finishingCheckout = undefined })
  return child.finishingCheckout
}

async function finishChildCheckoutOnce(host: Host, child: ChildRuntime) {
  const binding = await loadChild(host, child).catch(() => undefined)
  if (!binding || binding.execution || !binding.thread || !binding.checkout || !binding.checkoutReference) return
  // Stopping a mount still preparing cancels its adoption of the worktree, so Delta would miss what
  // the run did; Claude removes or keeps the worktree only after this hook returns. A mount that is
  // still preparing after the wait is stopped anyway, and the next run's mount imports the worktree.
  if (!await awaitChildCheckout(host, child))
    await host.ui.log(`Delta was still preparing the worktree of the subagent ${child.agentId} when its run ended; Delta records what the run changed there the next time the subagent runs`, { to: 'debug' })
  child.checkoutMounted = undefined
  let stopped: boolean
  try {
    stopped = await stopWorktreeMount(child.session, binding.checkout)
  } catch (error) {
    await reportChild(host, child, error)
    return
  }
  // Delta finishes a checkout after its mount command ends, and Claude may remove the worktree as
  // soon as this hook returns, so Delta stops watching the directory first.
  if (stopped) await awaitCheckoutReleased(host, binding.checkout).catch((error) => reportChild(host, child, error))
  await childStep(host, child, async () => {
    const current = await loadChild(host, child)
    if (current.execution) return
    delete current.checkout
    delete current.checkoutReference
    await saveChild(host, current)
  })
}

/** The reference of a recorded parent subagent's thread, creating that thread first when needed. */
async function childReference(host: Host, child: ChildRuntime, parentAgentId: string): Promise<string | undefined> {
  const parent = children.get(parentAgentId)
  if (!parent) throw new Error(`the subagent ${child.agentId}'s parent ${parentAgentId} is not recorded`)
  await deliverChild(host, parent)
  return (await loadChild(host, parent)).reference
}

/**
 * A refusal stops the child's delivery and is shown once; anything else retries with backoff. A
 * child's failure never pauses the session or its other children.
 */
async function failChildDelivery(host: Host, child: ChildRuntime, error: unknown) {
  const binding = await loadChild(host, child).catch(() => undefined)
  const name = binding?.name ?? child.agentId
  if (error instanceof DeltaCommandError && classifyCommandFailure(error) === 'permanent') {
    child.refused = errorText(error)
    await host.ui.log(`Delta stopped recording the subagent "${name}": ${errorText(error)}. Its records stay queued.`, { to: 'transcript' })
    return
  }
  if (child.retryTimer) return
  const retryAfterMs = error instanceof DeltaCommandError ? error.hints.retryAfterMs : undefined
  child.retryTimer = host.clock.after(deliveryRetryDelay(child.retryAttempts++, retryAfterMs), () => {
    child.retryTimer = undefined
    void deliverChild(host, child)
  })
}

export async function reportChild(host: Host, child: ChildRuntime, error: unknown) {
  try { await host.ui.log(`Delta could not record the subagent ${child.agentId}: ${String(error)}`, { to: 'debug' }) }
  catch { /* reporting never fails a hook */ }
}

/**
 * Stop a child Delta took over. A background child is stopped on its own; a foreground child runs
 * inside its parent's turn, which stops with it.
 */
async function stopChild(host: Host, child: ChildRuntime) {
  try {
    let name = ''
    // The parent hears Delta's reply when Delta's turn ends, as it would have heard the subagent's.
    await childStep(host, child, async () => {
      const binding = await loadChild(host, child)
      name = binding.name
      await saveChild(host, { ...binding, awaited: 'delta' })
    })
    if (child.foreground) {
      const turnId = stateFor(child.session).currentTurnId
      if (turnId) await host.turn.abort({ turnId })
    } else await host.tool.stopTask(child.agentId)
    await host.ui.log(`Someone took over the subagent "${name}" in Delta, so Claude stopped it. Tool effects it already made are not rolled back.`, { to: 'transcript' })
    await deliverNote(host, child.session, `[Delta] Someone took over the subagent "${name}" in Delta, so Claude stopped its run here. Delta's agent continues it in that thread; its reply is added here when Delta's turn ends. Send "${name}" a message with SendMessage to run it here again.`)
  } catch (error) { await reportChild(host, child, error) }
}

/** A child this session now records, tracked in `children` from here on. */
export function addChild(session: string, agentId: string, sender: string, foreground: boolean): ChildRuntime {
  const child: ChildRuntime = {
    session, agentId, sender, foreground, tools: new ToolRecords(), heldRows: [], queue: Promise.resolve(),
    pendingCaptures: new Set(), retryAttempts: 0,
  }
  children.set(agentId, child)
  return child
}

/** List a child on its session's binding, which is how a restarted process finds it again. */
export async function rememberChild(host: Host, session: string, agentId: string) {
  await serial(async () => {
    const binding = await load(host, session)
    if (!binding.children?.includes(agentId))
      await save(host, { ...binding, children: [...binding.children ?? [], agentId] })
  })
}

/**
 * A session's subagents end with it. Their saved state stays, so the next activation closes a turn
 * left open and delivers what they queued.
 */
export function forgetSubagents(session: string) {
  for (const [agentId, child] of children) {
    if (child.session !== session) continue
    child.retryTimer?.cancel()
    child.pendingCaptures.clear()
    children.delete(agentId)
  }
}

/** A subagent's turn started in its own loop; a recorded one's turn is its own thread's. */
export async function startChildTurn(host: Host, e: HookEvent<'turn.start'>, agentId: string, next: HookNext<'turn.start'>) {
  const child = await childFor(host, agentId)
  if (child) {
    // The child's own hook is the only place its working directory can be read.
    const cwd = await host.session.cwd()
    await childStep(host, child, () => beginChildTurn(host, child, e.turnId, cwd))
  }
  return next(e)
}

/**
 * Hold a resumed child's tool until its checkout is mounted, so it sees what Delta brings in, such as
 * a takeover's edits. Claude runs a resumed subagent without waiting for its turn start, so its tools
 * are what can be held; the turn start a tool may race is let finish first. A mount still preparing
 * after `CHILD_MOUNT_BUDGET_MS` stops holding the run's tools.
 */
async function awaitChildToolCheckout(host: Host, child: ChildRuntime) {
  await childStep(host, child, async () => {})
  const mounted = child.checkoutMounted
  if (!mounted?.holdsTools) return
  const ready = await awaitChildCheckout(host, child)
  mounted.holdsTools = false
  if (!ready)
    await host.ui.log(`Delta was still preparing the worktree of the subagent ${child.agentId} after ${CHILD_MOUNT_BUDGET_MS / 1000} seconds; its tools run without waiting, and may first see files from before Delta's latest changes`, { to: 'debug' })
}

/** How long a child's hook waits for its checkout's mount to become ready. */
const CHILD_MOUNT_BUDGET_MS = 10_000

/**
 * Wait until this run's checkout is mounted, within `CHILD_MOUNT_BUDGET_MS`; false once that passes,
 * as it may for a mount waiting for a connection. A delivery that ends without mounting ends the wait.
 */
async function awaitChildCheckout(host: Host, child: ChildRuntime): Promise<boolean> {
  const mounted = child.checkoutMounted
  if (!mounted) return true
  const expiry = new AbortController()
  const settled = await Promise.race([
    mounted.promise.then(() => true),
    (child.delivering ?? Promise.resolve()).then(() => true),
    host.clock.sleep(CHILD_MOUNT_BUDGET_MS, { signal: expiry.signal }).then(() => false, () => true),
  ])
  expiry.abort()
  return settled
}

/**
 * What an earlier version of this plugin named the folder it moved Claude's worktree to, while a link to
 * a subagent's Delta fork took its place. A checkout can keep that layout for as long as nobody opens
 * Claude in it again, so what reads this stays.
 */
const KEPT_SUFFIX = '.claude-worktree'

/**
 * Put back Claude's worktree for a child an earlier version forked, before Claude resumes it: Claude
 * verifies the worktree first, and the resume fails without it.
 */
export async function unlinkForResume(host: Host, child: ChildRuntime) {
  try {
    const binding = await loadChild(host, child)
    if (binding.claudeWorktree) await restoreClaudeWorktree(host, binding.claudeWorktree)
  } catch (error) {
    // The resume still goes; Claude then says why it cannot verify the child's worktree.
    await host.ui.log(`Delta could not put back the worktree Claude made for the subagent ${child.agentId}: ${String(error)}`, { to: 'debug' })
  }
}

/**
 * Put Claude's worktree `worktree` back where an earlier version's link to a subagent's fork is. Claude
 * removes or keeps it afterwards, as it does any isolated subagent's.
 */
export async function restoreClaudeWorktree(host: Host, worktree: string) {
  const kept = `${worktree}${KEPT_SUFFIX}`
  if (!await host.fs.exists(kept)) return
  if ((await host.fs.stat(worktree).catch(() => undefined))?.isLink) await runLocal(host, worktree, ['rm', '--', worktree])
  await runLocal(host, worktree, ['mv', '--', kept, worktree])
}

/**
 * Put back each git worktree Claude made for an isolated subagent that an earlier version moved aside
 * and a session which did not end cleanly left so, so Claude finds it where it made it. A link that still
 * leads to a fork may be another running session's, so only a missing link or one that leads nowhere is
 * replaced.
 */
export async function restoreAbandonedWorktrees(host: Host) {
  const cwd = await host.session.cwd()
  if (!cwd.startsWith('/')) return
  // Claude makes them in the checkout `cwd` is in: the nearest folder that holds `.git`.
  let top = cwd.replace(/\/+$/, '')
  while (top && !await host.fs.exists(`${top}/.git`)) top = top.slice(0, top.lastIndexOf('/'))
  if (!top) return
  const folder = `${top}/.claude/worktrees`
  let entries: FsEntry[]
  try { entries = await host.fs.list(folder) }
  catch { return }
  for (const kept of entries) {
    if (kept.kind !== 'dir' || !kept.name.endsWith(KEPT_SUFFIX)) continue
    const name = kept.name.slice(0, -KEPT_SUFFIX.length)
    const worktree = `${folder}/${name}`
    const link = entries.find((entry) => entry.name === name)
    if (link && !link.isLink) continue
    // `stat` follows a link; one that leads nowhere is neither a file nor a directory.
    if (link && (await host.fs.stat(worktree).catch(() => undefined))?.kind === 'dir') continue
    if (link) await runLocal(host, worktree, ['rm', '--', worktree])
    await runLocal(host, worktree, ['mv', '--', `${worktree}${KEPT_SUFFIX}`, worktree])
  }
}

/**
 * Run a local file command on the worktree `worktree`, from the folder that holds it: the hook's own
 * directory may be that worktree, which a move takes away.
 */
async function runLocal(host: Host, worktree: string, argv: string[]) {
  const result = await host.process.run(argv, { cwd: worktree.slice(0, worktree.lastIndexOf('/')) })
  if (result.exitCode !== 0) throw new Error(`${argv[0]} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
}

/** A subagent's turn ended: close its record, finish its run, and report a thread run's reply. */
export async function completeChildTurn(host: Host, e: HookEvent<'turn.complete'>, agentId: string, next: HookNext<'turn.complete'>, prose?: string) {
  const result = await next(e)
  const child = await childFor(host, agentId)
  if (child) {
    // A run found going when recording started attaches its own checkout now, read from its hook.
    const cwd = await host.session.cwd()
    const sequence = (await loadChild(host, child)).execution?.sequence
    await childStep(host, child, () => endChildTurn(host, child, e.turnId, stopReasonOf(e), cwd))
    if (sequence !== undefined && prose) void recordThreadSummary(host, child.session, sequence, prose, agentId)
    await finishChildRun(host, child)
    await releaseThreadMountWhenIdle(host, child)
    await reportClaudeRun(host, child)
  }
  return result
}

/** A row a recorded subagent's loop kept is recorded on its thread. */
export async function recordChildRow(host: Host, e: HookEvent<'session.append'>, agentId: string, next: HookNext<'session.append'>) {
  const stored = await next(e)
  if ('deny' in stored) return stored
  const message = capturedMessage(stored.message, e.door)
  const child = message && await childFor(host, agentId)
  if (message && child) await childStep(host, child, () => {
    // A run the plugin started on a thread, or resumed, is recorded as prompted with the message alone,
    // not the thread history it was handed with it.
    if (child.promptText !== undefined && e.door === 'prompt' && message.content.some((block) => block.type === 'text')) {
      const text = child.promptText
      child.promptText = undefined
      return recordChildMessage(host, child, { role: 'user', content: [{ type: 'text', text }] }, stored.uuid)
    }
    return recordChildMessage(host, child, message, stored.uuid)
  })
  return stored
}

/** A recorded subagent's tool call finished; its result is recorded on its thread. */
export async function recordChildToolCall(host: Host, e: HookEvent<'tool.call'>, agentId: string, next: HookNext<'tool.call'>) {
  const running = await childFor(host, agentId)
  if (running) await awaitChildToolCheckout(host, running)
  const editing = e.tool_use_id && capturesEdits(e.tool) ? running : undefined
  const binding = editing && await loadChild(host, editing)
  const capture = editing && e.tool_use_id
    ? await startCapture(host, editing.session, { externalId: editing.agentId, toolUseId: e.tool_use_id })
    : undefined
  if (editing && capture && children.get(agentId) === editing) {
    if (binding?.thread && binding.reference &&
        (!binding.checkout || hasWorktreeMount(editing.session, binding.checkout))) {
      capture.submit(binding.reference)
    } else {
      editing.pendingCaptures.add(capture)
      void deliverChild(host, editing)
    }
  }
  // Capture ends as the call does, so later edits are not the call's.
  const result = await next(e).finally(() => capture?.stop())
  const id = e.tool_use_id
  if (!id || !('result' in result) || result.result === undefined) return result
  const child = await childFor(host, agentId)
  if (child) await childStep(host, child, () =>
    recordChildToolResult(host, child, { tool: e.tool, tool_use_id: id, input: e }, result.result, !!result.isError))
  return result
}
