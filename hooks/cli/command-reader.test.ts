import { describe, expect, test } from 'claude-code/testing'
import { readCommandStream, readMountReady } from './command-reader'
import { DeltaCommandError } from './thread-commands'

describe('command reader', () => {
  for (const chunked of [false, true]) {
    test(`a multiline mount failure preserves its CLI error (${chunked ? 'chunked' : 'one chunk'})`, async () => {
      const envelope = JSON.stringify({
        error: { code: 'worktree_conflict', message: 'Checkout is already mounted', retryable: false },
      }, null, 2) + '\n'
      let closed = false
      async function* output() {
        try {
          yield { stream: 'stderr' as const, text: 'fallback diagnostic' }
          for (const text of chunked ? [...envelope] : [envelope])
            yield { stream: 'stdout' as const, text }
          return { code: 1, signal: null }
        } finally {
          closed = true
        }
      }
      const stream = output()
      const result = readMountReady(stream, 'worktree mount', new AbortController().signal,
        () => new Promise<void>(() => {}), 1000)
      try {
        await result
        throw new Error('Expected mount failure')
      } catch (error) {
        expect(error).toBeInstanceOf(DeltaCommandError)
        expect((error as DeltaCommandError).code).toBe('worktree_conflict')
        expect((error as Error).message).toContain('Checkout is already mounted')
      }
      expect(closed).toBe(true)
    })
  }

  test('a mount becomes ready before exit and leaves its stream connected', async () => {
    const line = '{"operation":"mounted","reference":"worktree","directory":"/checkout"}'
    let closed = false
    async function* output() {
      try {
        yield { stream: 'stdout' as const, text: line.slice(0, 10) }
        yield { stream: 'stdout' as const, text: line.slice(10) + '\nremaining' }
        return { code: 0, signal: null }
      } finally {
        closed = true
      }
    }
    const stream = output()
    const result = await readMountReady(stream, 'worktree mount', new AbortController().signal,
      () => new Promise<void>(() => {}), 1000)
    expect(result).toEqual({ line, remaining: 'remaining' })
    expect(closed).toBe(false)
    await stream.return({ code: 0, signal: null })
    expect(closed).toBe(true)
  })

  test('a malformed mount failure falls back to stderr', async () => {
    async function* output() {
      yield { stream: 'stdout' as const, text: '{\nnot JSON\n' }
      yield { stream: 'stderr' as const, text: 'Mount failed before producing a receipt' }
      return { code: 1, signal: null }
    }
    await expect(readMountReady(output(), 'worktree mount', new AbortController().signal,
      () => new Promise<void>(() => {}), 1000)).rejects.toThrow('Mount failed before producing a receipt')
  })

  test('a status timeout closes its child without waiting for output', async () => {
    let expire!: () => void
    let finish!: (value: any) => void
    const pending = new Promise<any>((resolve) => { finish = resolve })
    let closed = false
    const result = readCommandStream({
      next: () => pending,
      return: async (value: { code: number | null; signal: string | null }) => {
        closed = true
        finish({ done: true, value })
        return { done: true, value }
      },
    }, 'thread status', new AbortController().signal, (milliseconds) => {
      expect(milliseconds).toBe(120_000)
      return new Promise<void>((resolve) => { expire = resolve })
    })
    expect(closed).toBe(false)
    expire()
    try {
      await result
      throw new Error('Expected timeout')
    } catch (error) {
      expect(error).toBeInstanceOf(DeltaCommandError)
      expect((error as DeltaCommandError).code).toBe('timeout')
    }
    expect(closed).toBe(true)
  })
})
