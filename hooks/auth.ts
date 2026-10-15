import type { EngineInterface } from 'claude-code'
import { readCommandStream } from './command-reader'
import { commandErrorFromEnvelope } from './thread-commands'

export class PendingAuthenticationError extends Error {}

/**
 * What sign-in needs from the session, as values and callbacks. Claude Code's loader refuses a
 * module that passes `$` across an import, so `register.tsx` builds this from `$` itself.
 */
export type AuthenticationHost = {
  interactive: boolean
  windows: boolean
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
  spawn: (argv: string[]) => ReturnType<EngineInterface['process']['spawn']>
}

/** Quote the resolved executable for a POSIX shell or PowerShell, never PATH lookup. */
export function authLoginCommand(executable: string, windows: boolean): string {
  return windows
    ? `& '${executable.replace(/'/g, "''")}' auth login`
    : `'${executable.replace(/'/g, "'\"'\"'")}' auth login`
}

/** Authenticate only an explicit command, using the CLI's app-owned browser login. */
export async function requireAuthentication(
  host: AuthenticationHost,
  executable: string,
  check: () => Promise<void>,
  notice: (text: string) => Promise<void>,
) {
  const { interactive, windows } = host
  const recovery = `Resolve access${windows ? ', then run in PowerShell' : ', then run in your shell'}: ${authLoginCommand(executable, windows)}. After signing in again, retry /delta-share or /delta-join <link>.`
  const stopped = new AbortController()
  const monitor = async () => {
    while (!stopped.signal.aborted) {
      await host.sleep(250, stopped.signal)
      await check()
    }
  }
  void monitor().catch(() => stopped.abort())
  const request = async (args: string[], timeout = 60_000) => {
    await check()
    if (stopped.signal.aborted) throw new Error('Delta sign-in stopped')
    const stream = host.spawn([executable, '--json', 'auth', ...args])
    const text = await readCommandStream(stream, `auth ${args[0]}`, stopped.signal,
      host.sleep, timeout,
      // Auth reports valid signed-out/denied/cancelled outcomes with exit 1.
      (code, stdout) => {
        if (code === 0) return true
        try { return code === 1 && typeof JSON.parse(stdout)?.status === 'string' } catch { return false }
      })
    await check()
    let value: any
    try { value = JSON.parse(text) } catch { throw new Error('Delta returned invalid authentication output; update Delta and retry') }
    const failure = commandErrorFromEnvelope(value?.error, 'authentication')
    if (failure) throw failure
    if (!value || typeof value.status !== 'string')
      throw new Error('Delta returned no authentication status; update Delta and retry')
    return value
  }
  try {
    const status = await request(['status'])
    if (status.status === 'signed_in') return
    if (status.status !== 'signed_out' && status.status !== 'signing_in') throw authFailure(status, recovery)
    if (interactive) await notice('Signing in to Delta… Complete sign-in in your browser to continue.')
    const login = await request(['login', '--no-wait', ...interactive ? [] : ['--no-browser']])
    if (login.status === 'signed_in') return
    if (login.status !== 'pending') throw authFailure(login, recovery)
    const expires = Date.parse(login.expires_at)
    if (typeof login.login_id !== 'string' || !login.login_id || typeof login.url !== 'string' ||
        !/^https?:\/\//.test(login.url) || !Number.isFinite(expires))
      throw new Error('Delta returned an invalid sign-in link; update Delta and retry')
    if (!interactive)
      throw new PendingAuthenticationError(`Delta sign-in is pending. Open ${login.url} in your browser and finish signing in, then retry /delta-share. This link expires at ${login.expires_at}. No thread has been shared by this command.`)
    await notice(`Finish signing in to Delta in your browser: ${login.url}\nWaiting for sign-in; this link expires at ${login.expires_at}.`)
    // Detached attempts can be shared by other clients. Stop our waiter, never
    // cancel the app's attempt or sign the account out when Claude changes session.
    const result = await request(['wait', login.login_id], 16 * 60_000)
    if (result.status !== 'signed_in') throw authFailure(result, recovery)
  } finally {
    stopped.abort()
  }
}

function authFailure(value: { status: string; message?: string; url?: string }, recovery: string): Error {
  switch (value.status) {
    case 'access_denied': return new Error(`Delta access denied: ${value.message ?? 'account access is required'}. ${value.url ?? ''}\n${recovery}`)
    case 'wrong_account': return new Error('Delta is using another account’s data directory. Resolve the account in Delta and retry; the plugin will not switch accounts.')
    case 'cancelled': return new Error('Delta sign-in was cancelled. Retry /delta-share or /delta-join <link>.')
    case 'expired': return new Error('Delta sign-in expired. Retry /delta-share or /delta-join <link>.')
    default: return new Error(`Unsupported Delta authentication status: ${value.status}. Update Delta and retry.`)
  }
}
