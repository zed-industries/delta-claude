/**
 * `/delta share`: creating or attaching the session's thread, exporting the conversation so far, and
 * publishing it to the chosen audience.
 */
import { AccessRequiredError, requireAuthentication } from '../cli/auth'
import { clearProgress, finishProgress, setProgress, threadOrganization } from '../band/band'
import { messageUpdates, resultUpdate } from '../recording/content'
import {
  drain, flushUnsaved, recordsOffline, recordsPlans, rememberToolResults, stageRecord, verifyCheckout,
} from '../recording/delivery'
import {
  type CommandForm, requireContract, resolveCli, stopSessionMounts, threadCreate, threadInvite, threadShare,
  threadStatus,
} from '../cli/delta-cli'
import { worktreeHistory } from '../cli/command-outcomes'
import { attachWorktree, managedCheckoutRefusal, mountCheckout } from './checkout'
import { activate, followTranscript } from '../setup/activation'
import { activeBackgroundAgents } from './lifecycle'
import { authenticationHost, claudeInteraction } from '../setup/interaction'
import {
  currentOrganizationId, isPersonalOrganizationId, loadOrganizationDirectory, organizationName, savedOrganization,
} from '../setup/organizations'
import { samePath } from '../core/paths'
import {
  activation, type Binding, isPaused, load, pauseCheckout, recoveryCommand, report, requests, resetRuntime, save,
  serial, stateFor, storedBinding,
} from '../core/session-state'
import type { Host } from '../core/host'
import {
  InteractionDismissedError, InteractionUnavailableError, invitationSummary, remoteRefusal, type SessionResume,
  type SessionStop,
} from '../setup/setup'
import { type AudienceAnswer, chooseShareAudience, type ShareAudience } from './share-audience'
import { snapshotMessages } from '../recording/snapshot'
import { children, deliverChild, forgetSubagents, recordsChildren } from '../subagents/subagents'
import { errorText } from '../core/text'
import { validateThreadFrontier } from '../cli/thread-commands'
import { adoptExistingChildren, releaseThreadMounts, restoreChildren } from '../subagents/thread-runs'
import { startConversation, stopConversation, stopWatching } from '../watch/watch'

/**
 * A share to run. With `choose`, the share decides who sees the session once the CLI is checked: the
 * addresses typed after `/delta share`, or else the person's answer. Without it, `audience` decides, as
 * setup asks, or else it shares with the organization, as the band's control asks.
 */
export type ShareRequest = {
  session: string; cwd: string; cancelled?: boolean; form?: CommandForm; choose?: { emails: string[] }; audience?: ShareAudience
}
/**
 * What a share's snapshot holds back: while `gate` is raised, new rows wait for the snapshot to be
 * read; `inFlight` counts the rows already being appended, and `quiet` resolves once the last ends.
 */
const snapshotBarrier: { gate?: Promise<void>; inFlight: number; quiet?: () => void } = { inFlight: 0 }

/** Wait while a share reads its snapshot. */
export async function waitForSnapshot() {
  if (snapshotBarrier.gate) await snapshotBarrier.gate
}

/** Count a row being appended, once any snapshot being read has been. */
export async function beginAppend() {
  // Counted in the same tick when no snapshot is being read, so a share starting now waits for it.
  if (snapshotBarrier.gate) await snapshotBarrier.gate
  snapshotBarrier.inFlight++
}

/** A row's append ended; the last one lets a waiting snapshot start. */
export function endAppend() {
  snapshotBarrier.inFlight--
  if (!snapshotBarrier.inFlight && snapshotBarrier.quiet) {
    snapshotBarrier.quiet()
    snapshotBarrier.quiet = undefined
  }
}

export async function checkoutRoot(host: Host): Promise<string> {
  const result = await host.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: await host.session.cwd() })
  if (result.exitCode !== 0 || result.isStdoutTruncated)
    throw new Error('current directory is not inside a Git checkout; open a checkout first')
  return result.stdout.trim()
}

async function assertShareSession(host: Host, request: ShareRequest) {
  const session = await host.session.id()
  const cwd = await host.session.cwd()
  if (request.cancelled || requests.share !== request || session !== request.session || !samePath(cwd, request.cwd))
    throw new Error('The Claude session or folder changed during share; the obsolete share was stopped')
}

