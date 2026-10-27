/**
 * Starting a session's recording: activating its binding, continuing a conversation Claude Code moved
 * to a new session, the setup offer, automatic recording from the repository's policy, and pruning.
 */
import { AccessRequiredError, requireAuthentication } from '../cli/auth'
import { clearProgress, finishProgress, setProgress, type SyncReminder } from '../band/band'
import { childKey } from '../subagents/children'
import {
  collectAcknowledgedOutbox, drain, endDeliveryFailures, recordsOffline, recoverExecution, scheduleOutboxCleanup,
} from '../recording/delivery'
import { CONTRACT_TIMEOUT_MS, requireContract, resolveCli, threadCreate } from '../cli/delta-cli'
import { authenticationHost, claudeInteraction, notifyOnce, setupEnv } from './interaction'
import { attachWorktree, beginRestoreCheckout, checkoutNeedsMount, mountCheckout } from '../sharing/checkout'
import { beginRestore, claimHandoff, pendingHandoff, startParticipation } from '../sharing/join'
import { hasInteractiveSurface } from '../sharing/lifecycle'
import { listOrganizations, organizationName } from './organizations'
import { policyPath, type ProjectPolicy, readProjectPolicy, recordsAutomatically } from './project-policy'
import {
  activation, type AutoUpload, type Binding, boundDirectory, drawnRowKey, isPaused, key, ledgerKey, load, pauseCheckout,
  producerOf, rememberTranscriptPath, report, requests, resumeCheckout, type Runtime, save, serial, sessions,
  type SessionState, stateFor, stillActive, storedBinding, transcriptPathOf,
} from '../core/session-state'
import { offerOnboarding, type OnboardingStore, releaseOnboarding } from './setup'
import { checkoutRoot, joinedBindingAt } from '../sharing/share'
import { restoreAbandonedWorktrees, storedChildBinding } from '../subagents/subagents'
import {
  classifyCommandFailure, ContractRefusalError, DeltaCommandError, permanentFailureAdvice,
} from '../cli/thread-commands'
import { errorText } from '../core/text'
import { restoreChildren } from '../subagents/thread-runs'
import { FS_READ_LIMIT, readFrom, recordTitle } from '../recording/title'
import { claudeConfigDir, expectedTranscript, findTranscript } from '../core/transcript'
import { followUpload, startConversation, stopConversation } from '../watch/watch'

/** The plugin's folder under Claude's configuration, shared by every Claude process on the machine. */
export let pluginData = ''
/** Where recorded conversations stage their records, under the plugin's folder. */
export let outbox = ''

/** Automatic activation has not finished: the binding exposes its thread only once every step succeeded. */
export function activationIncomplete(runtime: SessionState): boolean {
  return !!runtime.binding?.autoUpload && !runtime.binding.thread
}

/**
 * A prompt or a resume is an automatic session's repair path: re-run whatever activation steps are
 * missing, using the upload the session already recorded. Every step is idempotent, so this is safe.
 */
export function retryAutomaticActivation($: Runtime, session: string, runtime: SessionState) {
  const binding = runtime.binding
  // The activation reports its own failures in the band, and the next prompt retries it.
  if (binding?.autoUpload && !binding.thread && binding.checkout)
    void activateAutomatically($, session, binding.checkout, binding.autoUpload).catch(() => {})
}

