/**
 * A shared session's own checkout in Delta: the local worktree that identifies it, its membership in
 * the session's thread, and the `worktree mount` that keeps it synchronized while the session runs,
 * restored when the session resumes.
 */
import { finishProgress, setProgress } from '../band/band'
import {
  hasWorktreeMount, requireContract, worktreeAttach, worktreeCreate, worktreeList, worktreeMount, worktreeRelease,
} from '../cli/delta-cli'
import { DeltaCommandError } from '../cli/thread-commands'
import { samePath } from '../core/paths'
import {
  activation, type Binding, load, recoveryCommand, save, serial, sessions, stateFor,
} from '../core/session-state'
import type { Host } from '../core/host'
import { errorText } from '../core/text'
import { recordsOffline } from '../recording/delivery'
import { finishRestoredActivation } from '../setup/activation'
import { beginRestore, mountThread, requireMounted, startParticipation } from './join'

/** Reuse a checkout already bound on this machine, or create a new local worktree identity. */
async function checkoutReference(
  host: Host, directory: string, check?: () => Promise<void>, session?: string,
): Promise<string> {
  const pending = session && await serial(() => load(host, session)).then((binding) => binding.pendingWorktree)
  if (pending && samePath(pending.directory, directory)) return pending.reference
  const matches = await worktreeList(host, directory, check)
  if (matches.length > 1)
    throw new Error(`${directory} has several local worktree identities; select the intended one in Delta before retrying`)
  if (matches.length) return matches[0]!
  const created = await worktreeCreate(host, directory, check)
  if (session) await serial(async () => {
    const binding = await load(host, session)
    await save(host, { ...binding, pendingWorktree: { directory, reference: created.reference } })
  })
  return created.reference
}

/**
 * Make the checkout `directory` a member of `thread`, without importing it or starting
 * synchronization, and return the reference Delta gave it. `known` is a reference already bound.
 */
export async function attachWorktree(
  host: Host, directory: string, thread: string, known?: string, check?: () => Promise<void>, session?: string,
): Promise<string> {
  const reference = known ?? await checkoutReference(host, directory, check, session)
  return (await worktreeAttach(host, reference, thread, check)).reference
}

/** Keep an existing user checkout synchronized until the Claude session ends. */
export async function mountCheckout(
  host: Host, binding: { session: string; checkout?: string; checkoutReference?: string },
  check?: () => Promise<void>,
): Promise<{ reference: string; directory: string }> {
  const { session, checkout, checkoutReference: reference } = binding
  if (!checkout || !reference) throw new Error('This session has no attached checkout to mount')
  return worktreeMount(host, { session, reference, directory: checkout, check })
}

/** Whether `binding`'s saved user checkout has no mount command in this process. */
export function checkoutNeedsMount(session: string, binding: Binding): boolean {
  return !binding.joined && !!binding.checkout && !!binding.checkoutReference &&
    !hasWorktreeMount(session, binding.checkout)
}

/**
 * Reclaim a saved user checkout before resuming recording in its directory. Others may have changed a
 * thread they can open while the session was closed, so prompts wait until Delta has compared the
 * checkout with it, for as long as reaching Delta takes. A private thread's session that records
 * offline keeps taking prompts meanwhile: their records queue, and the mount imports their edits.
 */
