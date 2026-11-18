/**
 * A session in a checkout Delta manages for a thread, such as a terminal opened in a desktop thread's
 * checkout: asking how it should work there, continuing it as a subthread of that thread in a checkout
 * of its own, or leaving it unsynced.
 */
import { finishProgress, setProgress } from '../band/band'
import { requireAuthentication } from '../cli/auth'
import {
  CONTRACT_TIMEOUT_MS, managedCheckout, requireContract, resolveCli, threadCreate, threadStatus,
} from '../cli/delta-cli'
import type { ThreadState } from '../cli/thread-commands'
import type { Host } from '../core/host'
import {
  activation, type Binding, load, pauseSessionHint, recoveryCommand, requests, save, serial, stateFor, stillActive,
} from '../core/session-state'
import { errorText } from '../core/text'
import { authenticationHost, claudeInteraction, notifyOnce } from '../setup/interaction'
import { InteractionDismissedError, InteractionUnavailableError } from '../setup/setup'
import { joinSubthreadInPlace } from './join'
import { hasInteractiveSurface, missingJoinCommands, separateGitDirectory, sessionSurfaces } from './lifecycle'

/** The answer that continues the session in a subthread of the checkout's thread. */
export const CONTINUE_AS_SUBTHREAD = 'Continue as a subthread'
/** The answer that leaves the session unsynced. */
export const DONT_SYNC = "Don't sync this session"

/** The thread a managed checkout belongs to, as the question about it names it. */
type Owner = { thread: string; title: string; audience: string; onServer: boolean }

/** What a session in a managed checkout is told when it can't continue there, or nothing when it can. */
type Refusal = string | undefined

/**
 * The thread whose own checkout `root` is, or nothing when it is the user's own, belongs to a mount
 * that is not one thread's, such as a joined session's, or Delta can't say. A Delta that can't answer
 * leaves the session as it would have been before Delta could.
 */
export async function managedCheckoutOf(host: Host, root: string): Promise<string | undefined> {
  if (!await mayBeManaged(host, root)) return
  try {
    const found = await managedCheckout(host, root, CONTRACT_TIMEOUT_MS)
    return found.kind === 'managed' ? found.thread : undefined
  } catch { return }
}

/**
 * Whether `root` could be a checkout Delta made. Delta gives each one a `.git` file naming a Git
 * directory of its own, which Git's linked worktrees and submodules never have: a linked worktree's
 * names its repository's in a `commondir` file, even in a bare repository. Anything else is not asked
 * about, since asking Delta can start its app.
 */
async function mayBeManaged(host: Host, root: string): Promise<boolean> {
  if ((await host.fs.stat(`${root}/.git`).catch(() => undefined))?.kind !== 'file') return false
  const target = separateGitDirectory(await host.fs.read(`${root}/.git`).catch(() => ''))
  if (!target) return false
  const directory = /^(\/|[A-Za-z]:\/)/.test(target) ? target : `${root}/${target}`
  return !await host.fs.stat(`${directory}/commondir`).catch(() => undefined)
}

/**
 * Ask a new session that starts in a checkout Delta manages for a thread how to work there, and act
 * on the answer. Returns whether the checkout is one, in which case nothing else may record or set up
 * the session from its start: automatic recording would give it a thread of its own, and setting up
 * the repository is not this checkout's to do.
 */
export async function offerManagedCheckout(host: Host, session: string, root: string, isNew: boolean): Promise<boolean> {
  if (!await mayBeManaged(host, root)) return false
  const binding = await serial(() => load(host, session))
  if (binding.managedCheckout?.choice === 'subthread' && !binding.joined) {
    // Prompts wait for the move, as they did before the session was resumed or reloaded.
    const runtime = stateFor(session)
    runtime.joinFailure = `This session hasn't finished moving into its subthread. Run /delta-share to finish.${pauseHint(binding)}`
    await notifyOnce(host, runtime.joinFailure)
    return true
  }
  if (binding.managedCheckout) return true
  if (binding.snapshot || binding.joined || binding.joinTransition) return false
  const thread = await managedCheckoutOf(host, root)
  if (!thread) return false
  // Part of a resumed session, or one the plugin was loaded into, already ran unasked; /delta-share
  // still offers the subthread.
  if (!isNew || !stillActive(session)()) return true
  // Nobody can answer a headless session, so it stays unsynced, as before Delta asked.
  if (!hasInteractiveSurface(await sessionSurfaces(host))) {
    await host.ui.log(`Delta: ${root} is a checkout of Delta thread ${thread}; a headless session there is not synced.`, { to: 'debug' })
    return true
  }
  const owner = await ownerOf(host, session, thread)
  if (!stillActive(session)()) return true
  const refusal = owner ? await subthreadRefusal(host, owner) : `Delta couldn't read the thread this folder is the checkout of`
  if (refusal) {
    await notifyOnce(host, `Delta doesn't sync this session: ${refusal}.`)
    return true
  }
  const choice = await askHowToWork(host, owner!)
  if (!choice || !stillActive(session)()) return true
  if (choice === 'off') {
    await leaveUnsynced(host, session, owner!)
    return true
  }
  const runtime = stateFor(session)
  runtime.enteringSubthread = true
  void continueAsSubthread(host, session, owner!).catch(async (error) => {
    if (activation.session !== session) return
    // A session that chose a subthread never silently records nowhere; prompts wait for a retry.
    runtime.joinFailure = await failureText(host, session, owner!, error)
    setProgress(host, runtime.joinFailure, 'error')
    await host.ui.log(runtime.joinFailure, { to: 'transcript' })
  }).finally(() => { runtime.enteringSubthread = undefined })
  return true
}

