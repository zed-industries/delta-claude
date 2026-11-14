/**
 * `/delta join` and what a joined session keeps up: mounting the thread's worktrees, moving Claude
 * into the first and adding the others, Desktop hand-offs, and restoring and releasing mounts.
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
  activeBackgroundAgents, joinPreflight, missingJoinCommands, releasesMounts,
  type SessionDirectories, sessionDirectories, sessionSurfaces, worktreeChanges,
} from './lifecycle'
import { samePath } from '../core/paths'
import {
  activation, type Binding, isPaused, key, load, recoveryCommand, report, requests, resumeCheckout, save,
  serial, sessions, type SessionState, stateFor, storedBinding,
} from '../core/session-state'
import type { Host } from '../core/host'
import {
  classifyCommandFailure, DeltaCommandError, type MountedThread, type ThreadMount, type ThreadState,
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
export function startJoin(host: Host, request: JoinRequest) {
  requests.join = request
  setProgress(host, 'Checking access to the shared thread…', 'active')
  host.clock.after(0, () => joinSession(host, request))
}

async function joinSession(host: Host, request: JoinRequest) {
  let plan: JoinPlan | undefined
  let fresh: string | undefined
  try {
    await assertJoinSession(host, request.session, request)
    if (!samePath(await host.session.cwd(), request.cwd))
      throw new Error('The session or folder changed while join was queued; retry from the intended session')
    const pending = await load(host, request.session)
    const runtime = stateFor(request.session)
    if (runtime.currentTurnId || runtime.promptEntering)
      throw new Error('Wait for Claude to become idle before joining')
    if (runtime.restoring || runtime.restoringCheckout)
      throw new Error("Wait for Delta to finish restoring this session's worktrees before joining")
    if (activeBackgroundAgents(await host.agent.list()))
      throw new Error('Stop background agents and teammates before joining; an idle main turn is not sufficient')
    // Refuse a CLI this plugin cannot record against before any transition, mount, or clear.
    await resolveCli(host, (text) => setProgress(host, text, 'active'))
    // `/clear` ends the old session and removes its cached contract before the fresh session mounts.
    request.contractVersion = await requireContract(host, request.session)
    const check = async () => {
      await assertJoinSession(host, request.session, request)
      if (await host.session.cwd() !== request.cwd)
        throw new Error('The folder changed during sign-in; retry join from the intended folder')
    }
    await requireAuthentication(await authenticationHost(host), await resolveCli(host), check, async (text) => {
      await check()
      setProgress(host, 'Waiting for Delta sign-in…', 'active')
      await host.ui.log(text, { to: 'transcript' })
    })
    await check()
    if (pending.joinTransition) {
      plan = pending.joinTransition
      fresh = request.session
      request.fresh = fresh
      if (plan.locator !== request.locator) throw new Error('Retry the pending join with its original locator')
      await completeJoin(host, fresh, plan, request)
      return
    }
    let status = pending.joined ? await readJoinStatus(host, request) : undefined
    await assertJoinSession(host, request.session, request)
    if (pending.joined && status?.thread_id === pending.thread) {
      // Resolve aliases by canonical identity; never replace this producer with an empty frontier.
      setProgress(host, 'Reconnecting to the shared thread…', 'active')
      await restoreMounts(host, request.session, () => assertJoinSession(host, request.session, request))
      await verifyCheckout(host, await load(host, request.session))
      await assertJoinSession(host, request.session, request)
      if (runtime.unsaved.length) await flushUnsaved(host, request.session)
      const binding = await load(host, request.session)
      await assertJoinSession(host, request.session, request)
      if (runtime.captureFailure || binding.captureFailure)
        throw new Error(`a stored Claude row could not be saved locally (${runtime.captureFailure ?? binding.captureFailure}); restore the outbox before retrying`)
      resumeCheckout(runtime, 'delivery')
      endDeliveryFailures(runtime)
      if (isRetrying()) await stopConversation()
      await assertJoinSession(host, request.session, request)
      await startConversation(host, request.session)
      await recoverExecution(host, request.session)
      await drain(host, request.session)
      await assertJoinSession(host, request.session, request)
      await verifyCheckout(host, await load(host, request.session))
      if (isPaused(runtime) || runtime.unsaved.length)
        throw new Error('Joined participation remains paused; saved records remain queued')
      // The band reports the rejoin through the finished notice; the transcript keeps only conversation.
      host.ui.log(`Reconnected to the joined Delta thread in Claude session ${request.session}; the checkout and producer state were preserved.`, { to: 'debug' })
      finishProgress(host, 'Joined the shared thread', 'done')
      return
    }
    // Claude Code Desktop has no `/cd`, applies its own folder tool's move only when a model turn
    // ends, which a join run from a command never has, and never moves a worktree session at all.
    // So a Desktop join starts a new session in the thread's first worktree's checkout instead.
    const handsOff = await inDesktop(host)
    // `/delta join` is the request, and the fresh session leaves this one resumable, so the only
    // question is Claude's own folder trust prompt.
    if (!handsOff) await requireJoinCommands(host, ['clear', 'cd'])
    await assertJoinSession(host, request.session, request)
    status ??= await readJoinStatus(host, request)
    await assertJoinSession(host, request.session, request)
    if (joinPreflight(status) === 'access')
      throw new Error('Joining requires authenticated access to an already shared thread; check your Delta sign-in and link')
    // Only the fresh session can own the mount, so mounting waits for it. Refuse here what a mount
    // could never satisfy, while the old session is still untouched.
    if (joinPreflight(status) === 'empty')
      throw new Error('This thread has no worktree to join')
    if (handsOff) {
      const handoff = await pendingHandoff(host, request.cwd)
      if (handoff?.thread === status.thread_id) await takeOverHandoff(host, request, handoff)
      else await offerHandoff(host, request, status)
      return
    }
    plan = { session: request.session, cwd: request.cwd, locator: request.locator, thread: status.thread_id }
    if (await host.session.id() !== request.session || !samePath(await host.session.cwd(), request.cwd))
      throw new Error('The session or folder changed during the access check; nothing was changed')
    if (activeBackgroundAgents(await host.agent.list()))
      throw new Error('A background agent started during the access check; stop it before retrying')
    await assertJoinSession(host, request.session, request)
    setProgress(host, 'Starting a fresh Claude session…', 'active')
    request.clearing = true
    try { await host.command.run({ command: 'clear' }) }
    finally { request.clearing = false }
    fresh = await host.session.id()
    if (fresh === request.session) {
      fresh = undefined
      throw new Error('Claude did not create a fresh session after /clear; the old binding was not replaced')
    }
    request.fresh = fresh
    await assertJoinSession(host, fresh, request)
    if ((await load(host, fresh)).snapshot)
      throw new Error('The new Claude session already has a binding; it was not replaced')
    // Persist a blocking retry state, not a completed binding in the wrong directory.
    const target = fresh
    const transition = plan
    await serial(async () => {
      await assertJoinSession(host, target, request)
      await save(host, { session: target, snapshot: false, next: 1, pending: [], joinTransition: transition }, () => !request.cancelled)
    })
    await completeJoin(host, fresh, plan, request)
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
    setProgress(host, text, 'error')
    await host.ui.log(text, { to: 'transcript' })
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
async function readJoinStatus(host: Host, request: JoinRequest) {
  const deadline = await host.clock.now() + JOIN_RETRY_BUDGET_MS
  for (let attempt = 0; ; attempt++) {
    try { return await threadStatus(host, request.locator, request.session) }
    catch (error) {
      const delay = deliveryRetryDelay(attempt, error instanceof DeltaCommandError ? error.hints.retryAfterMs : undefined)
      if (classifyCommandFailure(error) !== 'transient' || await host.clock.now() + delay > deadline) throw error
      setProgress(host, 'Waiting for Delta to connect…', 'active')
      await host.clock.sleep(delay)
      await assertJoinSession(host, request.session, request)
    }
  }
}

async function assertJoinSession(host: Host, session: string, request: JoinRequest) {
  if (request.cancelled || await host.session.id() !== session)
    throw new Error('The Claude session changed during join; the obsolete transition was stopped')
}

/** Check actual host capabilities before any destructive session transition. */
async function requireJoinCommands(host: Host, names: string[]) {
  const commands = await host.command.list()
  const missing = missingJoinCommands(names, commands)
  if (missing.length)
    throw new Error(`This Claude host does not expose the built-in ${missing.map((name) => `/${name}`).join(' and ')} command required to join; the saved session and mount plan were preserved`)
}