export function beginRestoreCheckout(host: Host, session: string) {
  const runtime = stateFor(session)
  if (runtime.restoring || runtime.restoringCheckout) return
  const background = recordsOffline(session, runtime.binding) && runtime.binding?.visibility === 'private'
  if (background) runtime.restoringCheckout = true
  else runtime.restoring = true
  setProgress(host, 'Restoring this checkout’s synchronization…', 'active')
  const owns = () => activation.session === session && sessions.get(session) === runtime
  host.clock.after(0, async () => {
    try {
      const binding: Binding = await serial(() => load(host, session))
      if (!owns()) return
      if (!binding.snapshot) await requireContract(host, session)
      if (!owns()) return
      await mountCheckout(host, binding, async () => {
        if (!owns()) throw new Error('The session ended while its checkout was being restored')
      })
      if (!owns()) return
      runtime.joinFailure = undefined
      if (binding.snapshot) {
        try { await startParticipation(host, session, binding, owns) }
        catch {
          // The watcher owns reconnects after a transient failure. Its first failed
          // attempt does not mean that restoring the checkout mount failed.
        }
      }
      if (!owns()) return
      finishProgress(host, 'Restored checkout synchronization', 'done')
      await finishRestoredActivation(host, session, binding, owns)
    } catch (error) {
      if (!owns()) return
      if (error instanceof DeltaCommandError && error.reason === 'worktree_directory_diverged') {
        await moveToThreadCheckout(host, session, owns).catch(async (moveError) => {
          if (!owns()) return
          const text = `Delta couldn't move this session to a checkout of the thread: ${errorText(moveError)}. Retry ${recoveryCommand(runtime.binding)}; the prompt was not submitted.`
          runtime.joinFailure = text
          setProgress(host, text, 'error')
          await host.ui.log(text, { to: 'transcript' })
        })
        return
      }
      // Prompts that record offline keep going, and the next one retries the restore.
      const text = background
        ? `Delta couldn't restore this checkout's synchronization: ${errorText(error)}. Prompts still record locally, and the next one retries.`
        : `Delta couldn't restore this checkout: ${errorText(error)}. Retry ${recoveryCommand(runtime.binding)}; the prompt was not submitted.`
      if (!background) runtime.joinFailure = text
      setProgress(host, text, 'error')
      await host.ui.log(text, { to: 'transcript' })
    } finally {
      if (background) runtime.restoringCheckout = undefined
      else runtime.restoring = undefined
    }
  })
}

/**
 * Move a session whose checkout and thread both changed while it was closed into a checkout of the
 * thread's own, where it works as a joined session does. Delta leaves the old checkout and its
 * changes as they are and forgets it, so a later session there starts afresh instead of mounting it
 * over the thread. Claude Code Desktop has no `/cd`, so there the session pauses until the person joins.
 */
async function moveToThreadCheckout(host: Host, session: string, owns: () => boolean) {
  const runtime = stateFor(session)
  const binding = await serial(() => load(host, session))
  const { checkout, checkoutReference, thread } = binding
  if (!checkout || !checkoutReference || !thread) throw new Error('This session has no attached checkout to move from')
  const locator = binding.locator ?? thread
  if ((await host.session.surfaces()).includes('desktop')) {
    const text = `${checkout} and this Delta thread both changed while Claude was closed, so Delta left both as they are. Run /delta-join ${locator} to continue the thread in a checkout of its own; ${checkout} keeps its changes.`
    runtime.joinFailure = text
    setProgress(host, text, 'error')
    await host.ui.log(text, { to: 'transcript' })
    return
  }
  setProgress(host, 'Moving this session to a checkout of the thread…', 'active')
  const mounted = await mountThread(host, { session, thread, locator, owner: session })
  if (!owns()) return
  requireMounted(mounted, thread)
  await serial(async () => {
    if (!owns()) return
    await save(host, {
      ...await load(host, session), joined: true, owner: session, locator, directory: mounted.directory,
      mounts: mounted.worktrees, checkout: undefined, checkoutReference: undefined, movedFrom: checkout,
    })
  })
  if (!owns()) return
  // A checkout Delta failed to forget stays safe: mounting it again finds it diverged.
  await worktreeRelease(host, checkoutReference, checkout).catch((error) =>
    host.ui.log(`Delta couldn't forget the checkout ${checkout}: ${errorText(error)}`, { to: 'debug' }))
  await host.ui.log(`${checkout} and this Delta thread both changed while Claude was closed. Delta left ${checkout} as it is, with changes the thread doesn't have, and moved this session to ${mounted.directory}, which holds the thread's version.`, { to: 'transcript' })
  // The joined restore moves Claude there; it starts once this restore has ended.
  host.clock.after(0, () => { if (owns()) beginRestore(host, session) })
}
