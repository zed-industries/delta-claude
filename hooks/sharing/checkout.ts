/**
 * A shared session's own checkout in Delta: the local worktree that identifies it, its membership in
 * the session's thread, and the `worktree mount` that keeps it synchronized while the session runs,
 * restored when the session resumes, and moved to a worktree Claude makes with EnterWorktree and back.
 */
import { finishProgress, setProgress } from '../band/band'
import {
  checkoutSyncing, hasWorktreeMount, requireContract, stopWorktreeMount, worktreeAttach, worktreeCreate,
  worktreeDetach, worktreeList, worktreeMount,
} from '../cli/delta-cli'
import { classifyCommandFailure, DeltaCommandError } from '../cli/thread-commands'
import { isJsonObject } from '../core/json'
import { samePath } from '../core/paths'
import {
  activation, type Binding, load, pauseCheckout, pauseSessionHint, recoveryCommand, report, requests,
  resumeCheckout, save, serial, sessions, stateFor, stillActive,
} from '../core/session-state'
import type { Host } from '../core/host'
import { errorText } from '../core/text'
import { drain, recordsOffline } from '../recording/delivery'
import { finishRestoredActivation } from '../setup/activation'
import { startParticipation } from './join'

/**
 * How long to wait for Delta to stop syncing a checkout after its mount ends. Delta bounds the final
 * upload at 5 seconds, then stops watching the directory.
 */
const RELEASE_BUDGET_MS = 6_000
/** How often a checkout whose mount ended is checked for Delta's release. */
const RELEASE_POLL_MS = 100
/** How long a move into or out of a worktree waits for the new checkout's mount; see `mountWithin`. */
const MOUNT_BUDGET_MS = 10_000

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
  // /delta pause ends a restore still running, and stops a mount that comes up after it.
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
        ? `Delta couldn't restore this checkout's synchronization and won't retry it in this session: ${reason}. Prompts still record locally.${pauseSessionHint(runtime.binding)}`
        : background
        ? `Delta couldn't restore this checkout's synchronization: ${errorText(error)}. Prompts still record locally, and the next one retries.`
        : `Delta couldn't restore this checkout: ${errorText(error)}. Retry ${recoveryCommand(runtime.binding)}; the prompt was not submitted.${pauseSessionHint(runtime.binding)}`
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
  // Delta builds before `checkout_in_use` publish this as `failed`; their reason can go once stable has the code.
  if (!(error instanceof DeltaCommandError
    && (error.code === 'checkout_in_use' || error.reason === 'worktree_directory_in_use'))) return error
  return new Error(`${root} is a checkout Delta manages for another thread, so it can't be shared as this one. Run /delta-join with that thread's link to work there (${error.message})`)
}

/** Wait until Delta no longer syncs `directory`, within `RELEASE_BUDGET_MS`. */
export async function awaitCheckoutReleased(host: Host, directory: string) {
  const deadline = await host.clock.now() + RELEASE_BUDGET_MS
  while (true) {
    const remaining = deadline - await host.clock.now()
    if (remaining <= 0)
      throw new Error(`Delta was still syncing ${directory} ${RELEASE_BUDGET_MS / 1000} seconds after its mount ended`)
    if (!await checkoutSyncing(host, directory, remaining)) return
    await host.clock.sleep(Math.min(RELEASE_POLL_MS, remaining))
  }
}

/**
 * Move a shared session's thread onto the worktree EnterWorktree moved the session into. A thread
 * holds one worktree per Git checkout, and Claude's worktree shares the session's checkout, so the
 * thread's worktree is swapped for Claude's. A failed move is reported and leaves Claude's answer as it is.
 */
export async function followEnterWorktree<R>(host: Host, run: () => Promise<R>): Promise<R> {
  const session = await host.session.id()
  const owns = stillActive(session)
  const result = await run()
  const directory = worktreePathOf(result)
  if (directory && owns())
    await holdingDelivery(host, session, () => moveCheckout(host, session, directory, owns).catch((error) => report(host, error)))
  return result
}

/**
 * Move a shared session's thread back onto the checkout it left with EnterWorktree once ExitWorktree
 * returns the session there. A failed move is reported and leaves Claude's answer as it is.
 */
