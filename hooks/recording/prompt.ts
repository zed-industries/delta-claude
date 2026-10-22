/** Admitting a prompt into a recorded session: what must be ready before the turn it starts is recorded. */

import {
  activate, activationIncomplete, adoptContinuation, captureDecided, continuationCandidate, continuedFrom,
  retryAutomaticActivation,
} from '../setup/activation'
import { recordsOffline, verifyCheckout } from './delivery'
import { beginRestoreCheckout, checkoutNeedsMount } from '../sharing/checkout'
import { HANDOFF_ACKNOWLEDGEMENT, HANDOFF_PROMPT } from '../sharing/handoff'
import { ownsSteering, promptGate } from '../sharing/lifecycle'
import {
  activation, type HookEvent, type HookNext, isPaused, pauseCheckout, pauseNotice, recoveryAdvice, requests,
  resumeCheckout, type Runtime, stateFor,
} from '../core/session-state'
import { errorText } from '../core/text'
import { classifyCommandFailure, JoinNotReadyError } from '../cli/thread-commands'
import { liveFor, startConversation } from '../watch/watch'
import { settleRemote, settling } from '../watch/rows'

/**
 * Admit a prompt into a recorded session, or drop it with why: a hand-off's opening line becomes a
 * local turn, a running join or share refuses it, and a recorded session's watcher, checkout and
 * capture must be ready before the turn it starts is recorded.
 */