/** Complete only the saved fresh session's transition, never clear again on retry. */
async function completeJoin(host: Host, session: string, plan: JoinPlan, request: JoinRequest) {
  // This session runs against the same CLI build `join` already verified for this process; `/clear`
  // removed the old session's verification before this fresh one started.
  rememberContract(session, request.contractVersion!)
  const check = () => assertJoinSession(host, session, request)
  await check()
  setProgress(host, "Mounting the thread's worktrees…", 'active')
  const mounted = await mountThread(
    host, { session, thread: plan.thread, locator: plan.locator, owner: plan.owner },
    { reportJoin: !plan.owner, form: request.form },
  )
  await check()
  requireMounted(mounted, plan.thread)
  const directories = sessionDirectories(mounted, await desktopRoot(host))
  // Remember the verified destination even if Claude refuses /cd; the retry notice must name it.
  await serial(async () => {
    await check()
    await save(host, { ...await load(host, session), directory: directories.workingDirectory },
      () => !request.cancelled)
  })
  await enterDirectories(host, session, directories, mounted.worktrees, check)
  const binding: Binding = {
    session, thread: plan.thread, locator: plan.locator, joined: true,
    owner: plan.owner ?? session, directory: directories.workingDirectory, mounts: mounted.worktrees,
    // snapshot means live recording is enabled, not that old history must be exported.
    snapshot: true, next: 1, pending: [],
  }
  const status = await verifyCheckout(host, binding)
  await check()
  Object.assign(binding, statusFields(status))
  await serial(async () => {
    await check()
    await save(host, binding, () => !request.cancelled)
  })
  stateFor(session).mounted = true
  await check()
  // Neither session.start nor classic.SessionStart is relied upon after clear/cd.
  setProgress(host, 'Connecting to the shared thread…', 'active')
  await activate(host, session, () => !request.cancelled)
  await check()
  await startConversation(host, session)
  // The band reports the join through the finished notice; the way back to the previous session stays in the debug log.
  host.ui.log(plan.owner
    ? `Joined Delta in Claude session ${session} at ${directories.workingDirectory}, taking over mount owner ${plan.owner}.`
    : `Joined Delta in fresh Claude session ${session} at ${directories.workingDirectory}. Resume the previous session with claude --resume ${plan.session} from ${plan.cwd}.`,
    { to: 'debug' })
  finishProgress(host, 'Joined the shared thread', 'done')
}

