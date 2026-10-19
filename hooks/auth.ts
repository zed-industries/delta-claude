import type { EngineInterface } from 'claude-code'
import { readCommandStream } from './command-reader'
import { commandErrorFromEnvelope } from './thread-commands'

/**
 * Delta needs something from the person first, such as signing in or accepting its beta terms on
 * the web, and they did not do it when offered. The message is complete, ready to
 * show as is, never wrapped in a failure.
 */
export class AccessRequiredError extends Error {}

/**
 * What sign-in needs from the session, as values and callbacks. Claude Code's loader refuses a
 * module that passes `$` across an import, so `register.tsx` builds this from `$` itself.
 */
export type AuthenticationHost = {
  windows: boolean
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
  spawn: (argv: string[]) => ReturnType<EngineInterface['process']['spawn']>
  /** Ask the person in Claude's own dialog; rejects when they dismiss it or no one can be asked. */
  ask: (question: string, options: string[]) => Promise<string>
  /** Open a web page in the person's browser, answering whether it opened. */
  open: (url: string) => Promise<boolean>
}

/** How often, and for how long, sign-in waits for the person to accept the beta terms on the web. */
const TERMS_POLL_MS = 2_000
const TERMS_WAIT_MS = 15 * 60_000

/** Quote the resolved executable for a POSIX shell or PowerShell, never PATH lookup. */
export function authLoginCommand(executable: string, windows: boolean): string {
  return windows
    ? `& '${executable.replace(/'/g, "''")}' auth login`
    : `'${executable.replace(/'/g, "'\"'\"'")}' auth login`
}

/**
 * Authenticate an interactive share, join, setup, or automatic activation using the CLI's app-owned
 * browser login. Callers exclude headless sessions before allowing sign-in to open the browser and wait.
 */
export async function requireAuthentication(
  host: AuthenticationHost,
  executable: string,
  check: () => Promise<void>,
  notice: (text: string) => Promise<void>,
  retry = '/delta-share or /delta-join <link>',
) {
  const { windows } = host
  const recovery = `Resolve access${windows ? ', then run in PowerShell' : ', then run in your shell'}: ${authLoginCommand(executable, windows)}. After signing in again, retry ${retry}.`
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
  // Unaccepted beta terms need the person on the web, so opening them is offered rather than logged.
  // Here and for sign-in, a dismissed dialog, or a surface that cannot ask, declines like "Not now".
  const resolveAccess = async (value: { status: string; reason?: string; message?: string; url?: string }) => {
    if (value.reason !== 'terms_not_accepted') throw authFailure(value, recovery, retry)
    const url = value.url ?? 'https://zed.dev/delta/terms'
    const accept = 'Open the beta terms'
    const answer = await host.ask('Delta needs you to accept its beta terms before it can sync. Open them in your browser?',
      [accept, 'Not now']).catch(() => undefined)
    await check()
    if (answer !== accept)
      throw new AccessRequiredError(`Delta's beta terms aren't accepted. Accept them at ${url}, then run ${retry} again.`)
    if (!await host.open(url)) await notice(`Accept Delta's beta terms in your browser to continue: ${url}`)
    // The app keeps the denied sign-in and hears when the terms are accepted, so its status turns
    // signed in on its own: continue then, with no retry for the person to run.
    for (let waited = 0; waited < TERMS_WAIT_MS; waited += TERMS_POLL_MS) {
      await host.sleep(TERMS_POLL_MS, stopped.signal)
      const status = await request(['status'])
      if (status.status === 'signed_in') return
      if (status.status === 'signing_in' || (status.status === 'access_denied' && status.reason === 'terms_not_accepted')) continue
      throw authFailure(status, recovery, retry)
    }
    throw new AccessRequiredError(`Delta's beta terms still aren't accepted. Accept them at ${url}, then run ${retry} again.`)
  }
  try {
    const status = await request(['status'])
    if (status.status === 'signed_in') return
    if (status.status === 'access_denied') return await resolveAccess(status)
    if (status.status !== 'signed_out' && status.status !== 'signing_in') throw authFailure(status, recovery, retry)
    // Sign-in opens the browser, so it waits for the person to ask for it.
    const signIn = 'Sign in'
    const answer = await host.ask('Delta needs you to sign in before it can sync. Sign in with your browser?',
      [signIn, 'Not now']).catch(() => undefined)
    await check()
    if (answer !== signIn) throw new AccessRequiredError(`Delta isn't signed in. Run ${retry} again to sign in.`)
    await notice('Signing in to Delta… Complete sign-in in your browser to continue.')
    const login = await request(['login', '--no-wait'])
    if (login.status === 'signed_in') return
    if (login.status === 'access_denied') return await resolveAccess(login)
    if (login.status !== 'pending') throw authFailure(login, recovery, retry)
    const expires = Date.parse(login.expires_at)
    if (typeof login.login_id !== 'string' || !login.login_id || typeof login.url !== 'string' ||
        !/^https?:\/\//.test(login.url) || !Number.isFinite(expires))
      throw new Error('Delta returned an invalid sign-in link; update Delta and retry')
    await notice(`Finish signing in to Delta in your browser; this link expires at ${login.expires_at}: ${login.url}`)
    // Detached attempts can be shared by other clients. Stop our waiter, never
    // cancel the app's attempt or sign the account out when Claude changes session.
    const result = await request(['wait', login.login_id], 16 * 60_000)
    if (result.status === 'access_denied') return await resolveAccess(result)
    if (result.status !== 'signed_in') throw authFailure(result, recovery, retry)
  } finally {
    stopped.abort()
  }
}

function authFailure(value: { status: string; reason?: string; message?: string; url?: string }, recovery: string, retry: string): Error {
  switch (value.status) {
    // `requireAuthentication` offers to open the beta terms before reaching here.
    case 'access_denied': return new Error(`Delta access denied: ${value.message ?? 'account access is required'}.${value.url ? ` ${value.url}` : ''} ${recovery}`)
    case 'signed_out': return new Error(`Delta signed out before sign-in finished. Retry ${retry}.`)
    case 'wrong_account': return new Error('Delta is using another account’s data directory. Resolve the account in Delta and retry; the plugin will not switch accounts.')
    case 'cancelled': return new Error(`Delta sign-in was cancelled. Retry ${retry}.`)
    case 'expired': return new Error(`Delta sign-in expired. Retry ${retry}.`)
    default: return new Error(`Unsupported Delta authentication status: ${value.status}. Update Delta and retry.`)
  }
}
