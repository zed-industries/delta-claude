/**
 * `/delta join` and what a joined session keeps up: mounting the thread's worktrees, moving Claude
 * into them, Desktop hand-offs, and restoring and releasing mounts.
 */
import { activate, finishRestoredActivation, handedOff, pluginData } from '../setup/activation'
import { AccessRequiredError, requireAuthentication } from '../cli/auth'
import { finishProgress, setProgress } from '../band/band'
import { drain, endDeliveryFailures, flushUnsaved, isInDirectory, recoverExecution, verifyCheckout } from '../recording/delivery'
import { deliveryRetryDelay } from '../recording/delivery-policy'
import {
  type CommandForm, rememberContract, requireContract, resolveCli, stopSessionMounts, stopThreadMounts, threadMount,
  threadStatus,
} from '../cli/delta-cli'
import { type Handoff, HANDOFF_EXPIRY_MS, HANDOFF_PROMPT, newSessionLink, parseHandoff } from './handoff'
import { authenticationHost, OPEN_TIMEOUT_MS } from '../setup/interaction'
import {
  activeBackgroundAgents, joinPreflight, missingJoinCommands, releasesMounts, worktreeChanges,
} from './lifecycle'
import { samePath } from '../core/paths'
import {
  activation, type Binding, isPaused, key, load, recoveryCommand, report, requests, resumeCheckout, type Runtime, save,
  serial, sessions, type SessionState, stateFor, storedBinding,
} from '../core/session-state'
import {
  classifyCommandFailure, DeltaCommandError, type MountedThread, type ThreadState,
} from '../cli/thread-commands'
import { errorText } from '../core/text'
import { isRetrying, isCurrentReady, startConversation, statusFields, stopConversation } from '../watch/watch'
import { deliverNote, rowsHeld } from '../watch/rows'
import { releaseThreadMounts } from '../subagents/thread-runs'

/** A join to finish in a session; `owner` names a mount another session made for it to take over. */
export type JoinPlan = { session: string; cwd: string; locator: string; thread: string; owner?: string }
export type JoinRequest = {
  session: string; cwd: string; locator: string; fresh?: string; clearing?: boolean; cancelled?: boolean
  contractVersion?: number; form?: CommandForm
}
/** How often an offered hand-off is checked; the claiming session is another process. */
const HANDOFF_POLL_MS = 2_000

/**
 * Start a join: it is in progress from now, reported through the band, and runs on the clock, since
 * a timer leaves the active command before invoking commands that wait for idle.
 */
export function startJoin($: Runtime, request: JoinRequest) {
  requests.join = request
  setProgress($, 'Checking access to the shared thread…', 'active')
  $.clock.after(0, () => joinSession($, request))
}