export async function activate($: Runtime, session: string, isCurrent = () => true) {
  const epoch = ++activation.epoch
  const ownsActivation = () => epoch === activation.epoch && isCurrent()
  activation.activating = session
  try {
    const config = await claudeConfigDir($)
    if (!ownsActivation()) return
    if (!config) throw new Error('Cannot locate Claude configuration; set CLAUDE_CONFIG_DIR.')
    pluginData = `${config}/delta-plugin`
    outbox = `${pluginData}/outbox`
    if (activation.session !== session) await stopConversation()
    if (!ownsActivation()) return
    activation.session = session
    let binding = await serial(() => load($, session))
    if (!ownsActivation()) return
    // A session that resumes is live again: drop the end marker so bounded cleanup never removes it.
    if (binding.endedAt !== undefined) {
      const live = { ...binding }
      delete live.endedAt
      await serial(() => save($, live))
      binding = live
    }
    // A conversation Claude Code moved here from a recording session keeps recording, here.
    if (continuationCandidate(session, binding)) {
      const parent = await continuedFrom($, session)
      if (!ownsActivation()) return
      if (parent) binding = await adoptContinuation($, session, parent.session) ?? binding
      if (!ownsActivation()) return
    }
    const runtime = stateFor(session)
    runtime.binding = binding
    runtime.captureFailure ??= binding.captureFailure
    if (binding.joinTransition) {
      await report($, new Error(`The join directory transition is incomplete. Run /delta-join ${binding.joinTransition.locator} to retry the saved mount${binding.directory ? ` at ${binding.directory}` : ''}; prompts remain blocked.`))
      return
    }
    // A session Desktop started in a hand-off's folder joins it before its first prompt.
    if (!binding.snapshot && !binding.joined && !runtime.handoffClaim) {
      const handoff = await pendingHandoff($, await $.session.cwd())
      if (!ownsActivation()) return
      if (handoff) {
        runtime.handoffClaim = claimHandoff($, session, handoff)
        return
      }
    }
    endDeliveryFailures(runtime)
    scheduleOutboxCleanup($, binding)
    // Bounded store retention: entries for sessions that ended long ago are pruned only when they
    // hold nothing a later session would need. It never blocks activation.
    void pruneStore($).catch(() => {})
    // An automatic session whose activation never finished, for example because Delta was unreachable
    // when it started, resumes that activation rather than waiting for a thread it does not have yet.
    if (activationIncomplete(runtime)) {
      retryAutomaticActivation($, session, runtime)
      return
    }
    // A shared session's own checkout stays synchronized only while this process runs its mount.
    const needsCheckoutMount = checkoutNeedsMount(session, binding)
    if (binding.snapshot && boundDirectory(binding)) {
      pauseCheckout(runtime, 'watcher')
      try { await requireContract($, session) }
      catch (error) {
        if (!ownsActivation()) return
        const text = `Delta participation is blocked: ${errorText(error)}`
        // Only an explicit /delta share or /delta join after updating Delta lifts this pause.
        pauseCheckout(runtime, 'delivery', text)
        runtime.joinFailure = text
        setProgress($, text, 'error')
        await $.ui.log(text, { to: 'transcript' })
        return
      }
      // A session whose mounts this process has not confirmed is resuming: Claude may be anywhere.
      if (binding.joined && !runtime.mounted) {
        beginRestore($, session)
        return
      }
    }
    if (needsCheckoutMount) {
      beginRestoreCheckout($, session)
      return
    }
    if (binding.snapshot && boundDirectory(binding)) {
      if (recordsOffline(session, binding)) {
        // Offline recording does not wait for the watcher: start it in the background and let a
        // prompt or the outbox proceed meanwhile.
        resumeCheckout(runtime, 'watcher')
        void startConversation($, session).catch((error) => { if (ownsActivation()) void report($, error) })
      } else {
        try { await startParticipation($, session, binding, ownsActivation) }
        catch (error) { if (ownsActivation()) await report($, error) }
      }
      // An automatic session follows Delta's background upload on its own timer, so the link appears
      // even when the watcher never becomes ready.
      if (ownsActivation() && binding.autoUpload) followUpload($, session)
      if (ownsActivation() && !isPaused(runtime)) await recoverExecution($, session)
    }
    if (ownsActivation() && !runtime.captureFailure && binding.thread && binding.pending.length)
      void drain($, session).catch((error) => report($, error))
    if (ownsActivation() && binding.children?.length)
      void restoreChildren($, session, binding).catch((error) => report($, error))
  } finally {
    if (epoch === activation.epoch) activation.activating = ''
  }
}

/** Resume the recovery steps activation skipped while it waited for a mount. */
export async function finishRestoredActivation($: Runtime, session: string, binding: Binding, owns: () => boolean) {
  const runtime = stateFor(session)
  if (binding.autoUpload) followUpload($, session)
  if (!isPaused(runtime)) await recoverExecution($, session)
  if (!owns()) return
  if (!runtime.captureFailure && binding.pending.length)
    void drain($, session).catch((error) => report($, error))
  if (binding.children?.length)
    void restoreChildren($, session, binding).catch((error) => report($, error))
}

/**
 * How each session started (`startup`, `clear` or `resume`), until the session ends. Claude reports it
 * only to `classic.SessionStart`, which the organization's built-in guard (`cc-plugin-sec-default`)
 * keeps from every plugin a person installs, so `noticeSession` works it out instead. A fork of a
 * conversation cannot be told from a resume, so it counts as one.
 */
const sessionStarts = new Map<string, string>()
/** The session this process started last: while it is set, a hook knows no other session has begun. */
let startedSession: string | undefined
/** The session that ended last; a hook still running for it starts nothing. */
let endedSession: string | undefined
/**
 * How the session after the one that ended starts: `/clear` makes a new one, `/resume` and `/branch` one
 * with history, and the `/clear` a join runs makes the one the join takes over.
 */
let successor: 'clear' | 'resume' | 'join' | undefined
/** The starts being worked out, so two hooks that notice one session wait for the same work. */
const noticing = new Map<string, Promise<boolean>>()
/** How often a session's transcript was looked for and not found, which stops the looking at {@link MAX_TRANSCRIPT_MISSES}. */
const transcriptMisses = new Map<string, number>()
const MAX_TRANSCRIPT_MISSES = 3

