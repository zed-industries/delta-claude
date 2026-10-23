/**
 * `/delta share`: creating or attaching the session's thread, exporting the conversation so far, and
 * publishing it to the chosen audience.
 */
import { AccessRequiredError, requireAuthentication } from '../cli/auth'
import { clearProgress, finishProgress, setProgress, threadOrganization } from '../band/band'
import { messageUpdates, resultUpdate } from '../recording/content'
import { drain, flushUnsaved, recordsOffline, rememberToolResults, stageRecord, verifyCheckout } from '../recording/delivery'
import {
  type CommandForm, requireContract, resolveCli, threadCreate, threadInvite, threadShare, threadStatus,
} from '../cli/delta-cli'
import { worktreeHistory } from '../cli/command-outcomes'
import { attachWorktree, mountCheckout } from './checkout'
import { authenticationHost, claudeInteraction } from '../setup/interaction'
import {
  currentOrganizationId, isPersonalOrganizationId, loadOrganizationDirectory, organizationName, savedOrganization,
} from '../setup/organizations'
import { samePath } from '../core/paths'
import {
  type Binding, isPaused, load, pauseCheckout, recoveryCommand, requests, type Runtime, save, serial, stateFor,
  storedBinding,
} from '../core/session-state'
import { InteractionDismissedError, InteractionUnavailableError, invitationSummary, remoteRefusal } from '../setup/setup'
import { type AudienceAnswer, chooseShareAudience, type ShareAudience } from './share-audience'
import { snapshotMessages } from '../recording/snapshot'
import { children, deliverChild, recordsChildren } from '../subagents/subagents'
import { errorText } from '../core/text'
import { DeltaCommandError, validateThreadFrontier } from '../cli/thread-commands'
import { adoptExistingChildren } from '../subagents/thread-runs'
import { startConversation, stopConversation } from '../watch/watch'

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

export async function checkoutRoot($: Runtime): Promise<string> {
  const result = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: await $.session.cwd() })
  if (result.exitCode !== 0 || result.isStdoutTruncated)
    throw new Error('current directory is not inside a Git checkout; open a checkout first')
  return result.stdout.trim()
}

async function assertShareSession($: Runtime, request: ShareRequest) {
  const session = await $.session.id()
  const cwd = await $.session.cwd()
  if (request.cancelled || requests.share !== request || session !== request.session || !samePath(cwd, request.cwd))
    throw new Error('The Claude session or folder changed during share; the obsolete share was stopped')
}

/**
 * Whether a session already syncs: it is on the server, or handed to Delta's background uploader. Such
 * a session keeps its audience when it reconnects and cannot become private to its owner again.
 */
export function sessionSyncs(binding: Binding | undefined): boolean {
  return !!binding?.url || !!binding?.autoUpload
}

/**
 * What a finished share reports: the thread's link, which a private share may not have until Delta's
 * background upload registers it, and what the band and transcript say. No `band` means nothing was
 * shared, because the person chose not to.
 */
type ShareOutcome = { url?: string; band?: string; notice?: string }