async function joinSession($: Runtime, request: JoinRequest) {
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
    if (runtime.restoring || runtime.restoringCheckout)
      throw new Error("Wait for Delta to finish restoring this session's worktrees before joining")
    if (activeBackgroundAgents(await $.agent.list()))
      throw new Error('Stop background agents and teammates before joining; an idle main turn is not sufficient')
    // Refuse a CLI this plugin cannot record against before any transition, mount, or clear.
    await resolveCli($, (text) => setProgress($, text, 'active'))
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
      if (isRetrying()) await stopConversation()
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
    const target = fresh
    const transition = plan
    await serial(async () => {
      await assertJoinSession($, target, request)
      await save($, { session: target, snapshot: false, next: 1, pending: [], joinTransition: transition }, () => !request.cancelled)
    })
    await completeJoin($, fresh, plan, request)
  } catch (error) {
    if (request.cancelled) return
    const invalidLocator = error instanceof DeltaCommandError && error.code === 'invalid_reference'
    // Sign-in runs before the session changes, so an access requirement leaves nothing to preserve.
    const text = error instanceof AccessRequiredError && !fresh ? error.message : `Delta join failed: ${errorText(error)}. ${invalidLocator
      ? `The ${fresh ? 'fresh session' : 'previous session and folder'} was preserved. Use the thread's share link with /delta-join instead of retrying this locator.`
      : fresh
      ? `Fresh session ${fresh} was preserved. Retry /delta-join ${plan?.locator ?? request.locator} to finish the saved transition; the previous session is ${plan?.session ?? request.session} at ${plan?.cwd ?? request.cwd}.`
      : `The previous session and folder were preserved. Retry /delta-join ${request.locator}.`}`
    if (fresh) stateFor(fresh).joinFailure = text
    setProgress($, text, 'error')
    await $.ui.log(text, { to: 'transcript' })
  } finally {
    if (requests.join === request) requests.join = undefined
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
    try { return await threadStatus($, request.locator, request.session) }
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
  rememberContract(session, request.contractVersion!)
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
 * Keep the checkout of every worktree of a joined thread mounted for this session, as its thread's
 * attachments change, until this plugin process stops the mount.
 */
export async function mountThread(
  $: Runtime,
  binding: { session: string; thread?: string; locator?: string; owner?: string },
  options: { reportJoin?: boolean; form?: CommandForm } = {},
): Promise<MountedThread> {
  const locator = binding.locator ?? binding.thread
  if (!locator) throw new Error('This session has no thread to mount')
  return threadMount($, {
    session: binding.session, thread: binding.thread ?? locator, locator, owner: binding.owner ?? binding.session,
    join: !!options.reportJoin, form: options.form,
  })
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
  const mounted = await mountThread(
    $, { session: request.session, thread: status.thread_id, locator: request.locator, owner },
    { reportJoin: true, form: request.form },
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
    const opened = await $.process.run(['open', link], { timeoutMs: OPEN_TIMEOUT_MS }).catch((error) => ({ exitCode: 1, stderr: errorText(error) }))
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
export async function pendingHandoff($: Runtime, directory: string): Promise<Handoff | undefined> {
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
export async function claimHandoff($: Runtime, session: string, handoff: Handoff) {
  const request: JoinRequest = { session, cwd: handoff.directory, locator: handoff.locator }
  try {
    setProgress($, 'Joining the shared thread…', 'active')
    request.contractVersion = await requireContract($, session)
    await takeOverHandoff($, request, handoff)
  } catch (error) {
    if (request.cancelled) return
    const text = `Delta couldn't join the thread in this session: ${errorText(error)}. Run /delta-join ${handoff.locator} to retry.`
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
export function requireMounted(mounted: MountedThread, thread: string | undefined) {
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
export function beginRestore($: Runtime, session: string) {
  const runtime = stateFor(session)
  if (runtime.restoring) return
  runtime.restoring = true
  setProgress($, "Restoring the thread's worktrees…", 'active')
  const owns = () => activation.session === session && sessions.get(session) === runtime
  $.clock.after(0, async () => {
    try {
      await restoreMounts($, session, async () => {
        if (!owns()) throw new Error('The session ended while its worktrees were being restored')
      })
      const binding = await serial(() => load($, session))
      await startParticipation($, session, binding, owns)
      if (!owns()) return
      finishProgress($, `Restored ${binding.mounts?.length ?? 0} worktree${binding.mounts?.length === 1 ? '' : 's'}`, 'done')
      await finishRestoredActivation($, session, binding, owns)
    } catch (error) {
      if (!owns()) return
      const text = `Delta couldn't restore this session's worktrees: ${errorText(error)}. Retry ${recoveryCommand(runtime.binding)}; the prompt was not submitted.`
      runtime.joinFailure = text
      setProgress($, text, 'error')
      await $.ui.log(text, { to: 'transcript' })
    } finally {
      runtime.restoring = undefined
    }
  })
}

/** End this session's mount commands; Delta owns the bounded cleanup after they disconnect. */
async function releaseMounts($: Runtime, session: string) {
  try { await stopSessionMounts(session) }
  catch (error) { await $.ui.log(`Delta mount process did not stop: ${String(error)}`, { to: 'debug' }) }
}

/** Stop `owner`'s mount of `thread`, if this plugin process still holds it; a failure is only logged. */
export async function unmountThread($: Runtime, thread: string, owner: string) {
  try { await stopThreadMounts(owner) }
  catch (error) { await $.ui.log(`Delta could not stop ${thread}'s mount: ${String(error)}`, { to: 'debug' }) }
}

/** The worktrees of a joined thread changed: re-mount, then tell Claude and the person. */
export function refreshMounts($: Runtime, session: string, listed: { reference: string }[]) {
  const runtime = stateFor(session)
  runtime.mountRefresh = (runtime.mountRefresh ?? Promise.resolve())
    .then(() => applyWorktrees($, session, listed))
    .catch((error) => {
      if (activation.session !== session) return
      const text = `Delta couldn't update this session's worktrees: ${errorText(error)}`
      setProgress($, text, 'error')
      return $.ui.log(text, { to: 'transcript' })
    })
}

async function applyWorktrees($: Runtime, session: string, listed: { reference: string }[]) {
  const runtime = stateFor(session)
  if (activation.session !== session || !runtime.mounted) return
  const binding = await serial(() => load($, session))
  const previous = binding.mounts
  if (!binding.joined || !previous) return
  // Every reconnect reports the current list; most of those change nothing.
  if (listed.length === previous.length && listed.every((tree) => previous.some((mount) => mount.reference === tree.reference))) return
  const mounted = await mountThread($, binding)
  if (activation.session !== session || mounted.thread_id !== binding.thread) return
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

export function scheduleMove($: Runtime, session: string) {
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
    if (!directory || activation.session !== session || rowsHeld(session)) return
    const binding = await serial(() => load($, session))
    if (!binding.directory || !await isInDirectory($, binding.directory)) { runtime.moveTo = undefined; return }
    const check = async () => { if (activation.session !== session) throw new Error('The session ended during the move') }
    await enterDirectory($, session, directory, check)
    await serial(async () => save($, { ...await load($, session), directory }))
    runtime.moveTo = undefined
    resumeCheckout(runtime, 'verification')
    finishProgress($, 'Moved to the thread folder', 'done')
    await deliverNote($, session, `[Delta] This session's directory is now ${directory}. It links to each worktree of the thread.`)
    void drain($, session).catch((error) => report($, error))
  } catch (error) {
    runtime.moveTo = undefined
    if (activation.session !== session) return
    const text = `Delta couldn't move Claude to the thread folder ${directory}: ${errorText(error)}. The session stays where it is; /cd there to work across every worktree.`
    setProgress($, text, 'error')
    await $.ui.log(text, { to: 'transcript' })
  } finally {
    runtime.moving = undefined
  }
}

/** Check a joined session's mounts, then watch the thread; the watch lifts the watcher pause once live. */
export async function startParticipation($: Runtime, session: string, binding: Binding, owns: () => boolean) {
  if (binding.joined) await verifyCheckout($, binding)
  if (!owns()) return
  const ready = await startConversation($, session)
  if (owns() && isCurrentReady(ready)) resumeCheckout(stateFor(session), 'watcher')
}

/**
 * Exiting ends the session's use of its checkouts. A clear is the join's own transition and a resume
 * only switches sessions, so neither releases them. A conversation that moved to another session
 * keeps its checkouts there; its subagents' stay with this session and are released. An offered
 * hand-off nobody opened goes with the tab that offered it.
 */
export async function releaseOnEnd($: Runtime, session: string, reason: string, runtime: SessionState) {
  if (releasesMounts(reason)) {
    if (!await handedOff($, session)) await releaseMounts($, session)
    const ended = await storedBinding($, key(session)).catch(() => undefined)
    await releaseThreadMounts($, session, ended?.children ?? [])
  }
  const offered = runtime.offered
  runtime.offered = undefined
  if (offered && releasesMounts(reason)) await releaseHandoff($, offered, true)
}