/**
 * `session.start` ran for a session, which has been activated by now: work out how it started. A session
 * that ended while the hook ran starts nothing.
 */
export async function noticeStart($: Runtime, session: string) {
  if (activation.session !== session) return
  // A session started again under the id of one that ended starts anew.
  if (endedSession === session) endedSession = undefined
  await noticeSession($, session)
}

/**
 * Begin a session this process has not started yet: one starting at launch or when the plugin is
 * enabled (`session.start`), or one Claude starts after `/clear` or `/resume`, which raise no
 * `session.start`. Its source is what the end of the session before it said, else `startup` for a
 * session with no prompts yet and `resume` for one with history.
 *
 * The first activity of a session calls this before it waits on the session's capture boundary, so it
 * returns at once once the session has begun. It waits only until the source is known and the boundary
 * open: the rest of the start (`activate`) appends rows of its own, whose hooks call this too.
 */
export async function noticeSession($: Runtime, session?: string) {
  if (startedSession !== undefined && (session === undefined || session === startedSession)) return
  const id = session ?? await $.session.id()
  if (id === endedSession) return
  const running = noticing.get(id)
  if (running) {
    await running
    return
  }
  if (sessionStarts.has(id)) {
    startedSession = id
    return
  }
  const deciding = decideStart($, id)
  noticing.set(id, deciding)
  let begins: boolean
  try { begins = await deciding } finally { noticing.delete(id) }
  if (begins) void beginSession($, id).catch((error) => report($, error))
}

/**
 * Work out how a session started, and open its capture boundary when it is new. Whether its start is
 * still to run: the session a join's `/clear` starts is the join's.
 */
async function decideStart($: Runtime, session: string): Promise<boolean> {
  const after = successor
  successor = undefined
  let source: string = after === 'join' ? 'clear' : after ?? 'resume'
  if (!after) {
    // A failed read must not take a session that may hold history for a new one, which records from now on.
    try { source = await $.session.turns() === 0 ? 'startup' : 'resume' } catch {}
  }
  sessionStarts.set(session, source)
  startedSession = session
  if (after === 'join') return false
  // A join, running or done, as a hand-off's is by now, decides what its session records.
  if (newSessionFor(session) && !requests.join && !sessions.get(session)?.binding?.joined) beginCaptureDecision(session)
  return true
}

/**
 * What a session's start does once its source is known: load its binding, then offer or begin
 * recording off the hook's critical path. Only a new session (startup or clear) is recorded
 * automatically; one with history is offered setup and keeps whatever policy it had.
 */
async function beginSession($: Runtime, session: string) {
  // A session that ended without its end hook left its isolated subagents' worktrees beside links.
  void restoreAbandonedWorktrees($).catch((error) => report($, error))
  // Claude names a transcript by its working directory and session. A new session's file appears with
  // its first row, and the first turn's end finds it then.
  try {
    const expected = await expectedTranscript($, session)
    if (expected && !transcriptPathOf(session) && await $.fs.exists(expected)) rememberTranscriptPath(session, expected)
  } catch { /* the first turn's end looks for the transcript again */ }
  // A session that ended meanwhile, which forgets its start, starts nothing.
  if (!sessionStarts.has(session)) return
  if (requests.join) {
    // A join runs its own transition and never auto-activates, so nothing waits on this session.
    decideCapture(session)
    return
  }
  const binding = sessions.get(session)?.binding
  // `session.start` or a prompt may have activated the session already; activating it again would stop
  // what that activation started, such as a setup. One that continues another session's conversation
  // is activated again, which takes the conversation over now that its start is known.
  let activates = activation.session !== session || !binding
  if (!activates && binding && continuationCandidate(session, binding)) {
    try { activates = await continuedFrom($, session) !== undefined }
    catch (error) { await report($, error) }
  }
  if (activates) {
    try { await activate($, session) }
    catch (error) { await report($, error) }
  }
  // The offer and activation never delay a prompt.
  const midSession = !newSessionFor(session)
  $.clock.after(0, () => {
    if (midSession && (activation.session !== session || requests.join)) return
    void startSession($, session, midSession).catch((error) => { void report($, error) })
  })
}

/**
 * Remember where a turn left the transcript and its title. Looking for the file stops after a few
 * misses, as a session that keeps no transcript would otherwise search for it at every turn.
 */
export async function followTranscript($: Runtime, session: string) {
  if ((transcriptMisses.get(session) ?? 0) >= MAX_TRANSCRIPT_MISSES) return
  const path = await findTranscript($, session, transcriptPathOf(session))
  if (!path) {
    transcriptMisses.set(session, (transcriptMisses.get(session) ?? 0) + 1)
    return
  }
  await rememberTranscript($, session, path)
  await recordTitle($, session, path)
}