/**
 * Keep the checkout of every worktree of a joined thread mounted for this session, as its thread's
 * attachments change, until this plugin process stops the mount.
 */
export async function mountThread(
  host: Host,
  binding: { session: string; thread?: string; locator?: string; owner?: string },
  options: { reportJoin?: boolean; form?: CommandForm } = {},
): Promise<MountedThread> {
  const locator = binding.locator ?? binding.thread
  if (!locator) throw new Error('This session has no thread to mount')
  return threadMount(host, {
    session: binding.session, thread: binding.thread ?? locator, locator, owner: binding.owner ?? binding.session,
    join: !!options.reportJoin, form: options.form,
  })
}

function handoffPath(owner: string) { return `${pluginData}/handoffs/${owner}.json` }

/**
 * Hand a Desktop tab's join to a new Desktop session: mount the thread under an owner of its own,
 * record the hand-off, and open Desktop's new-session screen on the checkout a joined session works
 * in. Nothing in this tab changes.
 */
async function offerHandoff(host: Host, request: JoinRequest, status: ThreadState) {
  const owner = `desktop-${crypto.randomUUID()}`
  const check = () => assertJoinSession(host, request.session, request)
  setProgress(host, "Mounting the thread's worktrees…", 'active')
  const mounted = await mountThread(
    host, { session: request.session, thread: status.thread_id, locator: request.locator, owner },
    { reportJoin: true, form: request.form },
  )
  // A new-session link names one folder; the session asks the person to add the other checkouts.
  const directory = sessionDirectories(mounted).workingDirectory
  const handoff: Handoff = {
    owner, thread: status.thread_id, locator: request.locator, directory, created: await host.clock.now(),
  }
  const worktree = mounted.worktrees.find((tree) => samePath(tree.directory, directory))
  const place = worktree ? `"${worktree.name}" worktree` : 'folder'
  try {
    await check()
    requireMounted(mounted, status.thread_id)
    await host.fs.write(handoffPath(owner), JSON.stringify(handoff))
    const link = newSessionLink(directory, HANDOFF_PROMPT)
    const opened = await host.process.run(['open', link], { timeoutMs: OPEN_TIMEOUT_MS }).catch((error) => ({ exitCode: 1, stderr: errorText(error) }))
    stateFor(request.session).offered = handoff
    const thread = status.title?.trim() ? `“${status.title.trim()}”` : 'the thread'
    if (opened.exitCode === 0)
      setProgress(host, `Press Enter in the new Claude Code Desktop session to join ${thread} there; this tab stays as it is. Desktop may ask you to trust the thread's ${place}. It waits 5 minutes.`, 'active')
    else {
      // Opening links from a plugin needs macOS's `open`; anywhere else the person opens it.
      setProgress(host, `Open the link in this transcript, then press Enter in the new session to join ${thread} there. It waits 5 minutes.`, 'active')
      await host.ui.log(`Open this link to start a Claude Code session in the Delta thread's ${place}: ${link}`, { to: 'transcript' })
    }
    host.clock.after(HANDOFF_POLL_MS, () => watchHandoff(host, request.session, handoff))
  } catch (error) {
    await releaseHandoff(host, handoff)
    throw error
  }
}