/**
 * Whether a session already syncs: it is on the server, or handed to Delta's background uploader. Such
 * a session keeps its audience when it reconnects; `/delta unshare` can make it private.
 */
export function sessionSyncs(binding: Binding | undefined): boolean {
  return !!binding?.url || !!binding?.autoUpload
}

/** How long `/delta stop` waits for recorded rows to reach Delta before it stops the session anyway. */
const STOP_DRAIN_MS = 5_000

/**
 * Pause a session's sync, for `/delta stop`: send what it recorded, then mark its binding `stopped` and
 * clear `snapshot`, which every recording path and the band's `Syncing` read. The binding keeps its
 * thread, producer and sequence, so `/delta start` or `/delta share` resumes the same thread, and nothing
 * the session says meanwhile is recorded. Its watch, checkout mount and subagents' mounts stop; the
 * checkout's files stay as they are. A joined session, a turn underway, a share or join in flight, or a
 * running subagent is refused, since stopping under any of them would cut a live transition.
 */
export async function stopSessionSync(host: Host, session: string): Promise<SessionStop> {
  const runtime = stateFor(session)
  const binding = runtime.binding
  if (!binding?.snapshot) return { kind: 'none' }
  if (binding.joined || binding.joinTransition)
    return { kind: 'refused', reason: 'it joined a shared thread, which it leaves when the session ends' }
  if (requests.share?.session === session || requests.join)
    return { kind: 'refused', reason: 'a share or join is still running; try again when it finishes' }
  if (runtime.currentTurnId)
    return { kind: 'refused', reason: 'a turn is running; try again when it finishes' }
  // A recorded subagent may be working in a mount the stop releases.
  if (binding.children?.length && activeBackgroundAgents(await host.agent.list()))
    return { kind: 'refused', reason: 'a subagent is still running; try again when it finishes' }
  // Send what was recorded first, but never wait long: Delta may be unreachable. What is left stays
  // queued with its sequence and is sent when the session resumes.
  const cancelled = new AbortController()
  try {
    if (runtime.unsaved.length) await flushUnsaved(host, session)
    if (binding.thread)
      await Promise.race([drain(host, session), host.clock.sleep(STOP_DRAIN_MS, { signal: cancelled.signal })])
  } catch { /* whatever didn't reach Delta stays queued and is counted below */ }
  finally { cancelled.abort() }
  // Work begun under this activation, such as an automatic activation or a send still running, sees it is
  // stale. The session stays the current one, so the band shows its reminder.
  activation.epoch++
  forgetSubagents(session)
  await stopWatching(session)
  try { await stopSessionMounts(session) }
  catch (error) { await host.ui.log(`Delta mount process did not stop: ${String(error)}`, { to: 'debug' }) }
  // An automatic session whose thread isn't created yet keeps its staged setup the same way, and
  // finishes it when it resumes.
  const stopped = await serial(async () => {
    const current = await load(host, session)
    await save(host, { ...current, snapshot: false, stopped: true })
    return current
  })
  runtime.pauses.clear()
  resetRuntime(runtime)
  await releaseThreadMounts(host, session, stopped.children ?? [])
  // A share or join running for another session keeps its progress in the band.
  if (!requests.join && !requests.share) clearProgress(host)
  return { kind: 'stopped', queued: stopped.pending.length + runtime.unsaved.length }
}

/**
 * Undo {@link stopSessionSync}: record the session into its thread again and start its watch and checkout
 * mount, as a resume does. What it said while stopped stays out of the thread. False when it wasn't stopped.
 */
export async function resumeSessionSync(host: Host, session: string): Promise<SessionResume> {
  // A share resumes a stopped session itself; activating beside it would race its attach and mount.
  if (requests.share?.session === session || requests.join)
    return stateFor(session).binding?.stopped
      ? { kind: 'refused', reason: 'a share or join is still running; try again when it finishes' } : { kind: 'none' }
  if (!await clearStop(host, session)) return { kind: 'none' }
  await activate(host, session)
  return { kind: 'resumed' }
}

/** Clear a stopped binding's mark so it records again; false when it wasn't stopped. */
async function clearStop(host: Host, session: string): Promise<boolean> {
  return serial(async () => {
    const current = await load(host, session)
    if (!current.stopped) return false
    const resumed: Binding = { ...current, snapshot: true }
    delete resumed.stopped
    await save(host, resumed)
    return true
  })
}