/** A session that ended forgets how it started and its open setup offer, and releases its capture boundary. */
export async function forgetSessionStart($: Runtime, session: string, reason: string) {
  sessionStarts.delete(session)
  transcriptMisses.delete(session)
  // Claude starts the session after this one with no `session.start`, so the reason it ended says how.
  endedSession = session
  startedSession = undefined
  successor = reason === 'clear' && requests.join ? 'join'
    : reason === 'clear' || reason === 'resume' ? reason : undefined
  // A setup offer still open when its session ends was never decided, so the next session offers it again.
  const offer = openOnboarding.get(session)
  openOnboarding.delete(session)
  if (offer) {
    try { await releaseOnboarding(onboardingStore($), offer) }
    catch { /* the offer then simply stays consumed, as before */ }
  }
  // A session that ended can never reach its capture boundary; release anything held on it.
  decideCapture(session)
}

/** How much of a transcript's end is searched for the record of a continuation. */
const CONTINUATION_WINDOW_BYTES = 64 * 1024
/** A session that ended longer ago than this is not the one a starting session continues. */
const CONTINUATION_HORIZON_MS = 10 * 60 * 1000

/**
 * The session a transcript says its conversation continued in. Claude Code appends a
 * `continued-in` record when it moves a conversation to a background session (`/background`, or
 * opening the agents overview), and the new session starts with a copy under a new ID. The record
 * is undocumented and written on a best-effort basis, so its absence proves nothing.
 */
async function continuationOf($: Runtime, transcript: string): Promise<string | undefined> {
  const { size } = await $.fs.stat(transcript)
  let text = ''
  try { await readFrom($, transcript, Math.max(0, size - CONTINUATION_WINDOW_BYTES), (piece) => { text += piece }) }
  catch {
    if (size > FS_READ_LIMIT) return
    text = await $.fs.read(transcript) as string
  }
  let continuation: string | undefined
  for (const line of text.split('\n')) {
    if (!line.includes('"continued-in"')) continue
    try {
      const row = JSON.parse(line)
      if (row?.type === 'continued-in' && typeof row.continuedInSessionId === 'string') continuation = row.continuedInSessionId
    } catch { /* a partial first line from the window, or another row */ }
  }
  return continuation
}

/**
 * Whether `session` may continue another session's conversation: it started with the conversation's
 * history, as a continuation does, and it has recorded nothing of its own.
 */
export function continuationCandidate(session: string, binding: Binding): boolean {
  return sessionStarts.get(session) === 'resume' && !binding.thread && !binding.snapshot && !binding.joinTransition
}

/** The recording session whose conversation Claude Code continued as `session`, if any. */
export async function continuedFrom($: Runtime, session: string): Promise<Binding | undefined> {
  // A Claude build without `$.store.keys` cannot enumerate the store; the continuation goes unrecorded.
  let keys: string[]
  try { keys = await $.store.keys() } catch { return }
  const now = await $.clock.now()
  for (const storeKey of keys) {
    if (!storeKey.startsWith('session:') || storeKey === key(session)) continue
    const candidate = await storedBinding($, storeKey)
    if (!candidate?.thread || !candidate.snapshot) continue
    if (candidate.continuedIn === session) return candidate
    if (candidate.continuedIn || !candidate.transcript) continue
    if (candidate.endedAt !== undefined && candidate.endedAt < now - CONTINUATION_HORIZON_MS) continue
    try { if (await continuationOf($, candidate.transcript) === session) return candidate }
    catch { /* an unreadable transcript continues nothing */ }
  }
}

/**
 * Make `session` the recorder of the conversation it continues: it takes over the binding, keeps
 * recording as the same producer from the same sequence, and keeps the mount owner, so restoring
 * re-mounts the same checkouts under this process. The parent is marked first; from then on it
 * stages and delivers nothing, so the two never write the same sequence.
 */
export async function adoptContinuation($: Runtime, session: string, parentSession: string): Promise<Binding | undefined> {
  return serial(async () => {
    const current = await load($, session)
    if (current.thread || current.snapshot) return
    const parent = await load($, parentSession)
    if (!parent.thread || (parent.continuedIn && parent.continuedIn !== session)) return
    await save($, { ...parent, continuedIn: session })
    const adopted: Binding = {
      ...parent, session, producer: producerOf(parent),
      owner: parent.joined ? parent.owner ?? parent.session : parent.owner,
      transcript: transcriptPathOf(session),
    }
    delete adopted.continuedIn
    delete adopted.endedAt
    // Subagent bindings are stored under the session that ran them, which keeps delivering them.
    delete adopted.children
    // The copied transcript already shows the remote items the parent added for Claude.
    const ledger = await $.store.get(ledgerKey(parentSession))
    if (ledger !== undefined && await $.store.get(ledgerKey(session)) === undefined)
      await $.store.set(ledgerKey(session), ledger)
    await save($, adopted)
    await $.ui.log(`Delta: this conversation continued from Claude session ${parentSession}; recording carries on in this session.`, { to: 'debug' })
    return adopted
  })
}

