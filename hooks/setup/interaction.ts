/**
 * What the setup wizard, sign-in and onboarding need from the session: Claude's question dialog, the
 * browser, and the host bindings they run against.
 */
import { type AuthenticationHost, type BrowserWait, requireAuthentication } from '../cli/auth'
import { clearProgress, reportedProgress, type Progress, setProgress } from '../band/band'
import { authStatus, INTEGRATION_ENV, orgInvite, resolveCli, threadContract } from '../cli/delta-cli'
import { createOrganization, listOrganizations } from './organizations'
import { samePath } from '../core/paths'
import { activation, stateFor, stillActive } from '../core/session-state'
import type { Host } from '../core/host'
import {
  type AskOption, type AskOptions, type Interaction, InteractionDismissedError, InteractionUnavailableError,
  type SetupEnv,
} from './setup'
import { beginShare, checkoutRoot, gitRemotes, sessionSyncs } from '../sharing/share'
import { errorText } from '../core/text'

/** The sign-in waiting on the person's browser, which running a Delta command again offers to stop. */
let browserWait: { on: BrowserWait; stop: AbortController } | undefined

/** Sign-in's view of the session. */
export async function authenticationHost(host: Host): Promise<AuthenticationHost> {
  const windows = await host.env.os() === 'Windows_NT'
  const stop = new AbortController()
  let progress: Progress | undefined
  return {
    windows,
    sleep: (milliseconds, signal) => host.clock.sleep(milliseconds, { signal }),
    spawn: (argv) => host.process.spawn({ argv, env: { ...INTEGRATION_ENV } }),
    ask: (question, options) => claudeInteraction(host).ask(question, { options, header: 'Delta' }),
    open: (url) => openInBrowser(host, url, windows),
    waiting: (waitingFor) => {
      if (waitingFor) {
        browserWait = { on: waitingFor, stop }
        setProgress(host, waitingFor === 'terms' ? "Waiting for Delta's beta terms…" : 'Waiting for Delta sign-in…', 'active')
        progress = reportedProgress()
        return
      }
      if (browserWait?.stop === stop) browserWait = undefined
      // What follows sets its own progress; a band still showing the wait would outlive it.
      if (progress && reportedProgress() === progress) clearProgress(host)
    },
    stop: stop.signal,
  }
}

/**
 * Offer to stop a sign-in waiting on the browser, answering whether one was waiting. Whatever waited
 * reports the outcome itself, so the command that asked adds nothing of its own.
 */
export async function offerToStopWaiting(host: Host): Promise<boolean> {
  const wait = browserWait
  if (!wait) return false
  const stop = 'Stop waiting'
  const answer = await claudeInteraction(host).ask(wait.on === 'terms'
    ? 'Delta is waiting for you to accept its beta terms in your browser. Stop waiting?'
    : 'Delta is waiting for you to finish signing in with your browser. Stop waiting?',
  { options: [stop, 'Keep waiting'], header: 'Delta' }).catch(() => undefined)
  if (answer === stop) wait.stop.abort()
  return true
}

/** How long opening a link may take; the opener returns once it has handed the link on. */
export const OPEN_TIMEOUT_MS = 5_000

/**
 * Open a web page in the person's browser, answering whether it opened. macOS has `open`; elsewhere
 * that name is missing or another program, so its failure falls back to the desktop's `xdg-open`.
 */
async function openInBrowser(host: Host, url: string, windows: boolean): Promise<boolean> {
  const attempts = windows ? [['rundll32', 'url.dll,FileProtocolHandler', url]] : [['open', url], ['xdg-open', url]]
  for (const argv of attempts) {
    const opened = await host.process.run(argv, { timeoutMs: OPEN_TIMEOUT_MS }).catch(() => ({ exitCode: 1 }))
    if (opened.exitCode === 0) return true
  }
  return false
}