/** Follow an offered hand-off until a new session claims it, or release it once it expires. */
async function watchHandoff(host: Host, session: string, handoff: Handoff) {
  const runtime = stateFor(session)
  if (runtime.offered !== handoff) return
  if (!await host.fs.exists(handoffPath(handoff.owner))) {
    runtime.offered = undefined
    finishProgress(host, 'Opened the thread in a new session', 'done')
    return
  }
  if (await host.clock.now() - handoff.created < HANDOFF_EXPIRY_MS) {
    host.clock.after(HANDOFF_POLL_MS, () => watchHandoff(host, session, handoff))
    return
  }
  runtime.offered = undefined
  await releaseHandoff(host, handoff)
  const text = `No session joined the Delta thread within 5 minutes, so Delta released its checkouts. Run /delta-join ${handoff.locator} to bring it back.`
  finishProgress(host, text, 'done')
  await host.ui.log(text, { to: 'transcript' })
}

/**
 * Release a hand-off's mount and record. With `onlyUnclaimed`, a record a new session already
 * removed means that session owns the mount now, and nothing is released.
 */
async function releaseHandoff(host: Host, handoff: Handoff, onlyUnclaimed = false) {
  if (onlyUnclaimed && !await host.fs.exists(handoffPath(handoff.owner)).catch(() => true)) return
  await host.process.run(['rm', '-f', '--', handoffPath(handoff.owner)]).catch(() => undefined)
  await unmountThread(host, handoff.locator, handoff.owner)
}

