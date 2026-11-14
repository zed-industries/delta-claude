/**
 * A shared session's own checkout in Delta: the local worktree that identifies it, its membership in
 * the session's thread, and the `worktree mount` that keeps it synchronized while the session runs,
 * restored when the session resumes.
 */
import { finishProgress, setProgress } from '../band/band'
import {
  hasWorktreeMount, requireContract, worktreeAttach, worktreeCreate, worktreeList, worktreeMount,
} from '../cli/delta-cli'
import { classifyCommandFailure, DeltaCommandError } from '../cli/thread-commands'
import { samePath } from '../core/paths'
import {
  activation, type Binding, load, recoveryCommand, requests, save, serial, sessions, stateFor,
} from '../core/session-state'
import type { Host } from '../core/host'
import { errorText } from '../core/text'
import { recordsOffline } from '../recording/delivery'
import { finishRestoredActivation } from '../setup/activation'
import { startParticipation } from './join'

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
 * Reclaim a saved user checkout before resuming recording in its directory. A session that records
 * offline keeps taking prompts meanwhile: their records queue, and mounting the existing checkout
 * imports the edits they make. Delta waits for a connection before mounting a shared checkout, so
 * holding prompts for the mount would hold them for as long as the session is offline. A refusal
 * Delta marks permanent is reported once and not retried: another attempt would get the same answer.
 */
export function beginRestoreCheckout(host: Host, session: string) {
  const runtime = stateFor(session)
  if (runtime.restoring || runtime.restoringCheckout || runtime.checkoutRefusal) return
  const background = recordsOffline(session, runtime.binding)
  if (background) runtime.restoringCheckout = true
  else runtime.restoring = true
  setProgress(host, 'Restoring this checkout’s synchronization…', 'active')
  // /delta off ends a restore still running, and stops a mount that comes up after it.
  const owns = () => activation.session === session && sessions.get(session) === runtime && !runtime.binding?.stopped
  host.clock.after(0, async () => {
    let mounted = false
    try {
      const binding: Binding = await serial(() => load(host, session))
      if (!owns()) return
      if (!binding.snapshot) await requireContract(host, session)
      if (!owns()) return
      await mountCheckout(host, binding, async () => {
        if (!owns()) throw new Error('The session ended while its checkout was being restored')
      })
      mounted = true
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
      // Prompts that record offline keep going, and the next one retries a restore that could still
      // succeed. Only Delta's own final answer to the mount stops that: steps after the mount, such as
      // delivery, fail for reasons of their own, and a share running meanwhile mounts the checkout itself.
      const permanent = background && !mounted && !requests.share && error instanceof DeltaCommandError &&
        classifyCommandFailure(error) === 'permanent'
      const refusal = managedCheckoutRefusal(error, runtime.binding?.checkout ?? 'this folder')
      const reason = errorText(refusal).replace(/[.\s]+$/, '')
      const text = permanent
        ? `Delta couldn't restore this checkout's synchronization and won't retry it in this session: ${reason}. Prompts still record locally.`
        : background
        ? `Delta couldn't restore this checkout's synchronization: ${errorText(error)}. Prompts still record locally, and the next one retries.`
        : `Delta couldn't restore this checkout: ${errorText(error)}. Retry ${recoveryCommand(runtime.binding)}; the prompt was not submitted.`
      if (permanent) runtime.checkoutRefusal = text
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
 * What a share or restore says when `root` is a checkout Delta manages for another thread that no
 * session here joined. Delta reports it from whichever step binds the folder; today that is the mount.
 */
export function managedCheckoutRefusal(error: unknown, root: string): unknown {
  if (!(error instanceof DeltaCommandError && error.reason === 'worktree_directory_in_use')) return error
  return new Error(`${root} is a checkout Delta manages for another thread, so it can't be shared as this one. Run /delta-join with that thread's link to work there (${error.message})`)
}
