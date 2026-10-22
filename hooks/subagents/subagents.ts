/**
 * Recording Claude's subagents, each into a child thread of its own: their bindings, turns, records,
 * checkouts and delivery.
 */
import type { ApiMessage, Timer } from 'claude-code'
import { autoActivating, outbox } from '../setup/activation'
import { restoreBinding } from '../core/binding'
import { type ChildBinding, childKey, childName, childOutbox, recordsSubagent, sentBy } from './children'
import { capturedMessage, messageUpdates, resultUpdate, toolInfo } from '../recording/content'
import {
  appendPending, collectAcknowledgedOutbox, liveActivity, type RecordBody, recordsOffline, rememberToolResults,
  runningUpdate, stageOutboxRecord,
} from '../recording/delivery'
import { deliveryRetryDelay } from '../recording/delivery-policy'
import {
  checkoutSyncing, stopWorktreeMount, threadCreate, threadMergeCommandLine, threadWatch, verifiedContract, watchEvents,
} from '../cli/delta-cli'
import { attachWorktree, mountCheckout } from '../sharing/checkout'
import { mountThread, unmountThread } from '../sharing/join'
import { samePath } from '../core/paths'
import { deliverNote } from '../watch/rows'
import {
  boundDirectory, type HeldRow, type HookEvent, type HookNext, load, type Runtime, save, serial, stateFor,
} from '../core/session-state'
import { snapshotMessages } from '../recording/snapshot'
import { errorText } from '../core/text'
import { CHILD_CONTRACT_VERSION, classifyCommandFailure, DeltaCommandError } from '../cli/thread-commands'
import { ToolRecords } from '../recording/tool-records'
import { adoptThread, isAdoptionSpawn, reportClaudeRun } from './thread-runs'

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
   * What the next prompt Claude runs it with is recorded as: the message that was sent, without the
   * thread history Claude was handed with it.
   */
  promptText?: string
}
export const children = new Map<string, ChildRuntime>()
/** Agents never recorded here: other kinds of agent, and agents spawned by one that is not recorded. */
const unrecordedAgents = new Set<string>()
/** Spawns whose agent ID is not known yet. A child's first hooks can run before its spawn resolves. */
let pendingSpawns = 0

/** A spawn started whose agent ID is not known yet. */
export function beginSpawn() {
  pendingSpawns++
}

/** A spawn settled; once none is pending, what unnamed agents recorded meanwhile is not recorded. */
export function endSpawn() {
  pendingSpawns--
  if (!pendingSpawns) earlyChildSteps.clear()
}
/** The recorded spawns in flight, by the loop that spawned them; their agent IDs are not known yet. */
export const spawning: { parent: string; name: string }[] = []
/** What each not-yet-named agent's hooks recorded meanwhile, replayed once its spawn names it. */
export const earlyChildSteps = new Map<string, ((child: ChildRuntime) => Promise<void>)[]>()

/** Whether an agent's hooks may concern a recorded child: one already recorded, or one a pending spawn may name. */
function mayRecordChild(agentId: string): boolean {
  return children.has(agentId) || (pendingSpawns > 0 && !unrecordedAgents.has(agentId))
}

export function stopReasonOf(e: { isAborted?: boolean; reason?: string }): 'end_turn' | 'cancelled' | 'refusal' | 'error' | undefined {
  return e.isAborted || e.reason === 'aborted' ? 'cancelled'
    : e.reason === 'answer' ? 'end_turn'
    : e.reason === 'refusal' ? 'refusal'
    : e.reason === 'error' ? 'error' : undefined
}