/** The hand-off offered for a session starting in `directory`, if any. */
export async function pendingHandoff(host: Host, directory: string): Promise<Handoff | undefined> {
  const folder = `${pluginData}/handoffs`
  if (!await host.fs.exists(folder)) return
  for (const entry of await host.fs.list(folder)) {
    if (!entry.name.endsWith('.json')) continue
    let text: string
    try { text = await host.fs.read(`${folder}/${entry.name}`) } catch { continue }
    const handoff = parseHandoff(text)
    if (handoff && samePath(handoff.directory, directory)) return handoff
  }
}

/**
 * Join a hand-off in the session that started in its folder, before the first prompt arrives.
 * Failure is reported in the band and transcript, and holds prompts until /delta join is retried.
 */
export async function claimHandoff(host: Host, session: string, handoff: Handoff) {
  const request: JoinRequest = { session, cwd: handoff.directory, locator: handoff.locator }
  try {
    setProgress(host, 'Joining the shared thread…', 'active')
    request.contractVersion = await requireContract(host, session)
    await takeOverHandoff(host, request, handoff)
  } catch (error) {
    if (request.cancelled) return
    const text = `Delta couldn't join the thread in this session: ${errorText(error)}. Run /delta-join ${handoff.locator} to retry.`
    stateFor(session).joinFailure = text
    setProgress(host, text, 'error')
    await host.ui.log(text, { to: 'transcript' })
  }
}

/**
 * Join in the session a hand-off started in the thread's folder: claim the record first, so the
 * offering tab's expiry cannot release the mount, then take the mount over under the same owner
 * and join without clearing or moving.
 */
async function takeOverHandoff(host: Host, request: JoinRequest, handoff: Handoff) {
  await host.process.run(['rm', '-f', '--', handoffPath(handoff.owner)])
  await completeJoin(host, request.session, {
    session: request.session, cwd: request.cwd, locator: handoff.locator, thread: handoff.thread, owner: handoff.owner,
  }, request)
}

/** What a mount that joining or restoring can use: the right thread, and something to work in. */
export function requireMounted(mounted: MountedThread, thread: string | undefined) {
  if (mounted.thread_id !== thread) throw new Error('Delta mounted a different thread; no session transition was attempted')
  if (!mounted.worktrees.length) throw new Error('This thread has no worktree to join')
}

async function inDesktop(host: Host) {
  return (await sessionSurfaces(host)).includes('desktop')
}

/** In Claude Code Desktop, which has no `/cd`, the directory the session started in and has to stay in. */
async function desktopRoot(host: Host): Promise<string | undefined> {
  return await inDesktop(host) ? host.session.root() : undefined
}

/**
 * Put Claude in a working directory and add the additional ones. Claude asks before adding each,
 * and forgets them when the session ends, so a resumed session adds them again. In Desktop the
 * person adds them.
 */