/** The host bindings the setup wizard and onboarding run against. */
export function setupEnv(host: Host): SetupEnv {
  const session = activation.session
  const active = stillActive(session)
  let cwd: string | undefined
  const check = async () => {
    if (!active() || await host.session.id() !== session ||
        (cwd !== undefined && !samePath(await host.session.cwd(), cwd)))
      throw new Error('The Claude session or folder changed during setup; the obsolete setup was stopped')
  }
  return {
    checkoutRoot: async () => {
      cwd = await host.session.cwd()
      await check()
      return checkoutRoot(host)
    },
    // Linked worktrees share the common directory, so they share one onboarding marker. Git before
    // 2.31 has no `--path-format`, so the directory is resolved against the checkout root instead.
    gitCommonDir: async () => {
      try {
        const root = await checkoutRoot(host)
        const result = await host.process.run(['git', 'rev-parse', '--git-common-dir'], { cwd: root })
        if (result.exitCode !== 0 || result.isStdoutTruncated) return undefined
        const lines = result.stdout.trim().split('\n')
        if (lines.length !== 1 || !lines[0]) return undefined
        return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(lines[0]) ? lines[0] : `${root}/${lines[0]}`
      } catch { return undefined }
    },
    remotes: async () => gitRemotes(host, await checkoutRoot(host)),
    // Opening links from a plugin needs macOS's `open`; anywhere else the person opens it.
    openLink: async (url) => {
      const opened = await host.process.run(['open', url], { timeoutMs: 10_000 }).catch(() => undefined)
      return opened?.exitCode === 0
    },
    contract: async () => {
      let progress: Progress | undefined
      try {
        await check()
        await resolveCli(host, (text) => {
          setProgress(host, text, 'active')
          progress = reportedProgress()
        })
        await check()
        const contract = await threadContract(host)
        await check()
        return contract
      } finally {
        if (progress && reportedProgress() === progress) clearProgress(host)
      }
    },
    authenticate: async (notice) => {
      await requireAuthentication(await authenticationHost(host), await resolveCli(host), check, notice, '/delta-setup')
      await check()
    },
    organizations: () => listOrganizations(host),
    login: async () => (await authStatus(host)).login,
    createOrganization: (name) => createOrganization(host, name),
    inviteMembers: (organization, emails) => orgInvite(host, organization, emails),
    readFile: async (path) => await host.fs.exists(path) ? await host.fs.read(path) : undefined,
    writeFile: (path, text) => host.fs.write(path, text) as Promise<void>,
    // A joined thread is someone else's shared thread; an organization or unlisted one is already
    // visible beyond this account.
    sessionAudience: async () => {
      const binding = stateFor(await host.session.id()).binding
      if (binding?.joined || (binding?.visibility && binding.visibility !== 'private')) return 'shared'
      return sessionSyncs(binding) ? 'private' : 'none'
    },
    shareSession: async (audience) => beginShare(host, await host.session.id(), { kind: audience }),
  }
}

/**
 * How many of the plugin's own questions are open. `$.ui.ask` runs as an `AskUserQuestion` tool call,
 * which is the plugin talking to the person, not the conversation, so it is never recorded.
 */
let ownQuestions = 0

/** Whether one of the plugin's own questions is open, so its `AskUserQuestion` call is not recorded. */
export function isAskingOwnQuestion(): boolean {
  return ownQuestions > 0
}

/**
 * The option hints of the plugin's own open questions, by question text. `$.ui.ask` takes labels
 * only, so the `AskUserQuestion` render hook adds these as the options' descriptions.
 */
const questionHints = new Map<string, Readonly<Record<string, string>>>()

/**
 * Add the hints of the plugin's own open questions to the dialog's options, as their descriptions.
 * Claude Code draws the original when a rewrite doesn't fit the question's schema, so anything
 * unexpected is passed on unchanged; another plugin's or Claude's own question has no hints.
 */
export function withQuestionHints(questions: unknown[]): unknown[] | undefined {
  let changed = false
  const hinted = questions.map((question) => {
    const hints = questionHints.get((question as { question?: unknown })?.question as string)
    const options = (question as { options?: unknown })?.options
    if (!hints || !Array.isArray(options)) return question
    changed = true
    return {
      ...question as object,
      options: options.map((option) => {
        const hint = hints[(option as { label?: string })?.label ?? '']
        return hint ? { ...option, description: hint } : option
      }),
    }
  })
  return changed ? hinted : undefined
}

/** `Array.isArray` does not narrow a readonly array out of a union, so `AskOptions` needs its own guard. */
function isOptionList(options: AskOptions): options is readonly AskOption[] {
  return Array.isArray(options)
}

/** The interactive surface the wizard speaks through: `$.ui.ask`, when this Claude build has it. */
export function claudeInteraction(host: Host): Interaction {
  return {
    async ask(question, options) {
      let answer: unknown
      const { descriptions, ...asked } = isOptionList(options) ? { options, descriptions: undefined } : options
      ownQuestions++
      if (descriptions) questionHints.set(question, descriptions)
      try { answer = await host.ui.ask(question, asked as never) }
      catch (error) {
        // A missing method is a build without the question API; a dismissed dialog rejects too.
        if (error instanceof TypeError) throw new InteractionUnavailableError(errorText(error))
        throw new InteractionDismissedError(errorText(error))
      }
      finally {
        ownQuestions--
        if (questionHints.get(question) === descriptions) questionHints.delete(question)
      }
      if (answer === undefined || answer === null || answer === '') throw new InteractionDismissedError('dismissed')
      if (typeof answer === 'string') return answer
      const wrapped = answer as { label?: string; value?: string }
      return wrapped.label ?? wrapped.value ?? ''
    },
    log: async (text, to) => {
      // The transcript flattens an embedded newline to U+FFFD (see `showToPerson`), so a multi-line
      // message, like the policy file setup previews, goes out one entry per line.
      if (to !== 'transcript') return await host.ui.log(text, to ? { to } : undefined)
      for (const line of text.replace(/\n+$/, '').split('\n')) await host.ui.log(line, { to })
    },
  }
}

/** Log a notice to the transcript at most once per process. */
const noticesShown = new Set<string>()
export async function notifyOnce(host: Host, text: string) {
  if (noticesShown.has(text)) return
  noticesShown.add(text)
  await host.ui.log(text, { to: 'transcript' })
}
