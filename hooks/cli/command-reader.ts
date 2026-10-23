import { isJsonObject } from '../core/json'
import { errorText } from '../core/text'
import { commandErrorFromEnvelope, DeltaCommandError } from './thread-commands'

type Exit = { code: number | null; signal: string | null }
type Output = { stream: 'stdout' | 'stderr'; text: string }
type Stream = AsyncIterator<Output, Exit>

/** Collect a CLI response, closing its child on timeout, cancellation, or completion. */
export async function readCommandStream(
  stream: Stream, name: string, signal: AbortSignal,
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<unknown>,
  timeoutMs = 120_000,
  acceptsExit: (code: number | null, stdout: string) => boolean = (code) => code === 0,
): Promise<string> {
  const encoder = new TextEncoder()
  const limit = 16 * 1024 * 1024
  const stop = () => { void stream.return?.({ code: null, signal: 'SIGTERM' }).catch(() => {}) }
  signal.addEventListener('abort', stop, { once: true })
  const deadline = new AbortController()
  let timedOut = false
  void sleep(timeoutMs, deadline.signal).then(() => {
    timedOut = true
    stop()
  // The deadline's sleep rejects when the command ends first and cancels it.
  }).catch(() => {})
  const chunks: string[] = []
  let bytes = 0
  let stderr = ''
  try {
    while (true) {
      let piece: Awaited<ReturnType<Stream['next']>>
      try { piece = await stream.next() }
      catch (error) {
        if (signal.aborted) throw new Error(`Delta ${name} cancelled`)
        throw new DeltaCommandError('process_failed', `${name}: ${errorText(error)}`)
      }
      if (signal.aborted) throw new Error(`Delta ${name} cancelled`)
      if (timedOut) throw new DeltaCommandError('timeout', `Delta ${name} timed out`)
      if (piece.done) {
        const stdout = chunks.join('')
        if (!acceptsExit(piece.value.code, stdout)) {
          let failure: DeltaCommandError | undefined
          // Output that is not JSON carries no typed error; stderr then says what failed.
          try { failure = commandErrorFromEnvelope(JSON.parse(stdout)?.error, name) } catch {}
          throw failure ?? new DeltaCommandError('process_failed',
            `${name}: ${stderr || `exit ${piece.value.code ?? piece.value.signal ?? 'unknown'}`}`)
        }
        return stdout
      }
      if (piece.value.stream === 'stderr') {
        stderr = (stderr + piece.value.text.slice(-4000)).slice(-4000)
        continue
      }
      if (piece.value.text.length > limit - bytes)
        throw new Error(`Delta ${name} exceeds the transport limit`)
      bytes += encoder.encode(piece.value.text).byteLength
      if (bytes > limit) throw new Error(`Delta ${name} exceeds the transport limit`)
      if (chunks.length && chunks[chunks.length - 1]!.length + piece.value.text.length <= 64 * 1024)
        chunks[chunks.length - 1] += piece.value.text
      else chunks.push(piece.value.text)
    }
  } finally {
    deadline.abort()
    signal.removeEventListener('abort', stop)
    await stream.return?.({ code: null, signal: 'SIGTERM' })
  }
}

/** Read a mount's first JSON line, leaving its child connected after readiness. */
export async function readMountReady(
  stream: Stream, name: string, signal: AbortSignal,
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<unknown>,
  timeoutMs: number,
): Promise<{ line: string; remaining: string }> {
  const encoder = new TextEncoder()
  const deadline = new AbortController()
  let timedOut = false
  let ready = false
  let stdout = ''
  let stderr = ''
  let bytes = 0
  const stop = () => { void stream.return?.({ code: null, signal: 'SIGTERM' }).catch(() => {}) }
  signal.addEventListener('abort', stop, { once: true })
  void sleep(timeoutMs, deadline.signal).then(() => {
    timedOut = true
    stop()
  // The deadline's sleep rejects when the mount becomes ready first and cancels it.
  }).catch(() => {})
  try {
    while (true) {
      let piece: Awaited<ReturnType<Stream['next']>>
      try { piece = await stream.next() }
      catch (error) {
        if (signal.aborted) throw new Error(`Delta ${name} cancelled`)
        throw new DeltaCommandError('process_failed', `${name}: ${errorText(error)}`)
      }
      if (signal.aborted) throw new Error(`Delta ${name} cancelled`)
      if (timedOut) throw new DeltaCommandError('timeout', `Delta ${name} timed out`)
      if (piece.done) {
        let failure: DeltaCommandError | undefined
        // Output that is not JSON carries no typed error; stderr then says what failed.
        try { failure = commandErrorFromEnvelope(JSON.parse(stdout)?.error, name) } catch {}
        throw failure ?? new DeltaCommandError('process_failed',
          `${name}: ${stderr || `exit ${piece.value.code ?? piece.value.signal ?? 'unknown'}`}`)
      }
      if (piece.value.stream === 'stderr') {
        stderr = (stderr + piece.value.text.slice(-4000)).slice(-4000)
        continue
      }
      bytes += encoder.encode(piece.value.text).byteLength
      if (bytes > 16 * 1024 * 1024)
        throw new DeltaCommandError('process_failed', `${name}: readiness output exceeds the transport limit`)
      stdout += piece.value.text
      const newline = stdout.indexOf('\n')
      if (newline < 0) continue
      const line = stdout.slice(0, newline).trim()
      let response: unknown
      try { response = JSON.parse(line) }
      catch { throw new DeltaCommandError('process_failed', `${name}: invalid readiness receipt`) }
      const failure = commandErrorFromEnvelope(isJsonObject(response) ? response.error : undefined, name)
      if (failure) throw failure
      ready = true
      return { line, remaining: stdout.slice(newline + 1) }
    }
  } finally {
    deadline.abort()
    signal.removeEventListener('abort', stop)
    if (!ready) await stream.return?.({ code: null, signal: 'SIGTERM' })
  }
}