/** Keep a recording session's transcript path current, since a `/cd` can move the file. */
export async function rememberTranscript($: Runtime, session: string, transcript: string) {
  if (!rememberTranscriptPath(session, transcript)) return
  await serial(async () => {
    const current = await load($, session)
    if (current.thread && !current.continuedIn) await save($, current)
  })
}

/** Whether this session's conversation moved to another session, which now owns its mounts. */
export async function handedOff($: Runtime, session: string): Promise<boolean> {
  const binding = await storedBinding($, key(session))
  if (!binding?.thread) return false
  if (binding.continuedIn) return true
  const transcript = transcriptPathOf(session) ?? binding.transcript
  if (!transcript) return false
  let continuation: string | undefined
  try { continuation = await continuationOf($, transcript) } catch { return false }
  if (!continuation || continuation === session) return false
  // Marking here lets the continuation adopt even before its own start finds the record.
  await serial(async () => save($, { ...await load($, session), continuedIn: continuation }))
  return true
}

export function newSessionFor(session: string): boolean {
  const source = sessionStarts.get(session)
  return source === 'startup' || source === 'clear'
}

/**
 * A new session's capture boundary: row capture, `prompt.submit`, and `turn.start` wait on this until
 * the policy and contract decision is made. Before the decision the session holds no snapshot, so
 * activity let through early would be dropped; the promise resolves for every outcome, including a
 * refusal, and the contract check that bounds it is itself bounded by `CONTRACT_TIMEOUT_MS`.
 */
type CaptureDecision = { promise: Promise<void>; resolve: () => void }
const captureDecisions = new Map<string, CaptureDecision>()

/** Open the capture boundary for a session that is about to decide whether it records automatically. */
export function beginCaptureDecision(session: string) {
  if (captureDecisions.has(session)) return
  let resolve!: () => void
  const promise = new Promise<void>((yes) => { resolve = yes })
  captureDecisions.set(session, { promise, resolve })
}

/** Resolve the boundary once made, whatever the outcome; a second call is harmless. */
export function decideCapture(session: string) {
  captureDecisions.get(session)?.resolve()
  captureDecisions.delete(session)
}

/** Hold new-session activity until its capture boundary exists, or nothing when there is none. */
export async function captureDecided(session: string): Promise<void> {
  await captureDecisions.get(session)?.promise
}

/**
 * Read a checkout's policy at a session's start: show a policy problem once, auto-activate a new
 * session when the policy records automatically, and offer setup when nothing configures the repo.
 * A running session the plugin was just loaded into (`loadedMidSession`) is offered setup like a
 * new one but never auto-activated, since part of it already happened unrecorded.
 * Everything here runs off the startup hook's critical path.
 */
export async function startSession($: Runtime, session: string, loadedMidSession = false) {
  const env = setupEnv($)
  const newSession = newSessionFor(session)
  let root: string
  let policy: ProjectPolicy
  try {
    try { root = await checkoutRoot($) }
    // Outside a checkout there is nothing to record or offer.
    catch { return }
    const path = policyPath(root)
    try { policy = readProjectPolicy(await env.readFile(path)).policy }
    catch (error) {
      await notifyOnce($, `Delta settings at ${path} couldn't be read (${errorText(error)}). Until it's fixed, only sessions you share with /delta-share sync.`)
      return
    }
    if (policy.problem)
      await notifyOnce($, `Delta settings at ${path} couldn't be used (${policy.problem}). Until it's fixed, only sessions you share with /delta-share sync. Run /delta-setup to replace it.`)
    if (newSession && recordsAutomatically(policy) && await joinedBindingAt($, root))
      await notifyOnce($, `${root} is a worktree of a Delta thread a Claude session joined, so this session isn't recorded automatically. Run /delta-join with that thread's link to record in it.`)
    else if (newSession && recordsAutomatically(policy))
      await activateAutomatically($, session, root,
        { mode: policy.mode === 'private' ? 'private' : 'organization', organization: policy.organization! })
  } finally {
    // Nothing below records, so the session's activity never waits on the setup offer's dialog.
    decideCapture(session)
  }
  // Headless sessions get no reminder and are never offered setup; only an interactive surface shows them.
  if (!hasInteractiveSurface(await $.session.surfaces())) return
  stateFor(session).reminder = syncReminder(policy)
  $.ui.invalidate('ui.render')
  try {
    await offerOnboarding(env, claudeInteraction($), onboardingStore($), {
      root, configured: policy.configured, newToPlugin: newSession || loadedMidSession,
      joined: !!stateFor(session).binding?.joined, joining: !!requests.join,
    }, (key) => { openOnboarding.set(session, key) })
  } finally {
    openOnboarding.delete(session)
  }
  // A setup the offer opened may have saved a setting; the band follows it.
  await refreshReminder($, session)
}

