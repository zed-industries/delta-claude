/**
 * Running the Delta conversation's other threads here as Claude subagents, and adopting the subagents
 * a session ran before it was shared.
 */
import type { Timer } from 'claude-code'
import { type ChildBinding, childName, isAgentTool, recordsSubagent } from './children'
import { conversationText } from '../watch/conversation'
import { runningUpdate } from '../recording/delivery'
import { threadStatus, threadWatch, watchEvents } from '../cli/delta-cli'
import {
  adoptionPrompt, deltaTurnReport, finishedReport, HISTORY_BUDGET, historyText, isOwnItem, itemsSince,
  looksLikeThreadLink, namedThread, resumePrompt, threadsNote, type ThreadTarget,
} from './delta-threads'
import { claudeInteraction } from '../setup/interaction'
import { mountThread, requireMounted, unmountThread } from '../sharing/join'
import { hasInteractiveSurface } from '../sharing/lifecycle'
import { deliverNote } from '../watch/rows'
import { type Binding, boundDirectory, report, stateFor } from '../core/session-state'
import type { Host } from '../core/host'
import {
  addChild, children, type ChildRuntime, childStep, deliverChild, endChildTurn, loadChild, parentDirectories,
  recordChildMessage, rememberChild, reportChild, restoreClaudeWorktree, saveChild, snapshotChild, stageChildRecord,
  unlinkForResume,
} from './subagents'
import type { WatchChild, WatchItem } from '../cli/thread-commands'
import { feed, watchedSession } from '../watch/watch'

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
async function readThread(host: Host, reference: string): Promise<ThreadRead> {
  // Without a `proceed` check, a watch always starts.
  const stream = (await threadWatch(host, reference))!
  let expired = false
  const timer = host.clock.after(THREAD_READ_TIMEOUT_MS, () => {
    expired = true
    void stream.return({ code: null, signal: 'SIGTERM' }).catch(() => {})
  })
  const items = new Map<string, WatchItem>()
  let thread: string | undefined
  let worktrees: string[] | undefined
  let running: ThreadRead['running']
  let live = false
  let grace: Timer | undefined
  // Read only once live, and `live` is set only after `ready` named the thread.
  const result = (): ThreadRead => ({ thread_id: thread!, items: [...items.values()], worktrees: worktrees ?? [], running })
  try {
    for await (const event of watchEvents(stream)) {
      if (event.type === 'ready') thread = event.thread_id
      else if (event.type === 'item') items.set(event.item.id, event.item)
      else if (event.type === 'item.append') {
        const item = items.get(event.id)
        if (item) items.set(event.id, { ...item, content: { ...item.content, text: `${item.content.text ?? ''}${event.text}` } })
      } else if (event.type === 'remove') items.delete(event.id)
      else if (event.type === 'worktrees') worktrees = event.worktrees.map((tree) => tree.reference)
      else if (event.type === 'turn') running = event.state === 'running' ? { name: event.user?.name ?? null } : undefined
      else if (event.type === 'live') {
        if (!thread) throw new Error('Thread activity arrived before readiness')
        live = true
        grace = host.clock.after(THREAD_WORKTREES_GRACE_MS, () => {
          void stream.return({ code: null, signal: 'SIGTERM' }).catch(() => {})
        })
      }
      if (live && worktrees) return result()
    }
    if (live && !expired) return result()
    throw new Error(expired ? `reading the Delta thread ${reference} timed out` : `Delta could not read the thread ${reference}`)
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
async function childActor(host: Host, child: ChildRuntime): Promise<string | undefined> {
  const binding = await loadChild(host, child)
  if (binding.actorId || !binding.reference) return binding.actorId
  const actorId = (await threadStatus(host, binding.reference, child.agentId)).producer?.actor_id ?? undefined
  if (actorId) await childStep(host, child, async () => saveChild(host, { ...await loadChild(host, child), actorId }))
  return actorId
}

/**
 * Running a thread someone else is running takes it over, which only the person may decide: they are
 * asked, and a session that cannot ask leaves the thread alone. Returns why the send is refused, or
 * undefined to go ahead.
 */
async function takeoverRefusal(host: Host, name: string, running: { name: string | null }): Promise<string | undefined> {
  const who = conversationText(running.name ?? '').trim() || 'someone'
  const refusal = `The Delta thread "${name}" is running in Delta (${who}), so Claude left it alone. ` +
    'Try again once it is idle, or ask the person to let Claude take it over.'
  if (!hasInteractiveSurface(await host.session.surfaces())) return refusal
  try {
    const answer = await claudeInteraction(host).ask(
      `Claude wants to take over "${name}", which ${who} is running in Delta. Take it over?`,
      [TAKE_OVER, 'Leave it running'])
    return answer === TAKE_OVER ? undefined : refusal
  } catch {
    // No answer, or no one to ask, leaves the thread with whoever is running it.
    return refusal
  }
}

const TAKE_OVER = 'Take it over'

async function childForThread(host: Host, session: string, thread: string): Promise<ChildRuntime | undefined> {
  for (const child of children.values()) {
    if (child.session !== session) continue
    const binding = await loadChild(host, child).catch(() => undefined)
    if (binding?.thread === thread) return child
  }
}

/**
 * The thread a running adoption spawns a subagent for. `agentId` is set once the subagent is adopted:
 * when the spawn answers with it, or at the first hook the subagent's loop raises, which can run first.
 * `adopted` tells the waiting adoption.
 */
type Adoption = { session: string; binding: Omit<ChildBinding, 'agentId'>; text: string; agentId?: string; adopted?: () => void }
let adoption: Adoption | undefined

/**
 * Whether an agent Claude lists with `description` is the one a running adoption is spawning, which is
 * described by its thread's name. Claude lists no plugin as the spawner of a plugin's own spawn.
 */
export function isAdoptionSpawn(description: string): boolean {
  return adoption !== undefined && adoption.agentId === undefined && adoption.binding.name === description
}
/** How long an adoption whose spawn answered without the agent's ID waits for the agent's first hook. */
const ADOPTION_WAIT_MS = 5_000

/**
 * Run a thread `to` names with `text`, or leave the send to Claude: undefined when `to` names no
 * thread. A subagent already recorded for the thread is resumed by Claude's own delivery, readdressed
 * to it; any other thread gets a subagent here.
 */
export async function sendToThread(host: Host, session: string, sender: string, to: string, text: string,
    next: (to: string, text: string) => Promise<{ isDelivered: true } | { isDelivered: false; reason: string }>) {
  let child = children.get(to)
  if (child && child.session !== session) child = undefined
  let target: ThreadTarget | undefined
  if (!child) {
    const listed = watchedSession() === session ? namedThread(to, feed.children) : undefined
    if (listed) {
      child = await childForThread(host, session, listed.thread_id)
      if (!child && listed.reference) target = { reference: listed.reference, name: listed.name, thread_id: listed.thread_id }
    } else if (looksLikeThreadLink(to)) target = { reference: to.trim(), name: to.trim() }
    else {
      const named = [...children.values()].filter((candidate) => candidate.session === session)
      for (const candidate of named) {
        const binding = await loadChild(host, candidate).catch(() => undefined)
        if (binding?.name.trim().toLowerCase() === to.trim().toLowerCase()) { child = candidate; break }
      }
    }
  }
  if (child) return resumeThread(host, child, sender, text, next)
  if (target) return runThread(host, session, sender, target, text)
}

/**
 * Message a recorded subagent: one running now gets it in its turn, recorded there; a finished one
 * resumes with it, after what happened in its thread in Delta since it last ran.
 */
async function resumeThread(host: Host, child: ChildRuntime, sender: string, text: string,
    next: (to: string, text: string) => Promise<{ isDelivered: true } | { isDelivered: false; reason: string }>) {
  const binding = await loadChild(host, child)
  if (binding.execution) {
    const result = await next(child.agentId, text)
    // Claude hands a running loop the message as a row this plugin does not record, so it is recorded here.
    if (result.isDelivered)
      await childStep(host, child, () =>
        recordChildMessage(host, child, { role: 'user', content: [{ type: 'text', text }] }, `send:${crypto.randomUUID()}`))
    return result
  }
  let prompt = text
  if (binding.reference) {
    try {
      const read = await readThread(host, binding.reference)
      const refusal = read.running && await takeoverRefusal(host, binding.name, read.running)
      if (refusal) return { isDelivered: false as const, reason: refusal }
      const since = itemsSince(read.items, await childActor(host, child))
      prompt = resumePrompt(binding.name, historyText(since, binding.reference, HISTORY_BUDGET), text)
      const last = read.items.at(-1)
      if (last) await childStep(host, child, async () => saveChild(host, { ...await loadChild(host, child), reportedItem: last.id }))
    } catch (error) { await reportChild(host, child, error) }
  }
  // The resumed run is prompted by the loop that sent the message, and runs in the background.
  child.sender = sender
  child.foreground = false
  child.promptText = text
  await unlinkForResume(host, child)
  const result = await next(child.agentId, prompt)
  if (!result.isDelivered) child.promptText = undefined
  return result
}

/**
 * Start a subagent on a thread Claude never ran: it begins from the thread's history and works where
 * the thread's worktrees are, in this session's checkout when it shares them, else in a mount of its
 * own. Claude reports nothing of a subagent a plugin starts, so the parent is told its reply here.
 */
async function runThread(host: Host, session: string, sender: string, target: ThreadTarget, text: string) {
  const read = await readThread(host, target.reference)
  if (await childForThread(host, session, read.thread_id))
    return { isDelivered: false as const, reason: `Claude already runs the Delta thread "${target.name}"; message it by that name.` }
  const refusal = read.running && await takeoverRefusal(host, target.name, read.running)
  if (refusal) return { isDelivered: false as const, reason: refusal }
  if (!read.worktrees.length)
    return { isDelivered: false as const, reason: `The Delta thread "${target.name}" has no worktree for Claude to work in.` }
  const name = target.name === target.reference
    ? (await threadStatus(host, target.reference, session).catch(() => undefined))?.title?.trim() || 'Delta thread'
    : target.name
  const root = stateFor(session).binding
  const rootWorktrees = watchedSession() === session ? feed.worktrees ?? [] : []
  const shares = read.worktrees.every((tree) => rootWorktrees.includes(tree))
  let cwd: string | undefined
  let directories: string[]
  let mountOwner: string | undefined
  if (shares) {
    cwd = boundDirectory(root)
    directories = await parentDirectories(host, { session, parent: session })
  } else {
    mountOwner = `${session}-${read.thread_id.slice(-12)}`
    const mounted = await mountThread(host, { session, thread: read.thread_id, locator: target.reference, owner: mountOwner })
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
  const adopting: Adoption = { session, binding, text }
  adoption = adopting
  try {
    const adopted = new Promise<void>((resolve) => { adopting.adopted = resolve })
    const spawned = await host.agent.spawn({ prompt, description: name, subagentType: 'general-purpose', cwd })
    if ('deny' in spawned) return { isDelivered: false as const, reason: String(spawned.deny) }
    if (spawned.agentId) adoptThread(host, spawned.agentId)
    else if (adopting.agentId === undefined) {
      // Claude Code 2.1.309 answers with the agent's ID, but the engine's test host answers a plugin's own
      // spawn without it, so the agent's first hook names it instead.
      const expiry = new AbortController()
      await Promise.race([adopted, host.clock.sleep(ADOPTION_WAIT_MS, { signal: expiry.signal }).catch(() => undefined)])
      expiry.abort()
    }
    // A hook that answers the spawn without starting a subagent leaves nothing to run the thread.
    if (adopting.agentId === undefined)
      return { isDelivered: false as const, reason: `Claude started no subagent to run the Delta thread "${name}".` }
    return { isDelivered: true as const }
  } finally {
    adoption = undefined
  }
}

/**
 * Record the subagent `agentId` a thread's running adoption spawned as that thread's, once, and return
 * it; undefined when no adoption is running. Saving is the child's first step, so none of its steps can
 * run before its state exists.
 */
export function adoptThread(host: Host, agentId: string): ChildRuntime | undefined {
  const adopting = adoption
  if (!adopting || (adopting.agentId !== undefined && adopting.agentId !== agentId)) return
  adopting.agentId = agentId
  adopting.adopted?.()
  const known = children.get(agentId)
  if (known) return known
  const child = addChild(adopting.session, agentId, adopting.binding.parent, false)
  child.promptText = adopting.text
  void childStep(host, child, async () => {
    await saveChild(host, { ...adopting.binding, agentId })
    await rememberChild(host, adopting.session, agentId)
  })
  void deliverChild(host, child)
  return child
}

/** Tell the parent the reply of a thread it is waiting on, as Claude tells it a subagent's. */
async function reportReply(host: Host, session: string, text: string) {
  try { await host.prompt.submit({ text }) }
  catch (error) {
    // A host that takes no plugin prompt still gets the reply into Claude's context.
    await host.ui.log(`Couldn't hand Claude a Delta thread's reply: ${String(error)}`, { to: 'debug' })
    await deliverNote(host, session, text)
  }
}

/** A thread the plugin started Claude on finished its first run: Claude says nothing of it, so the parent is told. */
export async function reportClaudeRun(host: Host, child: ChildRuntime) {
  let awaited = false
  let name = ''
  await childStep(host, child, async () => {
    const binding = await loadChild(host, child)
    if (binding.awaited !== 'claude') return
    awaited = true
    name = binding.name
    const { awaited: _, ...rest } = binding
    await saveChild(host, rest)
  })
  if (!awaited) return
  const messages = await host.session.agentMessages({ agentId: child.agentId })
  const reply = Array.isArray(messages)
    ? messages.filter((message) => message.role === 'assistant' && message.text.trim()).at(-1)?.text : undefined
  await reportReply(host, child.session, finishedReport(name, reply?.trim()))
}

/** Per session, the last status each thread of its watched conversation reported, to see a turn of it end. */
const threadStatuses = new Map<string, Map<string, string>>()
/** Per session, the names of the threads its parent was last told it can message. */
const notedThreads = new Map<string, string>()

/** An ended session forgets its threads' statuses and which of them its parent was told about. */
export function forgetThreadNotes(session: string) {
  threadStatuses.delete(session)
  notedThreads.delete(session)
}

/**
 * Follow the conversation's threads: tell the parent which it can message when that changes, and
 * when a turn Delta's agent ran in a thread this session runs ends, what it said.
 */
export function observeThreads(host: Host, session: string) {
  let statuses = threadStatuses.get(session)
  if (!statuses) threadStatuses.set(session, statuses = new Map())
  for (const thread of feed.children) {
    const before = statuses.get(thread.thread_id)
    statuses.set(thread.thread_id, thread.status)
    if (before === 'running' && thread.status !== 'running' && thread.status !== 'queued' && thread.reference)
      void reportDeltaTurn(host, session, thread).catch((error) => report(host, error))
  }
  const listed = feed.children.filter((thread) => thread.reference).map((thread) => ({ name: thread.name, status: thread.status }))
  const names = JSON.stringify(listed.map((thread) => thread.name).sort())
  if (names !== notedThreads.get(session) && listed.length) {
    notedThreads.set(session, names)
    const note = threadsNote(listed)
    if (note) void deliverNote(host, session, note).catch((error) => report(host, error))
  }
}

/**
 * A thread this session runs finished a turn that was not Claude's: tell the parent what Delta said,
 * starting a turn when it waits on that thread, else as context for its next one.
 */
async function reportDeltaTurn(host: Host, session: string, thread: WatchChild) {
  const child = await childForThread(host, session, thread.thread_id)
  if (!child) return
  const binding = await loadChild(host, child)
  if (binding.execution || !binding.reference) return
  const read = await readThread(host, binding.reference)
  const actor = await childActor(host, child)
  // A turn of Claude's own ending is no news to the parent.
  const lastTurn = [...read.items].reverse().find((item) => item.turn_id !== null)
  if (!lastTurn || isOwnItem(lastTurn, actor)) return
  let since = itemsSince(read.items, actor)
  const reported = since.findIndex((item) => item.id === binding.reportedItem)
  if (reported >= 0) since = since.slice(reported + 1)
  const text = deltaTurnReport(binding.name, since, binding.reference)
  let awaited = false
  await childStep(host, child, async () => {
    const current = await loadChild(host, child)
    awaited = current.awaited === 'delta'
    const { awaited: _, ...rest } = current
    await saveChild(host, { ...rest, ...read.items.length ? { reportedItem: read.items.at(-1)!.id } : {} })
  })
  if (!text) return
  if (awaited) await reportReply(host, session, text)
  else await deliverNote(host, session, text)
}

/** Release the mounts this session made for threads it ran, when it ends. */
export async function releaseThreadMounts(host: Host, session: string, agentIds: readonly string[]) {
  for (const agentId of agentIds) {
    const binding = await loadChild(host, { session, agentId }).catch(() => undefined)
    // Claude's worktree takes back its place before the fork its link leads to goes.
    if (binding?.claudeWorktree) await restoreClaudeWorktree(host, binding.claudeWorktree).catch((error) => report(host, error))
    if (binding?.mountOwner && binding.reference) await unmountThread(host, binding.reference, binding.mountOwner)
  }
}

/**
 * Load a session's recorded children after a restart: close turns this process never saw run and
 * deliver what they queued.
 */
export async function restoreChildren(host: Host, session: string, binding: Binding) {
  for (const agentId of binding.children ?? []) {
    if (children.has(agentId)) continue
    let stored: ChildBinding
    try { stored = await loadChild(host, { session, agentId }) }
    catch (error) { await report(host, error); continue }
    const child = addChild(session, agentId, stored.parent, false)
    const execution = stored.execution
    if (execution) void childStep(host, child, () => endChildTurn(host, child, execution.turnId, 'cancelled'))
    // Delivering also detaches a checkout a run that ended without its hook left attached.
    void deliverChild(host, child)
  }
}

/**
 * Record the agents that already ran when this session starts recording. A finished agent's
 * transcript is recorded now; a running one's when its run ends. Teammates and forks stay unrecorded.
 */
export async function adoptExistingChildren(host: Host, session: string) {
  const recorded = new Set<string>()
  // Each agent is adopted after the agent that spawned it, whatever order the list has.
  let waiting = (await existingAgents(host)).filter(recordsSubagent)
  for (let progress = true; progress;) {
    progress = false
    const ready = waiting.filter((agent) => agent.parentId === undefined || recorded.has(agent.parentId))
    waiting = waiting.filter((agent) => !ready.includes(agent))
    for (const agent of ready) {
      progress = true
      await adoptExistingChild(host, session, agent)
      recorded.add(agent.id)
    }
  }
  // A run that ended between the list and its adoption heard no `turn.complete` here, so its
  // transcript is read now rather than at an end that already passed.
  const running = new Set((await host.agent.list()).filter((agent) => agent.status === 'running').map((agent) => agent.id))
  for (const agentId of recorded) {
    const child = children.get(agentId)
    if (!child || running.has(agentId)) continue
    await childStep(host, child, () => endChildTurn(host, child, undefined, undefined))
  }
}

type ExistingAgent = Awaited<ReturnType<Host['agent']['list']>>[number]

/**
 * The agents this session ran: those Claude lists, and those its main transcript's Agent calls name.
 * A finished foreground agent is no longer listed, but its call's result still names it.
 */
async function existingAgents(host: Host): Promise<ExistingAgent[]> {
  const agents = new Map((await host.agent.list()).map((agent) => [agent.id, agent] as const))
  for (const row of await host.session.messages()) {
    for (const use of row.toolUses) {
      if (!isAgentTool(use.tool)) continue
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
async function adoptExistingChild(host: Host, session: string, agent: ExistingAgent) {
  const parent = agent.parentId ?? session
  // The turns that would say where it works already started, so its spawn call tells instead.
  const spawn = await spawnPlacement(host, agent)
  const shares = !spawn.apart
  let binding: ChildBinding = {
    session, agentId: agent.id, parent, name: childName({ name: agent.name, description: agent.description }),
    next: 1, pending: [], sharesParentCheckout: shares,
    directories: shares ? await parentDirectories(host, { session, parent }) : [],
    ...agent.status === 'running' ? { awaitingSnapshot: true as const } : {},
    ...agent.status !== 'running' && spawn.worktree ? { checkout: spawn.worktree } : {},
  }
  if (binding.awaitingSnapshot) {
    const sequence = binding.next
    binding = await stageChildRecord(host, binding, { turnSequence: sequence, update: await runningUpdate(host) })
    binding.execution = { sequence }
    binding.lastTurnSequence = sequence
  }
  await saveChild(host, binding)
  await rememberChild(host, session, agent.id)
  const child = addChild(session, agent.id, parent, false)
  if (binding.awaitingSnapshot) void deliverChild(host, child)
  else {
    await childStep(host, child, async () => { await snapshotChild(host, child, binding) })
    void deliverChild(host, child)
  }
}

/**
 * Where the call that spawned an agent ran it: apart from its parent's checkout, in an isolated
 * worktree or a directory of its own, and the worktree Claude kept for it once it finished. An agent
 * whose call is not found shares its parent's.
 */
async function spawnPlacement(host: Host, agent: ExistingAgent): Promise<{ apart: boolean; worktree?: string }> {
  const rows = await host.session.agentMessages(agent.parentId ? { agentId: agent.parentId } : {})
  // The engine refuses an agent's transcript it cannot read; its call is then not found.
  if (!Array.isArray(rows)) return { apart: false }
  for (const row of rows) {
    for (const use of row.toolUses) {
      const result = use.result as Record<string, unknown> | undefined
      if (isAgentTool(use.tool) && result?.agentId === agent.id) {
        const worktree = typeof result.worktreePath === 'string' && result.worktreePath ? result.worktreePath : undefined
        return { apart: use.input.isolation === 'worktree' || typeof use.input.cwd === 'string', ...worktree ? { worktree } : {} }
      }
    }
  }
  return { apart: false }
}