export async function admitPrompt($: Runtime, e: HookEvent<'prompt.submit'>, next: HookNext<'prompt.submit'>) {
  // A hand-off's opening line only started this session, which has joined by now. It becomes a
  // one-word turn that the thread never records, rather than a message to the thread or a
  // dropped prompt Desktop would show as blocked.
  const opening = stateFor(await $.session.id())
  if (opening.handoffClaim) {
    const claim = opening.handoffClaim
    await claim
    if (opening.handoffClaim === claim) opening.handoffClaim = undefined
    if (!opening.joinFailure && !e.turnId && e.text.trim() === HANDOFF_PROMPT) {
      opening.localTurn = {}
      return next({ ...e, text: HANDOFF_ACKNOWLEDGEMENT })
    }
  }
  const operation = promptGate({ joining: !!requests.join, sharing: !!requests.share })
  if (operation === 'joining') return { drop: 'Delta is joining in a fresh session. Wait for the join result before submitting a prompt.' }
  if (operation === 'sharing') return { drop: 'Delta is sharing this session. Wait for the share result before submitting a prompt.' }
  const session = await $.session.id()
  const runtime = stateFor(session)
  if (runtime.joinFailure) return { drop: `${runtime.joinFailure} The prompt was not submitted.` }
  // A new session's prompt waits for its capture boundary, so a prompt typed right after `/clear` or
  // sent headlessly is recorded rather than lost before the snapshot exists.
  await captureDecided(session)
  // A hot reload can install this hook without replaying session.start.
  if (activation.session !== session || !runtime.binding) {
    try { await activate($, session) }
    catch (error) {
      return { drop: `Delta conversation initialization failed: ${errorText(error)}. The prompt was not submitted.` }
    }
  }
  const transition = runtime.binding?.joinTransition
  const blocked = promptGate({
    transition: !!transition, snapshot: !!runtime.binding?.snapshot,
    restoring: !!runtime.restoring, movePending: !!runtime.moveTo, steering: !!e.turnId,
  })
  if (blocked === 'transition' && transition)
    return { drop: `The Delta join directory transition is incomplete. Run /delta-join ${transition.locator} to retry; the prompt was not submitted.` }
  if (blocked === 'restoring')
    return { drop: "Delta is restoring this thread's worktrees. Wait for the band to say they are restored, then try again. The prompt was not submitted." }
  if (blocked === 'moving')
    return { drop: 'Delta is moving Claude to the thread folder between turns. Try again in a moment. The prompt was not submitted.' }
  // Claude Code can start a continuation before the parent's transcript names it; look once more.
  if (runtime.binding && continuationCandidate(session, runtime.binding) && !runtime.continuationRechecked) {
    runtime.continuationRechecked = true
    const parent = await continuedFrom($, session)
    if (parent && await adoptContinuation($, session, parent.session)) {
      try { await activate($, session) }
      catch (error) { return { drop: `Delta couldn't continue recording this conversation: ${errorText(error)}. The prompt was not submitted.` } }
      if (runtime.restoring) return { drop: "Delta is restoring this thread's worktrees for the continued conversation. Wait for the band to say they are restored, then try again. The prompt was not submitted." }
    }
  }
  if (!runtime.binding?.snapshot) return next(e)
  // A session that records offline does not wait for the watcher and never drops a prompt for a
  // delivery pause: the pause stops delivery, and this prompt retries delivery and any incomplete
  // automatic activation once. A poison record simply stays queued, its notice shown once.
  const offline = recordsOffline(session, runtime.binding)
  // An unfinished automatic activation records locally and retries from here, whether or not the
  // CLI has answered its contract yet; there is no thread to watch or verify until it completes.
  const incomplete = activationIncomplete(runtime)
  if (offline || incomplete) {
    if (runtime.pauses.has('delivery')) resumeCheckout(runtime, 'delivery')
    retryAutomaticActivation($, session, runtime)
    // A checkout whose mount failed to come back, or ended, is restored again in the background.
    if (offline && !incomplete && checkoutNeedsMount(session, runtime.binding)) beginRestoreCheckout($, session)
  } else if (runtime.pauses.has('delivery')) {
    // Watching again cannot lift a refusal, so do not restart the watcher for one.
    return { drop: `${runtime.pauses.get('delivery') ?? pauseNotice(runtime)} The prompt was not submitted.` }
  }
  // A session that does not record offline still recovers the watcher here and refuses if it cannot.
  if (!offline && !incomplete && (!runtime.binding.thread || isPaused(runtime) || !liveFor(session))) {
    try { await startConversation($, session) }
    catch (error) { return { drop: `The Delta watcher is not ready: ${errorText(error)}. ${recoveryAdvice(runtime.binding)}.` } }
  }
  if (e.turnId) {
    const execution = runtime.binding.execution
    if (!ownsSteering(execution, e.turnId))
      return { drop: 'This Claude turn no longer owns the shared conversation.' }
    return next(e)
  }
  try {
    if (runtime.captureFailure || runtime.binding.captureFailure)
      throw new Error(`local conversation capture is paused; ${recoveryAdvice(runtime.binding)} before continuing`)
    // A prompt that arrives mid-activation records locally while create, upload, and attach finish,
    // and one that arrives while the checkout's mount is restored records locally until it is.
    if (!activationIncomplete(runtime) && !runtime.restoringCheckout) {
      await verifyCheckout($, runtime.binding)
      if (isPaused(runtime)) throw new Error(pauseNotice(runtime))
    }
  } catch (error) {
    // Offline, an unanswered checkout check says nothing about the checkout: the records stay
    // queued and retry, so the prompt proceeds rather than being dropped. A non-retryable refusal
    // or a local persistence failure still stops it.
    if (!(offline && classifyCommandFailure(error) === 'transient' && !isPaused(runtime))) {
      const text = `Delta is not ready for this prompt: ${errorText(error)}. The prompt was not submitted.`
      // The band names a worktree or directory that is not ready, until a prompt finds it ready.
      if (error instanceof JoinNotReadyError) pauseCheckout(runtime, 'verification', error.message)
      return { drop: text }
    }
  }
  // Remote activity that already completed precedes the prompt; later rows wait for its turn.
  // Like a native Delta send, the turn this prompt starts takes over any running remote turn.
  await settleRemote($, session)
  let result: Awaited<ReturnType<typeof next>>
  try {
    runtime.promptEntering = true
    await settling
    result = await next(e)
  } catch (error) {
    runtime.promptEntering = false
    void settleRemote($, session)
    throw error
  }
  if (result.drop !== undefined) {
    runtime.promptEntering = false
    void settleRemote($, session)
  }
  return result
}