/** Re-read the checkout's setting after a setup, so the band's reminder follows what was saved. */
export async function refreshReminder($: Runtime, session: string) {
  try {
    const root = await checkoutRoot($)
    stateFor(session).reminder = syncReminder(readProjectPolicy(await setupEnv($).readFile(policyPath(root))).policy)
  } catch { /* outside a checkout or unreadable: the band keeps what it had */ }
  $.ui.invalidate('ui.render')
}

/** The onboarding marker each session's still-open setup offer holds, cleared if the session ends first. */
const openOnboarding = new Map<string, string>()

function onboardingStore($: Runtime): OnboardingStore {
  return {
    get: (key) => $.store.get(key),
    set: (key, value) => $.store.set(key, value).then(() => undefined),
  }
}

/**
 * The band's reminder for a session while Delta does not sync it: a checkout with any setting points
 * to /delta-share, and one never set up to /delta-setup. A syncing session's band says `Syncing`
 * instead, so an automatic checkout's sessions show this only when they are not syncing, as a session
 * started before the setting was saved, or one Delta could not start.
 */
function syncReminder(policy: ProjectPolicy): SyncReminder {
  // Someone who chose a setting is not nudged toward setup every session.
  return policy.configured ? 'manual' : 'not set up'
}

/** Auto-activations already running in this process, so a repeated startup hook cannot create twice. */
export const autoActivating = new Map<string, Promise<void>>()

/**
 * Create the thread a repository's policy asks for, request its upload intent, attach the checkout,
 * and start recording. Nothing drains or verifies the checkout until create, upload, and attach have
 * all succeeded: only then is the binding's thread and checkout made visible, so a row or prompt that
 * arrives mid-activation sees a session that is still simply local. Creation is idempotent by
 * external id, so an interrupted activation is safely re-run — from the next prompt, or a startup.
 *
 * The session's capture boundary is released once the contract gate and snapshot are settled, before
 * any network step, so a prompt or turn that arrives during create or attach is recorded
 * rather than dropped. Every await re-checks ownership: a session that ended, or that switched away
 * while a step was pending, leaves no half-initialized binding behind.
 */