/**
 * `/delta share` in a checkout Delta manages for `thread`: the same question, for a session that
 * started before it could be asked or chose not to sync. `stage` exports the conversation so far
 * before the move. Returns what the band says, or nothing when the person chose not to sync.
 */
export async function shareInManagedCheckout(
  host: Host, session: string, thread: string,
  options: { emails: string[]; check: () => Promise<void>; stage: () => Promise<void> },
): Promise<{ band?: string; notice?: string }> {
  const owner = await ownerOf(host, session, thread)
  await options.check()
  if (!owner) return { notice: "Delta didn't share this session: Delta couldn't read the thread this folder is the checkout of. Try again." }
  if (options.emails.length)
    return { notice: `Delta didn't share this session: this folder is the checkout of ${owner.title}, so this session can only continue as its subthread, which ${owner.audience} can see. Run /delta-share without addresses to do that.` }
  const refusal = await subthreadRefusal(host, owner)
  if (refusal) return { notice: `Delta didn't share this session: ${refusal}.` }
  const choice = await askHowToWork(host, owner)
  await options.check()
  if (!choice) return {}
  if (choice === 'off') {
    await leaveUnsynced(host, session, owner)
    return {}
  }
  await options.stage()
  await continueAsSubthread(host, session, owner)
  return { band: 'Recording in a subthread' }
}

/** `/delta share` for a session whose move into its subthread of `thread` did not finish. */
export async function finishSubthread(host: Host, session: string, thread: string): Promise<{ band?: string; notice?: string }> {
  const owner = await ownerOf(host, session, thread)
  if (!owner) return { notice: "Delta didn't share this session: Delta couldn't read the thread this folder is the checkout of. Try again." }
  await continueAsSubthread(host, session, owner)
  return { band: 'Recording in a subthread' }
}

/** The managed checkout's thread, named for the question, or nothing when Delta can't read it. */
async function ownerOf(host: Host, session: string, thread: string): Promise<Owner | undefined> {
  let status: ThreadState
  try { status = await threadStatus(host, thread, session) }
  catch { return }
  return {
    thread, title: status.title?.trim() ? `“${status.title.trim()}”` : 'its Delta thread', audience: audienceOf(status),
    // A child records whenever its root would: once the root is on the server or queued to upload.
    onServer: status.access.state === 'granted' || !!status.upload,
  }
}

/** Who sees a subthread of a thread with `status`: whoever sees the thread. */
function audienceOf(status: ThreadState): string {
  if (status.visibility === 'organization') return 'everyone on your Delta team'
  if (status.visibility === 'unlisted') return 'anyone with its link'
  return 'only the people it is shared with'
}

/**
 * Why this session can't continue as a subthread of `owner`'s thread, before anything is created:
 * the thread is not on the server, or Claude can't move the session into a checkout of its own.
 */
async function subthreadRefusal(host: Host, owner: Owner): Promise<Refusal> {
  if (!owner.onServer)
    return `this folder is the checkout of ${owner.title}, which hasn't synced to Delta yet. Run /delta-share once it has to continue this session as its subthread`
  // Claude Code Desktop has no `/cd`, and moves a session only when a model turn ends.
  if ((await sessionSurfaces(host)).includes('desktop') || missingJoinCommands(['cd'], await host.command.list()).length)
    return `this folder is the checkout of ${owner.title}, and this Claude host can't move a session into a checkout of its own. Start Claude in a terminal there to continue as its subthread`
}

/** Ask how the session should work in `owner`'s checkout; nothing when the question was dismissed. */
async function askHowToWork(host: Host, owner: Owner): Promise<'subthread' | 'off' | undefined> {
  let answer: string
  try {
    answer = await claudeInteraction(host).ask(
      `This folder is the checkout of ${owner.title}, which ${owner.audience} can see. How should Delta handle this Claude session?`,
      {
        options: [CONTINUE_AS_SUBTHREAD, DONT_SYNC], header: 'Delta',
        descriptions: {
          [CONTINUE_AS_SUBTHREAD]: `Record this conversation as a subthread of ${owner.title}, visible to the same people. Claude moves to its own checkout of the same files.`,
          [DONT_SYNC]: `Delta doesn't record this conversation. Files changed in this folder still sync to ${owner.title}, as any change here does.`,
        },
      },
    )
  } catch (error) {
    // A dismissed question decides nothing, so the next start asks again.
    if (error instanceof InteractionDismissedError || error instanceof InteractionUnavailableError) return
    throw error
  }
  if (answer === CONTINUE_AS_SUBTHREAD) return 'subthread'
  if (answer === DONT_SYNC) return 'off'
}