async function enterDirectories(
  host: Host, session: string, directories: SessionDirectories, mounts: readonly ThreadMount[],
  check: () => Promise<void>, reason: 'join' | 'added' = 'join',
) {
  const name = (path: string) => mounts.find((mount) => samePath(mount.directory, path))?.name
  const working = name(directories.workingDirectory)
  await enterDirectory(host, session, directories.workingDirectory,
    working ? `the "${working}" worktree` : "the thread's folder", check)
  const count = directories.additionalDirectories.length
  if (!count) return
  // Desktop runs no `/add-dir` a plugin asks for ("no command named /add-dir in this session"), but
  // runs one the person types.
  const desktop = await inDesktop(host)
  if (!desktop) await requireJoinCommands(host, ['add-dir'])
  await host.env.setAdditionalDirectoriesClaudeMd()
  await check()
  const names = directories.additionalDirectories.map((path) => `"${name(path) ?? path}"`)
  const listed = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]
  const worktrees = `${listed} ${count === 1 ? 'worktree' : 'worktrees'}`
  if (desktop) {
    const them = count === 1 ? 'it' : 'them'
    const refusal = reason === 'added'
      ? `The ${worktrees} ${count === 1 ? 'was' : 'were'} added to this thread. Claude Code Desktop doesn't let Delta add ${them} to this session.`
      : `Claude Code Desktop doesn't let Delta add the ${worktrees} to this session.`
    await host.ui.log([
      `${refusal} To work in ${them} here too, run:`,
      ...directories.additionalDirectories.map((directory) => `/add-dir ${directory}`),
    ].join('\n'), { to: 'transcript' })
    return
  }
  setProgress(host, `Waiting for you to add the ${worktrees}…`, 'active')
  // Claude's prompt names only a path, and hides the band while it is open.
  await host.ui.log(reason === 'added' ? `${worktrees} added.` : `Adding the ${worktrees}.`, { to: 'transcript' })
  for (const directory of directories.additionalDirectories) {
    await check()
    await host.command.run({ command: 'add-dir', args: directory })
  }
}

/**
 * Move Claude into a mount's directory unless it is already there. Claude resumes in the directory
 * it was launched from, and `/cd` is the only way a plugin changes the session's directory.
 */
async function enterDirectory(
  host: Host, session: string, directory: string, label: string, check: () => Promise<void>,
) {
  if (await isInDirectory(host, directory)) return
  await requireJoinCommands(host, ['cd'])
  await check()
  setProgress(host, `Waiting for you to move to ${label}…`, 'active')
  // Claude's trust prompt names only a path, so say what it is and which answer pauses Delta.
  await host.ui.log(
    `Moving to ${label}. Choosing "No, stay put" pauses Delta until you run /delta-join again.`,
    { to: 'transcript' })
  await host.command.run({ command: 'cd', args: directory })
  await check()
  if (await host.session.id() !== session || !samePath(await host.session.cwd(), directory) ||
      !samePath(await host.session.root(), directory))
    throw new Error('Claude did not keep the session in the exact mounted directory; participation remains paused')
}

/**
 * Mount a joined session's worktrees again and put Claude in their directory. Mounting is
 * idempotent: it restores what was removed after the session's owner process last ran, and it
 * returns the directory Claude should work in now.
 */
async function restoreMounts(host: Host, session: string, check: () => Promise<void>) {
  const binding = await serial(() => load(host, session))
  await check()
  const mounted = await mountThread(host, binding)
  await check()
  requireMounted(mounted, binding.thread)
  const directories = sessionDirectories(mounted, await desktopRoot(host))
  await enterDirectories(host, session, directories, mounted.worktrees, check)
  await serial(async () => {
    await check()
    await save(host, {
      ...await load(host, session),
      owner: binding.owner ?? session, directory: directories.workingDirectory, mounts: mounted.worktrees,
    })
  })
  stateFor(session).mounted = true
}

/**
 * Restore a resumed joined session in the background: prompts wait, and the band shows progress.
 * Mounting and `/cd` leave the session hook first, as join's do, since `/cd` waits for the idle prompt.
 */
export function beginRestore(host: Host, session: string) {
  const runtime = stateFor(session)
  if (runtime.restoring) return
  runtime.restoring = true
  setProgress(host, "Restoring the thread's worktrees…", 'active')
  const owns = () => activation.session === session && sessions.get(session) === runtime
  host.clock.after(0, async () => {
    try {
      await restoreMounts(host, session, async () => {
        if (!owns()) throw new Error('The session ended while its worktrees were being restored')
      })
      const binding = await serial(() => load(host, session))
      await startParticipation(host, session, binding, owns)
      if (!owns()) return
      finishProgress(host, `Restored ${binding.mounts?.length ?? 0} worktree${binding.mounts?.length === 1 ? '' : 's'}`, 'done')
      await finishRestoredActivation(host, session, binding, owns)
    } catch (error) {
      if (!owns()) return
      const text = `Delta couldn't restore this session's worktrees: ${errorText(error)}. Retry ${recoveryCommand(runtime.binding)}; the prompt was not submitted.`
      runtime.joinFailure = text
      setProgress(host, text, 'error')
      await host.ui.log(text, { to: 'transcript' })
    } finally {
      runtime.restoring = undefined
    }
  })
}