export async function followExitWorktree<R>(host: Host, run: () => Promise<R>): Promise<R> {
  const session = await host.session.id()
  const owns = stillActive(session)
  const binding = await serial(() => load(host, session))
  const leaving = followsCheckout(binding) && binding.worktreeReturn
    ? { worktree: binding.checkout, to: binding.worktreeReturn } : undefined
  if (!leaving) return run()
  return holdingDelivery(host, session, async () => {
    // ExitWorktree may delete the worktree, so Delta takes in what was done there before Claude runs it.
    await releaseCheckout(host, session, leaving.worktree).catch((error) => report(host, error))
    const result = await run()
    if (!owns()) return result
    const answer: unknown = result
    // A refused ExitWorktree leaves the session where it was, so its checkout is mounted again.
    await (!isJsonObject(answer) || answer.isError === true || !('result' in answer)
      ? mountWithin(host, session)
      : moveCheckout(host, session, leaving.to.checkout, owns, leaving.to.checkoutReference)
    ).catch((error) => report(host, error))
    return result
  })
}

/**
 * Hold delivery while the session's checkout moves, since Delta reports it detached until the move
 * ends, then deliver what waited.
 */
async function holdingDelivery<T>(host: Host, session: string, move: () => Promise<T>): Promise<T> {
  const state = stateFor(session)
  pauseCheckout(state, 'move')
  try { return await move() }
  finally {
    resumeCheckout(state, 'move')
    void drain(host, session).catch((error) => report(host, error))
  }
}

/** The worktree an EnterWorktree call reports moving the session into, if it succeeded. */
function worktreePathOf(result: unknown): string | undefined {
  if (!isJsonObject(result) || result.isError === true || !isJsonObject(result.result)) return
  const path = result.result.worktreePath
  return typeof path === 'string' && path ? path : undefined
}

/** A recording session's binding with an attached checkout of its own. */
type CheckoutBinding = Binding & { thread: string; checkout: string; checkoutReference: string }

/** Whether `binding` records a checkout of the session's own, which follows the session between worktrees. */
function followsCheckout(binding: Binding): binding is CheckoutBinding {
  return !!binding.thread && binding.snapshot && !binding.joined && !binding.stopped &&
    !!binding.checkout && !!binding.checkoutReference
}

/** End the session's mount of `directory` and wait until Delta has taken in what changed there. */
async function releaseCheckout(host: Host, session: string, directory: string) {
  if (await stopWorktreeMount(session, directory)) await awaitCheckoutReleased(host, directory)
}

/**
 * Move the thread's worktree from the session's checkout to `directory`: detach the checkout, attach
 * `directory` as the worktree `known`, or a new one, and mount it. Entering a worktree remembers the
 * checkout first left; returning with `known` forgets it. Each step is saved as it completes, so a move
 * that fails partway leaves `checkout` naming `directory`, which `/delta share` attaches.
 */
async function moveCheckout(
  host: Host, session: string, directory: string, owns: () => boolean, known?: string,
) {
  const binding = await serial(() => load(host, session))
  if (!followsCheckout(binding) || samePath(binding.checkout, directory)) return
  const { thread } = binding
  const left = { checkout: binding.checkout, checkoutReference: binding.checkoutReference }
  await releaseCheckout(host, session, left.checkout)
  if (!owns()) return
  await worktreeDetach(host, left.checkoutReference, thread)
  const worktreeReturn = known === undefined ? binding.worktreeReturn ?? left : undefined
  await serial(async () => save(host, {
    ...await load(host, session), checkout: directory, checkoutReference: undefined, worktreeReturn,
  }, owns))
  if (!owns()) return
  const reference = await attachWorktree(host, directory, thread, known, undefined, session)
  await serial(async () => save(host, {
    ...await load(host, session), checkoutReference: reference, pendingWorktree: undefined,
  }, owns))
  if (owns()) await mountWithin(host, session)
}

/**
 * Mount the session's checkout, waiting up to `MOUNT_BUDGET_MS` so Claude's next tools work in a
 * synchronized checkout. Delta mounts a shared checkout only once it is online, so a mount still
 * waiting then carries on without holding Claude, and reports its own failure.
 */
async function mountWithin(host: Host, session: string) {
  const binding = await serial(() => load(host, session))
  if (!followsCheckout(binding)) return
  const mounted = mountCheckout(host, binding)
  const expiry = new AbortController()
  const ready = await Promise.race([
    mounted.then(() => true),
    host.clock.sleep(MOUNT_BUDGET_MS, { signal: expiry.signal }).then(() => false, () => false),
  ])
  expiry.abort()
  if (!ready) void mounted.catch((error) => report(host, error))
}