/** Remember that the session chose not to sync, so a resume does not ask again. */
async function leaveUnsynced(host: Host, session: string, owner: Owner) {
  await serial(async () => save(host, {
    ...withoutUnsentRecords(await load(host, session)), managedCheckout: { thread: owner.thread, choice: 'off' },
  }))
  stateFor(session).joinFailure = undefined
  await host.ui.log(`Delta won't sync this session. Run /delta-share to continue it as a subthread of ${owner.title} instead.`, { to: 'transcript' })
}

/**
 * Create the session's subthread of `owner`'s thread, sharing its worktrees, and move the session
 * into a checkout of them mounted for it, keeping what a late share already staged. The choice is
 * saved first, so a move that stops partway is finished by `/delta share` rather than started over.
 */
async function continueAsSubthread(host: Host, session: string, owner: Owner) {
  // Joining activates the session again, which outdates `stillActive`; the session itself is what counts.
  const isCurrent = () => activation.session === session
  const check = async () => {
    if (!isCurrent() || await host.session.id() !== session)
      throw new Error('The Claude session changed while it moved into its subthread')
  }
  setProgress(host, `Starting a subthread of ${owner.title}…`, 'active')
  await serial(async () => save(host, {
    ...await load(host, session), managedCheckout: { thread: owner.thread, choice: 'subthread' },
  }, isCurrent))
  await requireContract(host, session)
  await check()
  await requireAuthentication(await authenticationHost(host), await resolveCli(host), check, async (text) => {
    await check()
    setProgress(host, 'Waiting for Delta sign-in…', 'active')
    await host.ui.log(text, { to: 'transcript' })
  })
  await check()
  const created = await threadCreate(host, {
    externalId: session, parent: { reference: owner.thread, name: 'Claude Code', worktrees: 'shared' }, check,
  })
  if (typeof created.reference !== 'string' || !created.reference)
    throw new Error('thread create: Delta returned no reference for the subthread')
  await check()
  await joinSubthreadInPlace(host, session, { thread: created.thread_id, reference: created.reference }, {
    check, isCurrent, parent: owner.thread,
  })
  stateFor(session).joinFailure = undefined
  finishProgress(host, `Recording in a subthread of ${owner.title}`, 'done')
}

/** What a move that failed tells the person: why, and the command that finishes it from where it stopped. */
async function failureText(host: Host, session: string, owner: Owner, error: unknown): Promise<string> {
  const binding = await serial(() => load(host, session)).catch(() => undefined)
  const retry = binding?.joined ? recoveryCommand(binding) : '/delta-share'
  return `Delta couldn't continue this session as a subthread of ${owner.title}: ${errorText(error)}. Run ${retry} to retry.${binding ? pauseHint(binding) : ''}`
}

/** `/delta pause`, offered while a move that didn't finish can still be undone by it. */
function pauseHint(binding: Binding): string {
  return binding.directory ? '' : pauseSessionHint(binding)
}

/**
 * A session without a thread, with nothing it staged: it reached no thread, so none of it was sent,
 * and a later share exports the conversation again.
 */
export function withoutUnsentRecords(binding: Binding): Binding {
  if (binding.thread) return binding
  const { stopped: _stopped, ...rest } = binding
  return { ...rest, snapshot: false, next: 1, pending: [] }
}

/**
 * `/delta pause` for a session whose move into its subthread didn't finish, which holds every prompt:
 * it stops syncing, as if it had chosen not to. Nothing reached Delta, since a session records into its
 * subthread only once it joins it, so what it staged is dropped and `/delta share` exports it again.
 * Returns why it can't stop, or nothing once it has.
 */
export async function stopUnfinishedSubthread(host: Host, session: string, binding: Binding): Promise<Refusal> {
  const runtime = stateFor(session)
  if (runtime.enteringSubthread || requests.share?.session === session || requests.join)
    return 'it is still moving into its subthread; try again when that finishes'
  // Claude already works in the subthread's checkout, which only finishing the move keeps synced.
  if (binding.directory) return "Claude already moved into its subthread's checkout; run /delta-share to finish the move"
  await serial(async () => save(host, {
    ...withoutUnsentRecords(await load(host, session)), managedCheckout: { thread: binding.managedCheckout!.thread, choice: 'off' },
  }))
  runtime.joinFailure = undefined
}
