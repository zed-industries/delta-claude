/**
 * A shared session's own checkout in Delta: the local worktree that identifies it, its membership in
 * the session's thread, and the `worktree mount` that keeps it synchronized while the session runs,
 * restored when the session resumes.
 */
import { finishProgress, setProgress } from '../band/band'
import {
  hasWorktreeMount, requireContract, worktreeAttach, worktreeCreate, worktreeList, worktreeMount,
} from '../cli/delta-cli'
import { samePath } from '../core/paths'
import {
  activation, type Binding, load, recoveryCommand, type Runtime, save, serial, sessions, stateFor,
} from '../core/session-state'
import { errorText } from '../core/text'
import { recordsOffline } from '../recording/delivery'
import { finishRestoredActivation } from '../setup/activation'
import { startParticipation } from './join'

/** Reuse a checkout already bound on this machine, or create a new local worktree identity. */
async function checkoutReference(
  $: Runtime, directory: string, check?: () => Promise<void>, session?: string,
): Promise<string> {
  const pending = session && await serial(() => load($, session)).then((binding) => binding.pendingWorktree)
  if (pending && samePath(pending.directory, directory)) return pending.reference
  const matches = await worktreeList($, directory, check)
  if (matches.length > 1)
    throw new Error(`${directory} has several local worktree identities; select the intended one in Delta before retrying`)
  if (matches.length) return matches[0]!
  const created = await worktreeCreate($, directory, check)
  if (session) await serial(async () => {
    const binding = await load($, session)
    await save($, { ...binding, pendingWorktree: { directory, reference: created.reference } })
  })
  return created.reference
}

/**
 * Make the checkout `directory` a member of `thread`, without importing it or starting
 * synchronization, and return the reference Delta gave it. `known` is a reference already bound.
 */
export async function attachWorktree(
  $: Runtime, directory: string, thread: string, known?: string, check?: () => Promise<void>, session?: string,
): Promise<string> {
  const reference = known ?? await checkoutReference($, directory, check, session)
  return (await worktreeAttach($, reference, thread, check)).reference
}

/** Keep an existing user checkout synchronized until the Claude session ends. */
export async function mountCheckout(
  $: Runtime, binding: { session: string; checkout?: string; checkoutReference?: string },
  check?: () => Promise<void>,
): Promise<{ reference: string; directory: string }> {
  const { session, checkout, checkoutReference: reference } = binding
  if (!checkout || !reference) throw new Error('This session has no attached checkout to mount')
  return worktreeMount($, { session, reference, directory: checkout, check })
}

/** Whether `binding`'s saved user checkout has no mount command in this process. */
export function checkoutNeedsMount(session: string, binding: Binding): boolean {
  return !binding.joined && !!binding.checkout && !!binding.checkoutReference &&
    !hasWorktreeMount(session, binding.checkout)
}

/**
 * Reclaim a saved user checkout before resuming recording in its directory. A session that records
 * offline keeps taking prompts meanwhile: their records queue, and mounting the existing checkout
 * imports the edits they make. Delta waits for a connection before mounting a shared checkout, so
 * holding prompts for the mount would hold them for as long as the session is offline.
 */
export function beginRestoreCheckout($: Runtime, session: string) {
  const runtime = stateFor(session)
  if (runtime.restoring || runtime.restoringCheckout) return
  const background = recordsOffline(session, runtime.binding)
  if (background) runtime.restoringCheckout = true
  else runtime.restoring = true
  setProgress($, 'Restoring this checkout’s synchronization…', 'active')
  const owns = () => activation.session === session && sessions.get(session) === runtime
  $.clock.after(0, async () => {
    try {
      const binding: Binding = await serial(() => load($, session))
      if (!owns()) return
      if (!binding.snapshot) await requireContract($, session)
      if (!owns()) return
      await mountCheckout($, binding, async () => {
        if (!owns()) throw new Error('The session ended while its checkout was being restored')
      })
      if (!owns()) return
      runtime.joinFailure = undefined
      if (binding.snapshot) {
        try { await startParticipation($, session, binding, owns) }
        catch {
          // The watcher owns reconnects after a transient failure. Its first failed
          // attempt does not mean that restoring the checkout mount failed.
        }
      }
      if (!owns()) return
      finishProgress($, 'Restored checkout synchronization', 'done')
      await finishRestoredActivation($, session, binding, owns)
    } catch (error) {
      if (!owns()) return
      // Prompts that record offline keep going, and the next one retries the restore.
      const text = background
        ? `Delta couldn't restore this checkout's synchronization: ${errorText(error)}. Prompts still record locally, and the next one retries.`
        : `Delta couldn't restore this checkout: ${errorText(error)}. Retry ${recoveryCommand(runtime.binding)}; the prompt was not submitted.`
      if (!background) runtime.joinFailure = text
      setProgress($, text, 'error')
      await $.ui.log(text, { to: 'transcript' })
    } finally {
      if (background) runtime.restoringCheckout = undefined
      else runtime.restoring = undefined
    }
  })
}