function activateAutomatically($: Runtime, session: string, root: string, upload: AutoUpload): Promise<void> {
  const running = autoActivating.get(session)
  if (running) return running
  const ownsActivation = stillActive(session)
  const task = (async () => {
    const runtime = stateFor(session)
    if (activation.session !== session || requests.join) return
    const existing = await serial(() => load($, session))
    if (!ownsActivation()) return
    // A session that already holds a thread, or a binding that is not ours, is never re-created.
    if (existing.thread || (existing.snapshot && !existing.autoUpload) || existing.joined || existing.joinTransition) return
    // A fresh session checks the account against the policy alongside the contract, so a repository
    // this account cannot record to is reported before anything is staged.
    const misconfiguration = existing.snapshot ? undefined : policyMisconfiguration($, upload.organization)
    try {
      // Refuse an incompatible CLI before persisting anything, so it leaves the session manual rather
      // than holding a half-initialized automatic binding.
      await requireContract($, session)
      if (!ownsActivation()) return
      const refusal = await misconfiguration
      if (!ownsActivation()) return
      const interactive = hasInteractiveSurface(await $.session.surfaces())
      if (!ownsActivation()) return
      if (refusal && !(refusal === SIGNED_OUT_REFUSAL && interactive)) {
        await stopAutomaticRecording($, session, root, refusal)
        return
      }
      // The session is new, so its snapshot is already taken: no history is exported, and live capture
      // starts with the first row. The intent is durable before any network, so a session whose server
      // is briefly unavailable retries from the next prompt. No thread or checkout is published yet,
      // so nothing drains against a checkout that is not attached or a thread that is not uploaded.
      if (!existing.snapshot) {
        const staged: Binding = { session, snapshot: true, next: 1, pending: [], checkout: root, autoUpload: upload }
        await serial(() => save($, staged))
        runtime.binding = staged
      }
      if (!ownsActivation()) return
      // The snapshot exists now, so new-session activity may pass; the network steps stay asynchronous.
      decideCapture(session)
      if (interactive) {
        // Authentication may wait on the browser for minutes. Capture locally first, so the person
        // can keep working and this same session uploads everything once sign-in finishes.
        const check = async () => {
          if (!ownsActivation()) throw new Error('Delta automatic sign-in stopped')
        }
        try {
          await requireAuthentication(await authenticationHost($), await resolveCli($), check, async (text) => {
            await check()
            setProgress($, 'Waiting for Delta sign-in…', 'active')
            await $.ui.log(text, { to: 'transcript' })
          }, '/delta-share')
        } catch (error) {
          if (!ownsActivation()) return
          // A cancelled or failed login needs an explicit retry, never another browser on each prompt.
          await stopAutomaticRecording($, session, root, {
            band: 'Not syncing: Delta sign-in incomplete · /delta-share',
            // An access requirement already says nothing was synced and how to retry.
            transcript: error instanceof AccessRequiredError ? error.message
              : `${errorText(error)} This session isn't syncing. Run /delta-share to retry.`,
          })
          return
        }
        if (!ownsActivation()) return
        if (refusal === SIGNED_OUT_REFUSAL) {
          // Only the signed-in account can answer which organizations it belongs to.
          const afterSignIn = await policyMisconfiguration($, upload.organization)
          if (!ownsActivation()) return
          if (afterSignIn) {
            await stopAutomaticRecording($, session, root, afterSignIn)
            return
          }
        }
      }
      setProgress($, 'Connecting this session to Delta…', 'active')
      const created = await threadCreate($, {
        externalId: session, organization: { id: upload.organization, visibility: upload.mode },
      })
      if (!ownsActivation()) return
      const reference = await attachWorktree($, root, created.thread_id, existing.checkoutReference, undefined, session)
      if (!ownsActivation()) return
      await serial(async () => save($, { ...await load($, session), checkoutReference: reference, pendingWorktree: undefined }))
      await mountCheckout($, { session, checkout: root, checkoutReference: reference }, async () => {
        if (!ownsActivation()) throw new Error('The session ended while its checkout was being mounted')
      })
      if (!ownsActivation()) return
      // Every step succeeded: now the thread and checkout become visible to drain and verification.
      await serial(async () => save($, {
        ...await load($, session), thread: created.thread_id, checkout: root, checkoutReference: reference,
      }))
      if (!ownsActivation()) return
      runtime.binding = await serial(() => load($, session))
      void startConversation($, session).catch((error) => { if (ownsActivation()) void report($, error) })
      void drain($, session).catch((error) => { if (ownsActivation()) void report($, error) })
      // The band now follows Delta's background upload until Delta confirms it, whether or not the
      // watcher becomes ready: a status read is what reports the thread's link.
      clearProgress($)
      followUpload($, session)
    } catch (error) {
      if (!ownsActivation()) return
      // Retrying cannot change a permanent answer, so the session stops recording instead of queuing
      // records that would never be sent.
      if (classifyCommandFailure(error) === 'permanent') {
        await stopAutomaticRecording($, session, root, activationRefusal(error, upload.organization))
        return
      }
      // Only a staged session gets this far: everything before staging fails permanently.
      const text = `Delta couldn't start syncing this session: ${errorText(error)}. Nothing is lost; Delta retries on your next prompt.`
      setProgress($, text, 'error')
      await notifyOnce($, text)
    }
  })()
  autoActivating.set(session, task)
  void task.finally(() => { if (autoActivating.get(session) === task) autoActivating.delete(session) })
  return task
}

/** What the band and the transcript say when a repository's policy cannot record this session. */
type ActivationRefusal = { band: string; transcript: string }

const SIGNED_OUT_REFUSAL: ActivationRefusal = {
  band: 'Not syncing: sign in with `delta auth login`',
  transcript: "This repository syncs Claude Code sessions to DeltaDB, but Delta is signed out, so this session isn't syncing. Sign in with `delta auth login`; new sessions then sync automatically.",
}

function notMemberRefusal(organization: string): ActivationRefusal {
  const name = organizationName(organization)
  return {
    band: "Not syncing: your Delta account isn't in this repo's team · /delta-share",
    transcript: `This repository syncs sessions to ${name ? `${name} (${organization})` : organization}, which your Delta account isn't a member of, so this session isn't syncing. Use /delta-share to share it with your own team, ask to be added to ${name ?? 'that team'}, or run /delta-setup if the settings name the wrong team.`,
  }
}

/**
 * Check the signed-in account against the organization a policy records to. Only a definite answer
 * refuses: an empty or unreadable list (Delta not running, memberships not loaded yet) lets
 * activation proceed, and `thread create` checks membership again.
 */
