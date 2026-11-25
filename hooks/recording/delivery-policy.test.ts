import { describe, expect, test } from 'claude-code/testing'
import { deliveryFailure, deliveryRetryDelay, type FailureStreak } from './delivery-policy'
import { DeltaCommandError } from '../cli/thread-commands'

describe('delivery policy', () => {
  test('the envelope decides: a retryable failure never pauses, a non-retryable one does', () => {
    for (const retryable of [true, false]) {
      const decision = deliveryFailure({}, new DeltaCommandError('failed', 'anything', { retryable }), false)
      expect(decision.retry).toBe(retryable)
      expect(decision.pause).toBe('delivery')
    }
  })

  test('a local code with no envelope falls back to the plugin local table', () => {
    for (const code of ['process_failed', 'timeout'])
      expect(deliveryFailure({}, new DeltaCommandError(code, 'offline'), false).retry).toBe(true)
    for (const code of ['process_refused', 'command_failed', 'invalid_acknowledgment'])
      expect(deliveryFailure({}, new DeltaCommandError(code, 'bad output'), false).retry).toBe(false)
  })

  test('a local process failure retries up to a cap, then pauses; an envelope verdict is never capped', () => {
    for (const code of ['process_failed', 'timeout']) {
      for (let retryAttempts = 0; retryAttempts < 5; retryAttempts++)
        expect(deliveryFailure({ retryAttempts }, new DeltaCommandError(code, 'stuck'), false).retry).toBe(true)
      expect(deliveryFailure({ retryAttempts: 5 }, new DeltaCommandError(code, 'stuck'), false).retry).toBe(false)
    }
    // A server failure that says it is retryable keeps retrying however many attempts have passed.
    expect(deliveryFailure({ retryAttempts: 99 }, new DeltaCommandError('failed', 'offline', { retryable: true }), false).retry).toBe(true)
  })

  test('a failed checkout check still pauses verification, not delivery', () => {
    for (const error of [new DeltaCommandError('failed', 'no checkout'), new DeltaCommandError('failed', 'later', { retryable: true })]) {
      const decision = deliveryFailure({}, error, true)
      expect(decision.pause).toBe('verification')
    }
    expect(deliveryFailure({}, new DeltaCommandError('failed', 'no checkout'), false).pause).toBe('delivery')
  })

  test('retry hints lengthen but never shorten capped backoff', () => {
    for (const [attempt, hint, expected] of [[0, 0, 2000], [1, 10_000, 10_000], [2, 1e9, 300_000], [10, 0, 30_000]])
      expect(deliveryRetryDelay(attempt!, hint)).toBe(expected)
    expect(deliveryFailure({}, new DeltaCommandError('invalid_record', 'later', { retryable: true }), false).retry).toBe(true)
    expect(deliveryFailure({}, new DeltaCommandError('sync', 'final', { retryable: false }), false).retry).toBe(false)
  })

  test('notices follow codes, not changing messages; explicit recovery resets notice suppression', () => {
    let state: FailureStreak = {}
    for (let request = 0; request < 4; request++) {
      const decision = deliveryFailure(state, new DeltaCommandError('failed', `request ${request}`, { retryable: true }), false)
      expect(decision.show).toBe(request === 0)
      state = decision.state
    }
    expect(deliveryFailure({}, new DeltaCommandError('failed', 'again'), false).show).toBe(true)
  })
})