/**
 * What a finished share reports: the thread's link, which a private share may not have until Delta's
 * background upload registers it, and what the band and transcript say. No `band` means nothing was
 * shared, because the person chose not to.
 */
type ShareOutcome = { url?: string; band?: string; notice?: string }

async function share(host: Host, request: ShareRequest): Promise<ShareOutcome> {
  const { session } = request
  const check = () => assertShareSession(host, request)
  await assertShareSession(host, request)
  const runtime = stateFor(session)
  if (runtime.currentTurnId) throw new Error('Wait for the current Claude turn to finish before sharing or reattaching')
  let binding = await serial(() => load(host, session))
  if (binding.joined || binding.joinTransition)
    throw new Error(`This session joined an already shared thread. Retry ${recoveryCommand(binding)} to reconnect; joining never attaches or republishes a checkout.`)
  if (runtime.unsaved.length) await flushUnsaved(host, session)
  binding = await serial(() => load(host, session))
  if (runtime.captureFailure || binding.captureFailure)
    throw new Error(`a stored Claude row could not be saved locally (${runtime.captureFailure ?? binding.captureFailure}); sharing is paused to avoid an incomplete transcript`)
  // A repository Delta can't identify fails at the attach, after everything else; say so before asking.
  const unidentified = remoteRefusal(await gitRemotes(host, await checkoutRoot(host)), '/delta-share')
  if (unidentified) throw new ShareRefusalError(unidentified)
  // Refuse a CLI this plugin cannot record against before its snapshot fills the local outbox.
  await resolveCli(host, (text) => setProgress(host, text, 'active'))
  await assertShareSession(host, request)
  await requireContract(host, session)
  await assertShareSession(host, request)
  // Asked before anything is staged, so declining leaves the session exactly as it was.
  const chosen: AudienceAnswer = request.choose
    ? await chooseAudience(host, session, request.choose.emails) : request.audience ?? { kind: 'organization' }
  if (chosen.kind === 'none') return chosen.reason ? { notice: chosen.reason } : {}
  const audience = chosen
  await assertShareSession(host, request)
  if (runtime.currentTurnId) throw new Error('Wait for the current Claude turn to finish before sharing or reattaching')
  await requireAuthentication(await authenticationHost(host), await resolveCli(host), check, async (text) => {
    await check()
    setProgress(host, 'Waiting for Delta sign-in…', 'active')
    await host.ui.log(text, { to: 'transcript' })
  })
  await check()
  // Every recorded path is shown relative to the checkout this share attaches.
  const root = await checkoutRoot(host)
  await assertShareSession(host, request)
  // Refused before the snapshot, so a refusal leaves no thread or staged records behind.
  const joined = await joinedBindingAt(host, root)
  if (joined) throw new ShareRefusalError(joinedCheckoutRefusal(root, joined))
  await assertShareSession(host, request)
  // A session `/delta stop` paused already holds its thread and everything it recorded before the stop:
  // sharing resumes it there rather than exporting the conversation again.
  const resumed = await clearStop(host, session)
  if (resumed) binding = await serial(() => load(host, session))
  if (!binding.snapshot) {
    let release!: () => void
    snapshotBarrier.gate = new Promise<void>((resolve) => { release = resolve })
    try {
      if (snapshotBarrier.inFlight) await new Promise<void>((resolve) => { snapshotBarrier.quiet = resolve })
      await assertShareSession(host, request)
      // Appends begun after the gate cannot reach the transcript until the snapshot is read.
      setProgress(host, 'Exporting earlier messages…', 'active', [2, 5])
      const snapshot = snapshotMessages(await host.session.apiMessages())
      await assertShareSession(host, request)
      setProgress(host, `Exporting ${snapshot.length} earlier messages…`, 'active', [2, 5])
      const summaries = await host.session.messages()
      await assertShareSession(host, request)
      const toolResults = new Map(summaries.flatMap((row) =>
        row.toolUses.map((use) => [use.tool_use_id, use] as const)))
      for (const [id, tool] of toolResults) {
        if (tool.result === undefined) continue
        runtime.tools.structuredResults.set(id, resultUpdate(id, tool.tool, tool.result, !!tool.isError, root))
      }
      // Snapshot only the normalized, post-compaction main conversation.
      await serial(async () => {
        let state = await load(host, session)
        await assertShareSession(host, request)
        const plans = recordsPlans(session)
        for (const [index, message] of snapshot.entries()) {
          rememberToolResults(runtime.tools, message, plans)
          const updates = messageUpdates(message, `snapshot:${index}`, runtime.tools.structuredResults,
            { root, omitted: runtime.tools.omitted, plans })
          for (const update of updates) state = await stageRecord(host, state, { update })
        }
        // Commit the complete immutable plan and its pending receipts together. Until
        // this succeeds, neither a retry nor a CLI invocation can see a partial import.
        await save(host, { ...state, snapshot: true })
      })
      runtime.binding = await serial(() => load(host, session))
      // The agents that already ran become child threads too. A failure leaves them unrecorded
      // and never fails the share.
      if (recordsChildren(session)) {
        try { await adoptExistingChildren(host, session) }
        catch (error) { await host.ui.log(`Delta could not record this session's earlier subagents: ${errorText(error)}`, { to: 'transcript' }) }
      }
    } finally {
      // Nothing is recorded before the snapshot, so these hold only its bulk results.
      runtime.tools.structuredResults.clear()
      runtime.tools.toolResults.clear()
      runtime.tools.omitted.clear()
      release()
      snapshotBarrier.gate = undefined
    }
  }
  // Reattachment is the explicit recovery: it lifts every pause but the watcher's, which going live lifts.
  runtime.pauses.clear()
  runtime.checkoutRefusal = undefined
  runtime.deliveryNotice = undefined
  binding = await serial(() => load(host, session))
  await assertShareSession(host, request)
  // A private share hands the thread to Delta's background uploader, as Private sync does, so it needs
  // an organization to upload to even in a repository with no saved team.
  const privateUpload = audience.kind === 'private' && !binding.autoUpload
  if (!binding.thread || privateUpload) {
    // The repository's saved team decides where its sessions go, rather than the organization selected
    // in Delta: creating the thread under it makes the later `thread share` or invitation publish there too.
    // Asking who should see the session read the organization list, so the selected one is known.
    const organization = (binding.thread ? threadOrganization(binding) : undefined) ?? await savedOrganization(host, root) ??
      (privateUpload ? currentOrganizationId : undefined)
    if (privateUpload && !organization)
      throw new Error('Delta has no team to sync this session to; check /delta-org list')
    // Creation is idempotent: for a thread that already exists, it only records the private upload.
    const created = await threadCreate(host, {
      externalId: session, organization: organization ? { id: organization, visibility: 'private' } : undefined, check,
    })
    const knownThread = binding.thread ?? binding.pendingActivation?.thread
    if (knownThread && created.thread_id !== knownThread)
      throw new Error('Delta returned a different thread for this session; the existing binding was preserved')
    if (!knownThread && !created.created) {
      const status = await threadStatus(host, created.thread_id, session)
      validateThreadFrontier(status, { session, thread: created.thread_id, next: binding.next, pending: binding.pending })
      // A durable identity always precedes append. A staged plan alone may have
      // been regenerated after losing the binding, so it cannot prove lineage.
      if (status.producer!.next_sequence !== 1)
        throw new Error('This Delta producer already contains records, but its local thread identity and receipts are missing. Restore the matching producer state or start a new Claude session; do not reset or reuse sequence numbers. The existing Delta conversation was preserved.')
    }
    // Persist identity before further fallible commands; creation is idempotent if this write fails.
    await serial(async () => save(host, {
      ...await load(host, session), thread: created.thread_id, pendingActivation: undefined,
      ...organization ? { organization } : {},
      ...privateUpload ? { autoUpload: { mode: 'private' as const, organization: organization! } } : {},
    }))
    binding = await serial(() => load(host, session))
  }
  // The thread exists from here on: it was bound already, or the creation above saved it.
  const thread = binding.thread
  if (!thread) throw new Error('Delta returned no thread for this session; the existing binding was preserved')
  await assertShareSession(host, request)
  await stopConversation()
  await assertShareSession(host, request)
  // Only now that the watcher is stopped is its pause true; the restarted watch lifts it once live.
  // A session that records offline does not wait for the watcher and takes no such pause.
  if (!recordsOffline(session, binding)) pauseCheckout(runtime, 'watcher')
  setProgress(host, 'Attaching the checkout…', 'active', [3, 5])
  let reference: string
  try { reference = await attachWorktree(host, root, thread, binding.checkoutReference, check, session) }
  catch (error) { throw managedCheckoutRefusal(error, root) }
  await serial(async () => {
    const current = await load(host, session)
    if ((current.checkout && !samePath(current.checkout, root)) ||
        (current.checkoutReference !== undefined && worktreeHistory(current.checkoutReference) !== worktreeHistory(reference)))
      throw new Error('Delta returned a different checkout reference or directory; the existing binding was preserved')
    await save(host, { ...current, checkout: root, checkoutReference: reference, pendingWorktree: undefined })
  })
  try { await mountCheckout(host, { session, checkout: root, checkoutReference: reference }, check) }
  catch (error) { throw managedCheckoutRefusal(error, root) }
  await assertShareSession(host, request)
  let outcome: ShareOutcome = { band: audience.kind === 'unchanged' ? 'Reconnected' : 'Synced privately' }
  if (audience.kind === 'unchanged' && !sessionSyncs(binding))
    throw new Error('This session has not been shared yet; run /delta-share and choose who should see it')
  // Keeping a thread Delta last reported as shared with its organization publishes it again, which is
  // idempotent and restores access the server has since lost.
  if (audience.kind === 'organization' || (audience.kind === 'unchanged' && binding.visibility === 'organization')) {
    setProgress(host, 'Publishing the thread…', 'active', [4, 5])
    const shared = await threadShare(host, thread, { form: request.form, check })
    await serial(async () => save(host, { ...await load(host, session), url: shared.url }))
    outcome = { url: shared.url, band: 'Shared' }
  } else if (audience.kind === 'invite') {
    // Inviting uploads a thread that is not on the server yet privately, so only the people invited see it.
    setProgress(host, 'Sending invitations…', 'active', [4, 5])
    const { url, results } = await threadInvite(host, thread, audience.emails, { form: request.form, check })
    await serial(async () => save(host, { ...await load(host, session), url }))
    const invited = results.filter((result) => result.invited).length
    outcome = {
      url, notice: `${invitationSummary(results, 'this session')} Link: ${url}`,
      band: invited ? `Invited ${invited === 1 ? '1 person' : `${invited} people`}` : 'Synced privately; nobody was invited',
    }
  }
  await assertShareSession(host, request)
  await startConversation(host, session)
  await assertShareSession(host, request)
  setProgress(host, 'Syncing files…', 'active', [5, 5])
  // Claude named the session before it was shared, and polling for a title starts only with a turn, so
  // the title is staged now and delivered with the snapshot. Not before: delivering a record checks the
  // thread is published, and a failed check pauses sharing. A title that cannot be read fails nothing.
  await followTranscript(host, session).catch((error) =>
    host.ui.log(`Couldn't look for this session's title: ${String(error)}`, { to: 'debug' }))
  await drain(host, session)
  for (const child of children.values()) if (child.session === session) void deliverChild(host, child)
  // The stop forgot this session's subagents; they record again as an activation would restore them.
  if (resumed) {
    const restored = await serial(() => load(host, session))
    void restoreChildren(host, session, restored).catch((error) => report(host, error))
  }
  if (isPaused(runtime))
    throw new Error('checkout sharing is paused; saved messages remain queued until reattachment succeeds')
  if (runtime.captureFailure || runtime.unsaved.length)
    throw new Error('a live row could not be saved locally; fix the outbox error and retry /delta-share')
  await verifyCheckout(host, await load(host, session))
  await assertShareSession(host, request)
  runtime.joinFailure = undefined
  return { ...outcome, url: outcome.url ?? (await serial(() => load(host, session))).url }
}