/** Run `step` in order with the child's other steps; a failure is reported and never fails a hook. */
export function childStep($: Runtime, child: ChildRuntime, step: () => Promise<void>): Promise<void> {
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

/** The binding saved for a recorded subagent, as this plugin wrote it; see `storedBinding`. */
export async function storedChildBinding($: Runtime, session: string, agentId: string): Promise<ChildBinding | undefined> {
  return await $.store.get(childKey(session, agentId)) as ChildBinding | undefined
}

export async function loadChild($: Runtime, child: { session: string; agentId: string }): Promise<ChildBinding> {
  const stored = await storedChildBinding($, child.session, child.agentId)
  if (!stored) throw new Error(`the recorded subagent ${child.agentId} lost its saved state`)
  return restoreBinding(stored)
}

export async function saveChild($: Runtime, binding: ChildBinding) {
  await $.store.set(childKey(binding.session, binding.agentId), binding)
}

export function stageChildRecord($: Runtime, binding: ChildBinding, body: RecordBody): Promise<ChildBinding> {
  return stageOutboxRecord($, childOutbox(binding.session, binding.agentId), binding, body)
}

/** Whether this session records the agents it spawns: it records, and its CLI speaks children. */
export function recordsChildren(session: string): boolean {
  const binding = stateFor(session).binding
  return !!binding?.snapshot && !binding.joinTransition &&
    (verifiedContract(session) ?? 0) >= CHILD_CONTRACT_VERSION
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
    const stored = await storedChildBinding($, session, agentId)
    // A resumed agent this session never recorded stays unrecorded: its history is not ours.
    if (!stored && spawn.resumed) {
      unrecordedAgents.add(agentId)
      earlyChildSteps.delete(agentId)
      return
    }
    const adopted = addChild(session, agentId, spawn.parent, spawn.foreground)
    child = adopted
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
export async function parentDirectories($: Runtime, binding: Pick<ChildBinding, 'session' | 'parent'>): Promise<string[]> {
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
export async function endChildTurn($: Runtime, child: ChildRuntime, turnId: string | undefined,
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
export async function recordChildMessage($: Runtime, child: ChildRuntime, message: ApiMessage, id: string) {
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
export async function snapshotChild($: Runtime, child: ChildRuntime, binding: ChildBinding): Promise<ChildBinding> {
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
export function deliverChild($: Runtime, child: ChildRuntime): Promise<void> {
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
  // The thread exists from here on: it was recorded already, or the creation above saved it.
  const { thread, reference } = binding
  if (!thread || !reference) {
    // A thread without a reference cannot be written to; with nothing to send, that is no failure.
    if (binding.pending.length || (binding.checkout && !binding.checkoutReference))
      throw new Error(`the recorded subagent ${child.agentId} has no thread`)
    return
  }
  if (binding.checkout && !binding.checkoutReference) {
    const attachedReference = await attachWorktree($, binding.checkout, thread)
    await childStep($, child, async () => {
      await saveChild($, { ...await loadChild($, child), checkoutReference: attachedReference })
    })
    binding = await loadChild($, child)
  }
  if (binding.checkout && binding.checkoutReference)
    await mountCheckout($, { session: child.session, checkout: binding.checkout, checkoutReference: binding.checkoutReference })
  watchChildTurn($, child, binding)
  while (binding.pending.length) {
    const { count, fenced, failure } = await appendPending($, {
      reference, thread, externalId: child.agentId,
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
  if (!binding.execution && binding.checkoutReference) await finishChildCheckout($, child)
}

/** Create or reuse the subagent `agentId`'s child thread under `parent`, with its parent's worktrees or forks of them. */
async function createChildThread($: Runtime, agentId: string, parent: string, name: string,
    worktrees: 'shared' | 'isolated' | undefined): Promise<{ thread_id: string; reference: string }> {
  const created = await threadCreate($, { externalId: agentId, parent: { reference: parent, name, worktrees } })
  if (typeof created.reference !== 'string' || !created.reference)
    throw new Error("thread create: Delta returned no reference for the subagent's thread")
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
    stream = await threadWatch($, reference, {
      externalId: child.agentId,
      // The turn may have ended while the delivery that asked for this watch ran.
      proceed: async () => !stopped && (await loadChild($, child)).execution?.sequence === sequence,
    })
    // A stop while the watch was spawning found no process to end; the `finally` below ends it.
    if (!stream || stopped) return
    for await (const event of watchEvents(stream)) {
      if (stopped) return
      const turn = event.type === 'producer.turn' ? event : event.type === 'ready' ? event.producer?.turn : undefined
      if (turn?.sequence === sequence && turn.status === 'superseded') {
        if ((await loadChild($, child)).execution?.sequence === sequence) takeOverChild($, child, sequence)
        return
      }
    }
  })().catch((error) => reportChild($, child, error)).finally(() => {
    watch.stop()
    if (child.turnWatch === watch) child.turnWatch = undefined
  })
}

/** How long a child's `turn.complete` hook delivers before ending its mount; see `finishChildRun`. */
const CHILD_FINISH_DELIVERY_BUDGET_MS = 3_000
/**
 * How long a child's hook waits for Delta to stop syncing its checkout after its mount ends. Delta
 * bounds the final upload at 5 seconds, then stops watching the directory.
 */
const CHILD_RELEASE_BUDGET_MS = 6_000
/** How often a finishing child's checkout is checked for Delta's release. */
const CHILD_RELEASE_POLL_MS = 100

/** Wait until Delta no longer syncs `directory`, within `CHILD_RELEASE_BUDGET_MS`. */
async function awaitCheckoutReleased($: Runtime, directory: string) {
  const deadline = await $.clock.now() + CHILD_RELEASE_BUDGET_MS
  while (true) {
    const remaining = deadline - await $.clock.now()
    if (remaining <= 0)
      throw new Error(`Delta was still syncing ${directory} ${CHILD_RELEASE_BUDGET_MS / 1000} seconds after its mount ended`)
    if (!await checkoutSyncing($, directory, remaining)) return
    await $.clock.sleep(Math.min(CHILD_RELEASE_POLL_MS, remaining))
  }
}

/**
 * After a child's run ends, deliver what it recorded within a short budget, then end its
 * checkout mount. The attachment remains available in the thread after Claude removes its
 * checkout; delivery that takes longer continues on its own.
 */
async function finishChildRun($: Runtime, child: ChildRuntime) {
  const expiry = new AbortController()
  await Promise.race([
    deliverChild($, child),
    $.clock.sleep(CHILD_FINISH_DELIVERY_BUDGET_MS, { signal: expiry.signal }).catch(() => undefined),
  ])
  expiry.abort()
  await finishChildCheckout($, child)
  await noteForkMerge($, child)
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
      await threadMergeCommandLine($, binding.reference, parent))
  } catch (error) { await reportChild($, child, error) }
}

/** The reference of the thread `parent`, the session or a recorded subagent, records into, once that thread exists. */
async function parentReference($: Runtime, session: string, parent: string): Promise<string | undefined> {
  if (parent !== session) return (await loadChild($, { session, agentId: parent }).catch(() => undefined))?.reference
  const binding = await serial(() => load($, session))
  return binding.locator ?? binding.thread
}

/** End a child's mount once no run of it is going on, retaining its worktree in the thread for later review. */
function finishChildCheckout($: Runtime, child: ChildRuntime): Promise<void> {
  child.finishingCheckout ??= finishChildCheckoutOnce($, child).finally(() => { child.finishingCheckout = undefined })
  return child.finishingCheckout
}

async function finishChildCheckoutOnce($: Runtime, child: ChildRuntime) {
  const binding = await loadChild($, child).catch(() => undefined)
  if (!binding || binding.execution || !binding.thread || !binding.checkout || !binding.checkoutReference) return
  // A mount still preparing is stopped too, so it cannot become ready over a removed worktree.
  let stopped: boolean
  try {
    stopped = await stopWorktreeMount(child.session, binding.checkout)
  } catch (error) {
    await reportChild($, child, error)
    return
  }
  // Delta finishes a checkout after its mount command ends, and Claude may remove the worktree as
  // soon as this hook returns, so Delta stops watching the directory first.
  if (stopped) await awaitCheckoutReleased($, binding.checkout).catch((error) => reportChild($, child, error))
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
    child.refused = errorText(error)
    await $.ui.log(`Delta stopped recording the subagent "${name}": ${errorText(error)}. Its records stay queued.`, { to: 'transcript' })
    return
  }
  if (child.retryTimer) return
  const retryAfterMs = error instanceof DeltaCommandError ? error.hints.retryAfterMs : undefined
  child.retryTimer = $.clock.after(deliveryRetryDelay(child.retryAttempts++, retryAfterMs), () => {
    child.retryTimer = undefined
    void deliverChild($, child)
  })
}

export async function reportChild($: Runtime, child: ChildRuntime, error: unknown) {
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

/** A child this session now records, tracked in `children` from here on. */
export function addChild(session: string, agentId: string, sender: string, foreground: boolean): ChildRuntime {
  const child: ChildRuntime = {
    session, agentId, sender, foreground, tools: new ToolRecords(), heldRows: [], queue: Promise.resolve(),
    retryAttempts: 0,
  }
  children.set(agentId, child)
  return child
}

/** List a child on its session's binding, which is how a restarted process finds it again. */
export async function rememberChild($: Runtime, session: string, agentId: string) {
  await serial(async () => {
    const binding = await load($, session)
    if (!binding.children?.includes(agentId))
      await save($, { ...binding, children: [...binding.children ?? [], agentId] })
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
    children.delete(agentId)
  }
}

/**
 * Decide whether a spawned agent is recorded, and adopt it once its spawn names it. A spawn names its
 * agent only once it resolves, and the agent's first hooks may run before that, so they are held
 * until the spawn says whether the agent is recorded.
 */
export async function recordSpawn($: Runtime, e: HookEvent<'agent.spawn'>, next: HookNext<'agent.spawn'>) {
  // The plugin's own spawn for a thread Claude runs: the subagent is that thread's, not a new one's.
  if (e.resume === undefined && isAdoptionSpawn(e.prompt)) {
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
  beginSpawn()
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
    spawning.splice(spawning.indexOf(spawn), 1)
    endSpawn()
  }
  return result
}

/**
 * Claude asks for an isolated subagent's worktree: a recorded subagent gets a Delta fork of its
 * parent's worktrees instead of Claude's own, so its work merges back into the parent's thread.
 */
export async function createSubagentWorktree(
  $: Runtime, e: HookEvent<'classic.WorktreeCreate'>, next: HookNext<'classic.WorktreeCreate'>,
) {
  // Claude names a subagent's isolated worktree after the agent.
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
  const stored = await storedChildBinding($, session, agentId)
  await saveChild($, stored ? { ...stored, ...binding, next: stored.next, pending: stored.pending } : binding)
  await rememberChild($, session, agentId)
  return binding.mountOwner ? mounted.directory : undefined
}

/** How long an isolated subagent's worktree waits for its session's recording to finish starting. */
const FORK_ACTIVATION_WAIT_MS = 20_000

/** Claude removes an isolated subagent's worktree: one Delta forked is unmounted rather than deleted. */
export async function removeSubagentWorktree(
  $: Runtime, e: HookEvent<'classic.WorktreeRemove'>, next: HookNext<'classic.WorktreeRemove'>,
) {
  const session = await $.session.id()
  for (const child of children.values()) {
    if (child.session !== session) continue
    const binding = await loadChild($, child).catch(() => undefined)
    if (!binding?.mountOwner || !binding.reference ||
        !binding.directories?.some((directory) => samePath(directory, e.worktree_path))) continue
    // Delta deletes its checkout once its changes are uploaded; the fork stays in the thread.
    await unmountThread($, binding.reference, binding.mountOwner)
    return {}
  }
  return next(e)
}

/** A subagent's turn started in its own loop; a recorded one's turn is its own thread's. */
export async function startChildTurn($: Runtime, e: HookEvent<'turn.start'>, agentId: string, next: HookNext<'turn.start'>) {
  if (mayRecordChild(agentId)) {
    // The child's own hook is the only place its working directory can be read.
    const cwd = await $.session.cwd()
    await onChild($, agentId, (child) => beginChildTurn($, child, e.turnId, cwd))
  }
  return next(e)
}

/** A subagent's turn ended: close its record, finish its run, and report a thread run's reply. */
export async function completeChildTurn($: Runtime, e: HookEvent<'turn.complete'>, agentId: string, next: HookNext<'turn.complete'>) {
  const result = await next(e)
  if (mayRecordChild(agentId)) {
    // A run found going when recording started attaches its own checkout now, read from its hook.
    const cwd = await $.session.cwd()
    await onChild($, agentId, (child) => endChildTurn($, child, e.turnId, stopReasonOf(e), cwd))
    const child = children.get(agentId)
    if (child) {
      await finishChildRun($, child)
      await reportClaudeRun($, child)
    }
  }
  return result
}

/** A row a recorded subagent's loop kept is recorded on its thread. */
export async function recordChildRow($: Runtime, e: HookEvent<'session.append'>, agentId: string, next: HookNext<'session.append'>) {
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

/** A recorded subagent's tool call finished; its result is recorded on its thread. */
export async function recordChildToolCall($: Runtime, e: HookEvent<'tool.call'>, agentId: string, next: HookNext<'tool.call'>) {
  const result = await next(e)
  const id = e.tool_use_id
  if (id && mayRecordChild(agentId) && 'result' in result && result.result !== undefined)
    await onChild($, agentId, (child) =>
      recordChildToolResult($, child, { tool: e.tool, tool_use_id: id, input: e }, result.result, !!result.isError))
  return result
}