async function policyMisconfiguration($: Runtime, organization: string): Promise<ActivationRefusal | undefined> {
  try {
    // Bounded like the contract check it runs beside, since new-session activity waits on both.
    const organizations = await listOrganizations($, CONTRACT_TIMEOUT_MS)
    if (organizations.length && !organizations.some((known) => known.id === organization))
      return notMemberRefusal(organization)
  } catch (error) {
    if (error instanceof DeltaCommandError && error.code === 'authentication_required') return SIGNED_OUT_REFUSAL
  }
}

/** Describe a permanent activation failure, recognizing the account problems a person can fix. */
function activationRefusal(error: unknown, organization: string): ActivationRefusal {
  if (error instanceof DeltaCommandError && error.reason === 'organization_not_member') return notMemberRefusal(organization)
  if (error instanceof DeltaCommandError && error.code === 'authentication_required') return SIGNED_OUT_REFUSAL
  if (error instanceof ContractRefusalError)
    return { band: `Not syncing: ${error.message}`, transcript: `This session isn't syncing: ${error.message}.` }
  const advice = error instanceof DeltaCommandError
    ? permanentFailureAdvice(error.code, true, error.reason) : 'Fix the cause, then start a new session'
  return {
    band: `Not syncing: ${advice}`,
    transcript: `Delta couldn't start syncing this session: ${errorText(error)}. This session isn't syncing. ${advice}.`,
  }
}

/**
 * End automatic recording for a session the policy cannot record: drop any staged binding and its
 * outbox, so the session is simply manual again and nothing retries or grows, then report why. A
 * later /delta share exports the whole conversation from Claude's transcript, so nothing is lost.
 *
 * The band shows the refusal for the whole session. The transcript explains it once per repository
 * and refusal, remembered in the store, so every new session in a misconfigured repository stays quiet.
 */
async function stopAutomaticRecording($: Runtime, session: string, root: string, refusal: ActivationRefusal) {
  await serial(async () => {
    const binding = await load($, session)
    if (!binding.autoUpload || binding.thread) return
    await $.store.delete(key(session))
    const runtime = stateFor(session)
    runtime.binding = await load($, session)
    runtime.cleanedThrough = undefined
    // Inside `serial`, so a share that starts next cannot stage a record this removal deletes. The
    // outbox is only disk, so a failed removal leaves orphans, never a wrong binding.
    try { await collectAcknowledgedOutbox($, { session, root: outbox, next: binding.next, pending: [] }) }
    catch (error) {
      try { await $.ui.log(`Delta outbox removal after stopping automatic recording failed: ${String(error)}`, { to: 'debug' }) }
      catch { /* the debug log is best effort; the orphaned files harm nothing */ }
    }
  })
  finishProgress($, refusal.band, 'error')
  const marker = `auto-refused:${await setupEnv($).gitCommonDir() ?? root}`
  try {
    if (await $.store.get(marker) === refusal.transcript) return
    await $.store.set(marker, refusal.transcript)
  } catch { /* an unreadable marker only repeats the explanation */ }
  await $.ui.log(refusal.transcript, { to: 'transcript' })
}

/** How long after a session really ends its store entries may be removed; resuming into them dies past it. */
const STORE_HORIZON_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Remove the store entries (`session:` binding and `appended:` ledger) of sessions that really ended
 * before the horizon and hold nothing a later session would need. A binding without an end marker may
 * be live in another Claude process, so it is never removed, and neither is any session in use here.
 *
 * The store is shared by every Claude process and has no transactions, so each session is read,
 * checked, and deleted in turn: a resume elsewhere can only be lost in that one read-to-delete window.
 */
async function pruneStore($: Runtime) {
  // A Claude build without `$.store.keys` cannot enumerate the store, so retention is skipped there.
  let keys: string[]
  try { keys = await $.store.keys() } catch { return }
  const now = await $.clock.now()
  const ids = new Set(keys.flatMap((storeKey) => /^(?:session|appended):(.+)$/.exec(storeKey)?.[1] ?? []))
  for (const id of ids) {
    if (sessions.has(id)) continue
    const binding = await storedBinding($, key(id))
    if (typeof binding?.endedAt !== 'number' || binding.endedAt > now - STORE_HORIZON_MS ||
        binding.pending?.length || binding.captureFailure || binding.joinTransition) continue
    // A subagent's undelivered records keep its session, like the session's own.
    const recorded = await Promise.all((binding.children ?? []).map((agentId) =>
      storedChildBinding($, id, agentId)))
    if (recorded.some((child) => child?.pending.length)) continue
    for (const agentId of binding.children ?? []) await $.store.delete(childKey(id, agentId))
    await $.store.delete(key(id))
    await $.store.delete(ledgerKey(id))
    for (const storeKey of keys) if (storeKey.startsWith(drawnRowKey(id, ''))) await $.store.delete(storeKey)
  }
}