/**
 * The joined session whose mounts include `directory`. A mount's path is unique to its thread and
 * owner, so a match means the directory is that thread's checkout, not one this session can share.
 */
export async function joinedBindingAt(host: Host, directory: string): Promise<Binding | undefined> {
  // A Claude build without `$.store.keys` cannot enumerate the store; Delta still refuses the attach.
  let keys: string[]
  try { keys = await host.store.keys() } catch { return }
  for (const storeKey of keys) {
    if (!storeKey.startsWith('session:')) continue
    const binding = await storedBinding(host, storeKey)
    if (!binding?.joined || !binding.thread) continue
    if (binding.mounts?.some((mount) => samePath(mount.directory, directory))) return binding
  }
}

/**
 * A share this session must not make, refused before anything was staged. Its message names the
 * step to take instead, so it is shown without the advice to retry the share.
 */
class ShareRefusalError extends Error {}

/** What a failed share tells the person: why, and what to retry. */
export function shareFailureText(error: unknown, retry: string): string {
  if (error instanceof ShareRefusalError) return `Delta didn't share this session: ${error.message}.`
  // The message alone, without the error's class name or a second full stop after its own.
  const reason = (errorText(error)).replace(/[.\s]+$/, '')
  return `Delta sharing failed: ${reason}. Fix the issue and retry ${retry}; saved records retain their sequence.`
}