async function share($: Runtime, request: ShareRequest): Promise<ShareOutcome> {
  const { session } = request
  const check = () => assertShareSession($, request)
  await assertShareSession($, request)
  const runtime = stateFor(session)
  if (runtime.currentTurnId) throw new Error('Wait for the current Claude turn to finish before sharing or reattaching')
  let binding = await serial(() => load($, session))
  if (binding.joined || binding.joinTransition)
    throw new Error(`This session joined an already shared thread. Retry ${recoveryCommand(binding)} to reconnect; joining never attaches or republishes a checkout.`)
  if (runtime.unsaved.length) await flushUnsaved($, session)
  binding = await serial(() => load($, session))
  if (runtime.captureFailure || binding.captureFailure)
    throw new Error(`a stored Claude row could not be saved locally (${runtime.captureFailure ?? binding.captureFailure}); sharing is paused to avoid an incomplete transcript`)
  // A repository Delta can't identify fails at the attach, after everything else; say so before asking.
  const unidentified = remoteRefusal(await gitRemotes($, await checkoutRoot($)), '/delta-share')
  if (unidentified) throw new ShareRefusalError(unidentified)
  // Refuse a CLI this plugin cannot record against before its snapshot fills the local outbox.
  await resolveCli($, (text) => setProgress($, text, 'active'))
  await assertShareSession($, request)
  await requireContract($, session)
  await assertShareSession($, request)
  // Asked before anything is staged, so declining leaves the session exactly as it was.
  const chosen: AudienceAnswer = request.choose
    ? await chooseAudience($, session, request.choose.emails) : request.audience ?? { kind: 'organization' }
  if (chosen.kind === 'none') return chosen.reason ? { notice: chosen.reason } : {}
  const audience = chosen
  await assertShareSession($, request)
  if (runtime.currentTurnId) throw new Error('Wait for the current Claude turn to finish before sharing or reattaching')
  await requireAuthentication(await authenticationHost($), await resolveCli($), check, async (text) => {
    await check()
    setProgress($, 'Waiting for Delta sign-in…', 'active')
    await $.ui.log(text, { to: 'transcript' })
  })
  await check()
  // Every recorded path is shown relative to the checkout this share attaches.
  const root = await checkoutRoot($)
  await assertShareSession($, request)
  // Refused before the snapshot, so a refusal leaves no thread or staged records behind.
  const joined = await joinedBindingAt($, root)
  if (joined) throw new ShareRefusalError(joinedCheckoutRefusal(root, joined))
  await assertShareSession($, request)
  if (!binding.snapshot) {
    let release!: () => void
    snapshotBarrier.gate = new Promise<void>((resolve) => { release = resolve })
    try {
      if (snapshotBarrier.inFlight) await new Promise<void>((resolve) => { snapshotBarrier.quiet = resolve })
      await assertShareSession($, request)
      // Appends begun after the gate cannot reach the transcript until the snapshot is read.
      setProgress($, 'Exporting earlier messages…', 'active', [2, 5])
      const snapshot = snapshotMessages(await $.session.messages({ as: 'api' }))
      await assertShareSession($, request)
      setProgress($, `Exporting ${snapshot.length} earlier messages…`, 'active', [2, 5])
      const summaries = await $.session.messages()
      await assertShareSession($, request)
      const toolResults = new Map(summaries.flatMap((row) =>
        row.toolUses.map((use) => [use.tool_use_id, use] as const)))
      for (const [id, tool] of toolResults) {
        if (tool.result === undefined) continue
        runtime.tools.structuredResults.set(id, resultUpdate(id, tool.tool, tool.result, !!tool.isError, root))
      }
      // Snapshot only the normalized, post-compaction main conversation.
      await serial(async () => {
        let state = await load($, session)
        await assertShareSession($, request)
        for (const [index, message] of snapshot.entries()) {
          rememberToolResults(runtime.tools, message)
          const updates = messageUpdates(message, `snapshot:${index}`, runtime.tools.structuredResults,
            { root, omitted: runtime.tools.omitted })
          for (const update of updates) state = await stageRecord($, state, { update })
        }
        // Commit the complete immutable plan and its pending receipts together. Until
        // this succeeds, neither a retry nor a CLI invocation can see a partial import.
        await save($, { ...state, snapshot: true })
      })
      runtime.binding = await serial(() => load($, session))
      // The agents that already ran become child threads too. A failure leaves them unrecorded
      // and never fails the share.
      if (recordsChildren(session)) {
        try { await adoptExistingChildren($, session) }
        catch (error) { await $.ui.log(`Delta could not record this session's earlier subagents: ${errorText(error)}`, { to: 'transcript' }) }
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
  runtime.deliveryNotice = undefined
  binding = await serial(() => load($, session))
  await assertShareSession($, request)
  // A private share hands the thread to Delta's background uploader, as Private sync does, so it needs
  // an organization to upload to even in a repository with no saved team.
  const privateUpload = audience.kind === 'private' && !binding.autoUpload
  if (!binding.thread || privateUpload) {
    // The repository's saved team decides where its sessions go, rather than the organization selected
    // in Delta: creating the thread under it makes the later `thread share` or invitation publish there too.
    // Asking who should see the session read the organization list, so the selected one is known.
    const organization = (binding.thread ? threadOrganization(binding) : undefined) ?? await savedOrganization($, root) ??
      (privateUpload ? currentOrganizationId : undefined)
    if (privateUpload && !organization)
      throw new Error('Delta has no team to sync this session to; check /delta-org list')
    // Creation is idempotent: for a thread that already exists, it only records the private upload.
    const created = await threadCreate($, {
      externalId: session, organization: organization ? { id: organization, visibility: 'private' } : undefined, check,
    })
    if (binding.thread && created.thread_id !== binding.thread)
      throw new Error('Delta returned a different thread for this session; the existing binding was preserved')
    if (!binding.thread && !created.created) {
      const status = await threadStatus($, created.thread_id, session)
      validateThreadFrontier(status, { session, thread: created.thread_id, next: binding.next, pending: binding.pending })
      // A durable identity always precedes append. A staged plan alone may have
      // been regenerated after losing the binding, so it cannot prove lineage.
      if (status.producer!.next_sequence !== 1)
        throw new Error('This Delta producer already contains records, but its local thread identity and receipts are missing. Restore the matching producer state or start a new Claude session; do not reset or reuse sequence numbers. The existing Delta conversation was preserved.')
    }
    // Persist identity before further fallible commands; creation is idempotent if this write fails.
    await serial(async () => save($, {
      ...await load($, session), thread: created.thread_id, ...organization ? { organization } : {},
      ...privateUpload ? { autoUpload: { mode: 'private' as const, organization: organization! } } : {},
    }))
    binding = await serial(() => load($, session))
  }
  // The thread exists from here on: it was bound already, or the creation above saved it.
  const thread = binding.thread
  if (!thread) throw new Error('Delta returned no thread for this session; the existing binding was preserved')
  await assertShareSession($, request)
  await stopConversation()
  await assertShareSession($, request)
  // Only now that the watcher is stopped is its pause true; the restarted watch lifts it once live.
  // A session that records offline does not wait for the watcher and takes no such pause.
  if (!recordsOffline(session, binding)) pauseCheckout(runtime, 'watcher')
  setProgress($, 'Attaching the checkout…', 'active', [3, 5])
  let reference: string
  try { reference = await attachWorktree($, root, thread, binding.checkoutReference, check, session) }
  catch (error) {
    // A checkout Delta manages for another thread, which no session here joined.
    if (error instanceof DeltaCommandError && error.reason === 'worktree_directory_in_use')
      throw new Error(`${root} is a checkout Delta manages for another thread, so it can't be shared as this one. Run /delta-join with that thread's link to work there (${error.message})`)
    throw error
  }
  await serial(async () => {
    const current = await load($, session)
    if ((current.checkout && !samePath(current.checkout, root)) ||
        (current.checkoutReference !== undefined && worktreeHistory(current.checkoutReference) !== worktreeHistory(reference)))
      throw new Error('Delta returned a different checkout reference or directory; the existing binding was preserved')
    await save($, { ...current, checkout: root, checkoutReference: reference, pendingWorktree: undefined })
  })
  await mountCheckout($, { session, checkout: root, checkoutReference: reference }, check)
  await assertShareSession($, request)
  let outcome: ShareOutcome = { band: audience.kind === 'unchanged' ? 'Reconnected' : 'Synced privately' }
  if (audience.kind === 'unchanged' && !sessionSyncs(binding))
    throw new Error('This session has not been shared yet; run /delta-share and choose who should see it')
  // Keeping a thread Delta last reported as shared with its organization publishes it again, which is
  // idempotent and restores access the server has since lost.
  if (audience.kind === 'organization' || (audience.kind === 'unchanged' && binding.visibility === 'organization')) {
    setProgress($, 'Publishing the thread…', 'active', [4, 5])
    const shared = await threadShare($, thread, { form: request.form, check })
    await serial(async () => save($, { ...await load($, session), url: shared.url }))
    outcome = { url: shared.url, band: 'Shared' }
  } else if (audience.kind === 'invite') {
    // Inviting uploads a thread that is not on the server yet privately, so only the people invited see it.
    setProgress($, 'Sending invitations…', 'active', [4, 5])
    const { url, results } = await threadInvite($, thread, audience.emails, { form: request.form, check })
    await serial(async () => save($, { ...await load($, session), url }))
    const invited = results.filter((result) => result.invited).length
    outcome = {
      url, notice: `${invitationSummary(results, 'this session')} Link: ${url}`,
      band: invited ? `Invited ${invited === 1 ? '1 person' : `${invited} people`}` : 'Synced privately; nobody was invited',
    }
  }
  await assertShareSession($, request)
  await startConversation($, session)
  await assertShareSession($, request)
  setProgress($, 'Syncing files…', 'active', [5, 5])
  await drain($, session)
  for (const child of children.values()) if (child.session === session) void deliverChild($, child)
  if (isPaused(runtime))
    throw new Error('checkout sharing is paused; saved messages remain queued until reattachment succeeds')
  if (runtime.captureFailure || runtime.unsaved.length)
    throw new Error('a live row could not be saved locally; fix the outbox error and retry /delta-share')
  await verifyCheckout($, await load($, session))
  await assertShareSession($, request)
  runtime.joinFailure = undefined
  return { ...outcome, url: outcome.url ?? (await serial(() => load($, session))).url }
}

/**
 * The joined session whose mounts include `directory`. A mount's path is unique to its thread and
 * owner, so a match means the directory is that thread's checkout, not one this session can share.
 */
export async function joinedBindingAt($: Runtime, directory: string): Promise<Binding | undefined> {
  // A Claude build without `$.store.keys` cannot enumerate the store; Delta still refuses the attach.
  let keys: string[]
  try { keys = await $.store.keys() } catch { return }
  for (const storeKey of keys) {
    if (!storeKey.startsWith('session:')) continue
    const binding = await storedBinding($, storeKey)
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
export async function gitRemotes($: Runtime, root: string): Promise<string[] | undefined> {
  const result = await $.process.run(['git', 'remote'], { cwd: root }).catch(() => undefined)
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
export function startShare($: Runtime, request: ShareRequest) {
  requests.share = request
  setProgress($, 'Preparing to share…', 'active', [1, 5])
  $.clock.after(0, async () => {
    // The band's share control starts a share before it has read Claude's directory.
    request.cwd ||= await $.session.cwd()
    await runShare($, request)
  })
}

async function runShare($: Runtime, request: ShareRequest) {
  const { session } = request
  try {
    const outcome = await share($, request)
    if (outcome.band) finishProgress($, outcome.band, 'done')
    else clearProgress($)
    if (outcome.notice) await $.ui.log(outcome.notice, { to: 'transcript' })
    if (outcome.url) await $.ui.log(`Delta share link: ${outcome.url}`, { to: 'debug' })
  } catch (error) {
    if (request.cancelled || requests.share !== request) return
    const text = error instanceof AccessRequiredError ? error.message
      : shareFailureText(error, recoveryCommand(stateFor(session).binding))
    setProgress($, text, 'error')
    await $.ui.log(text, { to: 'transcript' })
  } finally {
    if (requests.share === request) requests.share = undefined
  }
}

/**
 * Decide who a `/delta share` makes the session visible to: the addresses typed after the command, or
 * the person's answer to the question; `none` carries the command's answer when nothing is shared.
 */
async function chooseAudience($: Runtime, session: string, typed: string[]): Promise<AudienceAnswer> {
  if (typed.length) return { kind: 'invite', emails: typed }
  const binding = stateFor(session).binding
  await loadOrganizationDirectory($)
  const organization = (binding ? threadOrganization(binding) : undefined) ??
    await savedOrganization($, await checkoutRoot($)) ?? currentOrganizationId
  // A personal organization has nobody to share with, and a thread already shared with its organization stays shared.
  const team = isPersonalOrganizationId(organization ?? '') || binding?.visibility === 'organization' ? undefined
    : organizationName(organization) ?? 'your team'
  try {
    return await chooseShareAudience(claudeInteraction($), { team, synced: sessionSyncs(binding) })
  } catch (error) {
    if (error instanceof InteractionDismissedError) return { kind: 'none', reason: '' }
    if (error instanceof InteractionUnavailableError)
      return { kind: 'none', reason: "This Claude build cannot show /delta-share's question. Update Claude Code, or type the email addresses to invite after /delta-share." }
    throw error
  }
}

/** Begin the same publication flow `/delta share` runs, for the band's share control. */
export function beginShare($: Runtime, session: string, audience?: ShareAudience): boolean {
  if (requests.share) return false
  if (stateFor(session).currentTurnId) {
    requests.shareAfterTurn = { session, ...audience ? { audience } : {} }
    $.ui.invalidate('ui.render')
    return true
  }
  startShare($, { session, cwd: '', ...audience ? { audience } : {} })
  return true
}