/** End this session's mount commands; Delta owns the bounded cleanup after they disconnect. */
async function releaseMounts(host: Host, session: string) {
  try { await stopSessionMounts(session) }
  catch (error) { await host.ui.log(`Delta mount process did not stop: ${String(error)}`, { to: 'debug' }) }
}

/** Stop `owner`'s mount of `thread`, if this plugin process still holds it; a failure is only logged. */
export async function unmountThread(host: Host, thread: string, owner: string) {
  try { await stopThreadMounts(owner) }
  catch (error) { await host.ui.log(`Delta could not stop ${thread}'s mount: ${String(error)}`, { to: 'debug' }) }
}

/** The worktrees of a joined thread changed: re-mount, then tell Claude and the person. */
export function refreshMounts(host: Host, session: string, listed: { reference: string }[]) {
  const runtime = stateFor(session)
  runtime.mountRefresh = (runtime.mountRefresh ?? Promise.resolve())
    .then(() => applyWorktrees(host, session, listed))
    .catch((error) => {
      if (activation.session !== session) return
      const text = `Delta couldn't update this session's worktrees: ${errorText(error)}`
      setProgress(host, text, 'error')
      return host.ui.log(text, { to: 'transcript' })
    })
}

async function applyWorktrees(host: Host, session: string, listed: { reference: string }[]) {
  const runtime = stateFor(session)
  if (activation.session !== session || !runtime.mounted) return
  const binding = await serial(() => load(host, session))
  const previous = binding.mounts
  if (!binding.joined || !previous) return
  // Every reconnect reports the current list; most of those change nothing.
  if (listed.length === previous.length && listed.every((tree) => previous.some((mount) => mount.reference === tree.reference))) return
  const mounted = await mountThread(host, binding)
  if (activation.session !== session || mounted.thread_id !== binding.thread) return
  await serial(async () => save(host, { ...await load(host, session), mounts: mounted.worktrees }))
  const desktop = await desktopRoot(host)
  const { added, removed, update } = worktreeChanges(previous, binding.directory, mounted, desktop)
  if (!added.length && !removed.length) return
  const names = (trees: { name: string }[]) => trees.map((tree) => tree.name).join(', ')
  const changes = [added.length ? `added ${names(added)}` : '', removed.length ? `removed ${names(removed)}` : ''].filter(Boolean).join('; ')
  const moves = !!update && !samePath(update.workingDirectory, binding.directory ?? update.workingDirectory)
  // Desktop cannot add a directory for the person, so there is nothing to wait for the turn's end.
  const asks = !!update && !moves && desktop !== undefined
  finishProgress(host, `Thread worktrees changed: ${changes}${moves ? ` · moving to ${update.workingDirectory}` : ''}`, 'done')
  await deliverNote(host, session, [
    `[Delta] This thread's worktrees changed (${changes}). They are now:`,
    ...mounted.worktrees.map((tree) => `- ${tree.name}: ${tree.directory}`),
    moves ? `Delta will move this session to ${update.workingDirectory} and add the others as working directories once the current turn ends.`
      : asks ? `This session's directory is ${binding.directory}. Delta asked the person to add the new worktrees as working directories with /add-dir.`
      : update ? `This session's directory is ${binding.directory}. Delta will add the new worktrees as working directories once the current turn ends.`
      : `This session's directory is ${binding.directory}.`,
  ].join('\n'))
  if (!update) return
  if (asks) {
    await enterDirectories(host, session, update, mounted.worktrees, async () => {
      if (activation.session !== session) throw new Error('The session ended while its worktrees changed')
    }, 'added')
    return
  }
  // An update still waiting for the turn to end keeps the checkouts it would add that remain.
  const pending = (runtime.moveTo?.additionalDirectories ?? []).filter((path) =>
    !samePath(path, update.workingDirectory) &&
    mounted.worktrees.some((tree) => samePath(tree.directory, path)))
  runtime.moveTo = {
    workingDirectory: update.workingDirectory,
    additionalDirectories: [...new Set([...pending, ...update.additionalDirectories])],
  }
  scheduleMove(host, session)
}

