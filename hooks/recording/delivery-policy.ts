import { classifyCommandFailure, type DeltaCommandError } from '../cli/thread-commands'

export type FailureStreak = {
  deliveryNotice?: string
  retryAttempts?: number
}

/**
 * A local process failure retries this many times before it pauses instead. The CLI running the
 * append either never started or never finished, with no server verdict to trust; a refusal Claude
 * Code reworded past `isHostPolicyRefusal`, or a CLI that cannot run here, would otherwise retry
 * forever. A server failure's own `retryable` verdict is honored however many attempts have passed.
 */
const MAX_LOCAL_PROCESS_RETRIES = 5

/** Decide retries and pauses without touching timers, UI, or queued records. */
export function deliveryFailure(
  state: FailureStreak, error: DeltaCommandError, verificationPaused: boolean,
) {
  const transient = classifyCommandFailure(error) !== 'permanent'
  // A local process failure carries no envelope verdict; bound its retries so a stuck one pauses.
  const localProcessFailure = error.hints.retryable === undefined
    && (error.code === 'process_failed' || error.code === 'timeout')
  const exhausted = localProcessFailure && (state.retryAttempts ?? 0) >= MAX_LOCAL_PROCESS_RETRIES
  const retry = transient && !exhausted
  const notice = `${retry}:${error.code}`
  return {
    retry,
    // A failed checkout check pauses verification; a failure the envelope will not retry pauses delivery.
    pause: verificationPaused ? 'verification' as const : 'delivery' as const,
    show: state.deliveryNotice !== notice,
    state: { deliveryNotice: notice },
  }
}

/** Server hints lengthen exponential backoff, with a five-minute upper bound. */
export function deliveryRetryDelay(attempt: number, retryAfterMs = 0): number {
  const backoff = Math.min(30_000, 2000 * 2 ** Math.min(attempt, 4))
  return Math.min(Math.max(retryAfterMs, backoff), 300_000)
}