/** A checkout's Git remote names, or undefined when Git cannot list them. */
export async function gitRemotes(host: Host, root: string): Promise<string[] | undefined> {
  const result = await host.process.run(['git', 'remote'], { cwd: root }).catch(() => undefined)
  if (!result || result.exitCode !== 0 || result.isStdoutTruncated) return undefined
  return result.stdout.split('\n').map((name) => name.trim()).filter(Boolean)
}

function joinedCheckoutRefusal(root: string, joined: Binding): string {
  return `${root} is a worktree of the Delta thread ${joined.url ?? joined.thread}, mounted when a Claude session joined it. Sharing it would publish the same files as a separate thread; run /delta-join ${joined.locator ?? joined.thread} to record this conversation in that thread instead`
}

/**
 * Start a share: it is in progress from now, and runs on the clock so `/delta share` returns at once.
 * The band reports its progress, and once the share succeeds it keeps the link on hand, so nothing is
 * added to the transcript.
 */
export function startShare(host: Host, request: ShareRequest) {
  requests.share = request
  setProgress(host, 'Preparing to share…', 'active', [1, 5])
  host.clock.after(0, async () => {
    // The band's share control starts a share before it has read Claude's directory.
    request.cwd ||= await host.session.cwd()
    await runShare(host, request)
  })
}