export function scheduleMove(host: Host, session: string) {
  const runtime = stateFor(session)
  if (!runtime.moveTo || runtime.moving || rowsHeld(session)) return
  runtime.moving = true
  host.clock.after(0, () => moveSession(host, session))
}

/** Move Claude to the thread's first worktree and add the others, between turns. */
async function moveSession(host: Host, session: string) {
  const runtime = stateFor(session)
  const target = runtime.moveTo
  try {
    // A turn that began since is the one whose end moves the session.
    if (!target || activation.session !== session || rowsHeld(session)) return
    const binding = await serial(() => load(host, session))
    if (!binding.directory || !await isInDirectory(host, binding.directory)) { runtime.moveTo = undefined; return }
    const check = async () => { if (activation.session !== session) throw new Error('The session ended during the move') }
    const moves = !samePath(target.workingDirectory, binding.directory)
    await enterDirectories(host, session, target, binding.mounts ?? [], check, moves ? 'join' : 'added')
    await serial(async () => save(host, { ...await load(host, session), directory: target.workingDirectory }))
    runtime.moveTo = undefined
    resumeCheckout(runtime, 'verification')
    finishProgress(host, moves ? `Moved to ${target.workingDirectory}` : 'Added the new worktrees', 'done')
    await deliverNote(host, session, [
      ...moves ? [`[Delta] This session's directory is now ${target.workingDirectory}.`] : [],
      ...target.additionalDirectories.length ? [`${moves ? '' : '[Delta] '}Delta added ${target.additionalDirectories.join(', ')} as working directories.`] : [],
    ].join(' '))
    void drain(host, session).catch((error) => report(host, error))
  } catch (error) {
    runtime.moveTo = undefined
    if (activation.session !== session) return
    const text = `Delta couldn't move Claude to ${target?.workingDirectory} and add the thread's other worktrees: ${errorText(error)}. The session stays where it is; /cd there and /add-dir the others to work across every worktree.`
    setProgress(host, text, 'error')
    await host.ui.log(text, { to: 'transcript' })
  } finally {
    runtime.moving = undefined
  }
}

/** Check a joined session's mounts, then watch the thread; the watch lifts the watcher pause once live. */
export async function startParticipation(host: Host, session: string, binding: Binding, owns: () => boolean) {
  if (binding.joined) await verifyCheckout(host, binding)
  if (!owns()) return
  const ready = await startConversation(host, session)
  if (owns() && isCurrentReady(ready)) resumeCheckout(stateFor(session), 'watcher')
}

/**
 * Exiting ends the session's use of its checkouts. A clear is the join's own transition and a resume
 * only switches sessions, so neither releases them. A conversation that moved to another session
 * keeps its checkouts there; its subagents' stay with this session and are released. An offered
 * hand-off nobody opened goes with the tab that offered it.
 */
export async function releaseOnEnd(host: Host, session: string, reason: string, runtime: SessionState) {
  if (releasesMounts(reason)) {
    if (!await handedOff(host, session)) await releaseMounts(host, session)
    const ended = await storedBinding(host, key(session)).catch(() => undefined)
    await releaseThreadMounts(host, session, ended?.children ?? [])
  }
  const offered = runtime.offered
  runtime.offered = undefined
  if (offered && releasesMounts(reason)) await releaseHandoff(host, offered, true)
}