async function runShare(host: Host, request: ShareRequest) {
  const { session } = request
  try {
    const outcome = await share(host, request)
    if (outcome.band) finishProgress(host, outcome.band, 'done')
    else clearProgress(host)
    if (outcome.notice) await host.ui.log(outcome.notice, { to: 'transcript' })
    if (outcome.url) await host.ui.log(`Delta share link: ${outcome.url}`, { to: 'debug' })
  } catch (error) {
    if (request.cancelled || requests.share !== request) return
    const text = error instanceof AccessRequiredError ? error.message
      : shareFailureText(error, recoveryCommand(stateFor(session).binding))
    setProgress(host, text, 'error')
    await host.ui.log(text, { to: 'transcript' })
  } finally {
    if (requests.share === request) requests.share = undefined
  }
}

/**
 * Decide who a `/delta share` makes the session visible to: the addresses typed after the command, or
 * the person's answer to the question; `none` carries the command's answer when nothing is shared.
 */
async function chooseAudience(host: Host, session: string, typed: string[]): Promise<AudienceAnswer> {
  if (typed.length) return { kind: 'invite', emails: typed }
  const binding = stateFor(session).binding
  await loadOrganizationDirectory(host)
  const organization = (binding ? threadOrganization(binding) : undefined) ??
    await savedOrganization(host, await checkoutRoot(host)) ?? currentOrganizationId
  // A personal organization has nobody to share with, and a thread already shared with its organization stays shared.
  const team = isPersonalOrganizationId(organization ?? '') || binding?.visibility === 'organization' ? undefined
    : organizationName(organization) ?? 'your team'
  try {
    return await chooseShareAudience(claudeInteraction(host), { team, synced: sessionSyncs(binding) })
  } catch (error) {
    if (error instanceof InteractionDismissedError) return { kind: 'none', reason: '' }
    if (error instanceof InteractionUnavailableError)
      return { kind: 'none', reason: "This Claude build cannot show /delta-share's question. Update Claude Code, or type the email addresses to invite after /delta-share." }
    throw error
  }
}

/** Begin the same publication flow `/delta share` runs, for the band's share control. */
export function beginShare(host: Host, session: string, audience?: ShareAudience): boolean {
  if (requests.share) return false
  if (stateFor(session).currentTurnId) {
    requests.shareAfterTurn = { session, ...audience ? { audience } : {} }
    host.ui.invalidate()
    return true
  }
  startShare(host, { session, cwd: '', ...audience ? { audience } : {} })
  return true
}
