/**
 * What the Delta CLI prints and what it means: the JSON answers of `delta --json` commands and the
 * `thread watch` events, their parsers and validators, the errors and retry hints a failure carries,
 * and the recording contract versions this plugin speaks.
 */
import { isFiniteNumber, isJsonObject, isNonEmptyString, isOneOf, isSafeInteger, type JsonObject } from '../core/json'
import { samePath } from '../core/paths'

export type ThreadState = {
  thread_id: string
  url: string | null
  /** The thread's display name, or null when unnamed. */
  title: string | null
  access: { state: 'local_only' | 'granted'; is_owner: boolean | null }
  /** The thread's audience once a cloud record exists; null before one does. */
  visibility: 'private' | 'organization' | 'unlisted' | null
  /** Delta's background upload of this thread, or null with neither an upload intent nor a cloud record. */
  upload: ThreadUpload | null
  worktrees: {
    status: 'available'
    items: {
      reference: string
      checkouts: { directory: string; state: 'attached' | 'inactive' | 'detached' | 'missing'; active?: boolean }[]
    }[]
  } | { status: 'unavailable'; error: { code: string; reason?: string; message: string } }
  producer: {
    source: string; external_id: string; next_sequence: number; turn: ThreadTurn | null
    /** The actor this device records the producer as, which its items' `author.actor_id` names. */
    actor_id?: string | null
  } | null
}

/** Delta's background upload of a thread, as status reports it. */
export type ThreadUpload = {
  state: 'queued' | 'uploading' | 'uploaded' | 'failed'
  organization_id: string | null
  error: null | { code: string; reason?: string; message: string }
}

export type ThreadReady = Pick<ThreadState, 'thread_id' | 'producer'>
export type ThreadStatus = ThreadState & { operation: 'status' }

export type ThreadTurn = { sequence: number; status: 'running' | 'finished' | 'superseded' }
export type AppendReceipt = {
  thread_id: string; sequence: number; next_sequence: number
  duplicate: boolean; version: string
  operation: 'appended'; disposition: 'recorded' | 'fenced' | 'duplicate'
  turn_sequence: number | null
}

/** A person on a thread; `name` is null while Delta's actor-to-user lookup is pending or failed. */
export type ThreadUser = {
  user_id: string | null; name: string | null
  /** The actor an item is attributed to, the same on every device; `name` is display only. */
  actor_id?: string
}
/** Child kinds and statuses are open-ended so newer CLI values remain visible. */
export type WatchChild = {
  thread_id: string
  /** Opaque command locator. */
  reference: string
  kind: string
  name: string
  status: string
}
/** One transcript item of a watched thread; `content` depends on `kind`. */
export type WatchItem = {
  id: string
  kind: string
  after_id: string | null
  turn_id: string | null
  author: ThreadUser | null
  created_at: number | null
  open: boolean
  content: Record<string, unknown>
}

/** File lines are as they read when the comment was made. */
export type WatchCommentTarget =
  { kind: 'transcript'; item_id: string | null; quote: string } |
  {
    kind: 'file'; worktree: string | null; path: string; view: string
    regions: { first_line: number; last_line: number; status: string; text: string }[]
    selected: string | null
  }

/** A delivered comment; only a chain's first comment carries the target. */
export type WatchComment = {
  id: string
  chain: string
  after_id: string | null
  delivered_with: string
  routed_to: string | null
  author: ThreadUser
  co_authors: ThreadUser[]
  agent: boolean
  created_at: number | null
  text: string
  target: WatchCommentTarget | null
}

/** One line of `thread watch`; a terminal error envelope arrives as `error`. */
export type WatchEvent =
  ({ type: 'ready' } & ThreadReady) |
  { type: 'item'; item: WatchItem } |
  { type: 'item.append'; id: string; text: string } |
  { type: 'remove'; id: string } |
  { type: 'live' } |
  { type: 'turn'; state: 'idle' | 'running'; turn_id: string | null; user: ThreadUser | null } |
  ({ type: 'producer.turn' } & ThreadTurn) |
  { type: 'presence'; users: ThreadUser[] } |
  { type: 'children'; children: WatchChild[] } |
  { type: 'child'; child: WatchChild } |
  { type: 'child.remove'; thread_id: string } |
  { type: 'worktrees'; worktrees: { reference: string; name: string }[] } |
  { type: 'comment'; comment: WatchComment } |
  { type: 'comment.remove'; id: string } |
  { type: 'error'; error: DeltaCommandError }

/** What an error envelope says about retrying, when the CLI says anything. */
export type RetryHints = { retryable?: boolean; retryAfterMs?: number }

/**
 * A Delta CLI failure that keeps the stable code of its JSON error envelope.
 *
 * `reason` is the CLI's diagnostic for the specific cause behind that code. Recording commands are
 * free to add, rename, or move a reason under another code without a contract change, so it is for
 * logs and messages rather than behaviour: never branch on it.
 */
export class DeltaCommandError extends Error {
  constructor(readonly code: string, message: string, readonly hints: RetryHints = {}, readonly reason?: string) {
    super(message)
    this.name = 'DeltaCommandError'
  }
}

/** Decode an envelope's `error` object; `name` prefixes the message with the command it came from. */
export function commandErrorFromEnvelope(error: unknown, name?: string): DeltaCommandError | undefined {
  if (!isJsonObject(error) || typeof error.code !== 'string' || typeof error.message !== 'string') return
  const reason = isNonEmptyString(error.reason) ? error.reason : undefined
  // A reason is a diagnostic, not the code's identity: show it only when it adds something.
  const label = reason && reason !== error.code ? `${error.code} (${reason})` : error.code
  return new DeltaCommandError(error.code, `${name ? `${name}: ` : ''}${label}: ${error.message}`, {
    ...typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {},
    ...isFiniteNumber(error.retry_after_ms) && error.retry_after_ms >= 0 ? { retryAfterMs: error.retry_after_ms } : {},
  }, reason)
}

/** The typed error an envelope carries, if any: what every CLI answer is checked for first. */
function envelopeError(value: unknown): DeltaCommandError | undefined {
  return isJsonObject(value) ? commandErrorFromEnvelope(value.error) : undefined
}

/**
 * How a failure with no envelope is classified. Every recording command reports `retryable`, so
 * these are only the plugin's own local codes, constructed for a CLI that did not return one.
 */
const LOCAL_FAILURE_CLASSES: Record<string, FailureClass> = {
  process_failed: 'transient', timeout: 'transient',
  command_failed: 'permanent', invalid_acknowledgment: 'permanent',
}

/** `transient` failures are retried indefinitely; `permanent` ones need a person or a repair first. */
export type FailureClass = 'transient' | 'permanent'

/**
 * The single place that decides how a failure is retried. The envelope's own `retryable` verdict
 * always wins; the local code table is the fallback for failures that carry no envelope.
 */
export function classifyCommandFailure(error: unknown): FailureClass {
  if (!(error instanceof DeltaCommandError)) return 'permanent'
  if (error.hints.retryable !== undefined) return error.hints.retryable ? 'transient' : 'permanent'
  return LOCAL_FAILURE_CLASSES[error.code] ?? 'permanent'
}

/**
 * What is wrong with a failure that will not be retried, for a person to act on. A `reason` that
 * names a more specific cause than its published code wins.
 */
export function permanentFailureAdvice(code: string, automatic = false, reason?: string): string {
  // Delta publishes an organization mismatch as `invalid_invocation`; only the reason tells it apart.
  if (reason === 'organization_mismatch')
    return "This thread already syncs to a different Delta team, so who can see it can't change"
  if (['not_visible', 'authentication_required', 'wrong_account'].includes(code))
    return 'Check your Delta sign-in and access to this thread'
  if (code === 'organization_required')
    return 'Find your team with `/delta-org list`, then select it with `/delta-org switch <ID>`'
  if (code === 'not_shared')
    // An automatic session uploads by intent, so it recovers by retrying, not by publishing.
    return automatic ? "This repository hasn't finished setting up syncing with Delta" : 'Share the thread with /delta-share'
  if (code === 'invalid_reference')
    return 'Fix the thread, worktree, path, or producer reference'
  if (['invalid_record', 'invalid_acknowledgment'].includes(code))
    return "This Delta version can't record this message. Update Delta, or report a plugin bug"
  if (code === 'sequence_gap')
    return "Delta's record of this session is out of step with the plugin's outbox. Restore the matching Delta account store or start a new Claude session; do not reset the sequence"
  if (code === 'history_reset')
    return "Delta replaced this thread's history while this session's records were being sent"
  if (code === 'reload_required')
    // The server refused the thread's local changes; the person forks them into a kept thread or discards them.
    return 'Choose Fork & Restore or Discard for the rejected local changes, then retry'
  if (code === 'checkout_inactive')
    return 'Mount the checkout again'
  if (code === 'incompatible_app')
    return 'Update Delta, or restart it when the CLI and app builds differ'
  if (code === 'invalid_invocation')
    return "The plugin and Delta CLI versions don't match; update the plugin or Delta so they do"
  return 'Fix the cause'
}

/** Delivery to Delta failed and the records stay queued, either to be retried or until someone repairs the cause. */
export class DeltaSendError extends Error {
  constructor(readonly reason: string, readonly willRetry: boolean) {
    super(`Couldn't send message to Delta: ${reason}`)
    this.name = 'DeltaSendError'
  }
}

/** Name why an append failed, preferring the CLI's typed error envelope over stderr. */
export function appendFailure(stdout: string, stderr: string, exitCode: number | null): DeltaCommandError {
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      const failure = commandErrorFromEnvelope(JSON.parse(line)?.error)
      if (failure) return failure
    // A line that is not JSON is not an error envelope; the next one may be.
    } catch {}
  }
  return new DeltaCommandError('process_failed', stderr.trim() || `append exited ${exitCode ?? 'abnormally'}`)
}

/**
 * Decode one `thread watch` line. Unknown event types decode to undefined so a newer CLI can add
 * events; a known event with a malformed shape is an error.
 */
export function parseWatchEvent(line: string): WatchEvent | undefined {
  const event: unknown = JSON.parse(line)
  if (!isJsonObject(event)) throw new Error('Unexpected thread watch event; use matching CLI and plugin builds')
  const failure = commandErrorFromEnvelope(event.error)
  if (failure) return { type: 'error', error: failure }
  switch (event.type) {
    case 'ready':
      if (isNonEmptyString(event.thread_id) && validProducer(event.producer))
        return { type: 'ready', thread_id: event.thread_id, producer: event.producer }
      break
    case 'item':
      if (validItem(event.item)) return { type: 'item', item: event.item }
      break
    case 'item.append':
      if (isNonEmptyString(event.id) && typeof event.text === 'string') return { type: 'item.append', id: event.id, text: event.text }
      break
    case 'remove':
      if (isNonEmptyString(event.id)) return { type: 'remove', id: event.id }
      break
    case 'live':
      return { type: 'live' }
    case 'turn':
      if (isOneOf(event.state, ['idle', 'running']) && (event.turn_id === null || isNonEmptyString(event.turn_id)) &&
          (event.user === null || validUser(event.user)))
        return { type: 'turn', state: event.state, turn_id: event.turn_id, user: event.user }
      break
    case 'producer.turn':
      if (validTurn(event)) return { type: 'producer.turn', sequence: event.sequence, status: event.status }
      break
    case 'presence':
      if (Array.isArray(event.users) && event.users.every(validUser)) return { type: 'presence', users: event.users }
      break
    case 'children':
      if (Array.isArray(event.children) && event.children.every(validChild))
        return { type: 'children', children: event.children.map(watchChild) }
      break
    case 'child':
      if (validChild(event.child)) return { type: 'child', child: watchChild(event.child) }
      break
    case 'child.remove':
      if (isNonEmptyString(event.thread_id)) return { type: 'child.remove', thread_id: event.thread_id }
      break
    case 'worktrees':
      if (Array.isArray(event.worktrees) && event.worktrees.every(validWorktreeName))
        return { type: 'worktrees', worktrees: event.worktrees.map((tree) => ({ reference: tree.reference, name: tree.name })) }
      break
    case 'comment':
      if (validComment(event.comment)) return { type: 'comment', comment: event.comment }
      break
    case 'comment.remove':
      if (isNonEmptyString(event.id)) return { type: 'comment.remove', id: event.id }
      break
    default:
      if (typeof event.type === 'string') return
  }
  throw new Error('Unexpected thread watch event; use matching CLI and plugin builds')
}

function validWorktreeName(tree: unknown): tree is { reference: string; name: string } {
  return isJsonObject(tree) && isNonEmptyString(tree.reference) && typeof tree.name === 'string'
}

function validChild(child: unknown): child is WatchChild {
  return isJsonObject(child) && isNonEmptyString(child.thread_id) && isNonEmptyString(child.kind) &&
    typeof child.name === 'string' && isNonEmptyString(child.status) && isNonEmptyString(child.reference)
}

function watchChild(child: WatchChild): WatchChild {
  return { thread_id: child.thread_id, reference: child.reference, kind: child.kind, name: child.name, status: child.status }
}

function validComment(comment: unknown): comment is WatchComment {
  return isJsonObject(comment) && isNonEmptyString(comment.id) && isNonEmptyString(comment.chain) &&
    isNonEmptyString(comment.delivered_with) &&
    (comment.after_id === null || isNonEmptyString(comment.after_id)) &&
    (comment.routed_to === null || isNonEmptyString(comment.routed_to)) && validUser(comment.author) &&
    Array.isArray(comment.co_authors) && comment.co_authors.every(validUser) && typeof comment.agent === 'boolean' &&
    (comment.created_at === null || isFiniteNumber(comment.created_at)) && typeof comment.text === 'string' &&
    (comment.target === null || validCommentTarget(comment.target))
}

/** A target of a kind this plugin does not know is still a target; Delta may add kinds. */
function validCommentTarget(target: unknown): boolean {
  if (!isJsonObject(target)) return false
  if (target.kind === 'transcript')
    return (target.item_id === null || isNonEmptyString(target.item_id)) && typeof target.quote === 'string'
  if (target.kind === 'file')
    return typeof target.path === 'string' && typeof target.view === 'string' &&
      (target.worktree === null || isNonEmptyString(target.worktree)) &&
      (target.selected === null || typeof target.selected === 'string') &&
      Array.isArray(target.regions) && target.regions.every((region) =>
        isJsonObject(region) && isSafeInteger(region.first_line) && isSafeInteger(region.last_line) &&
        typeof region.status === 'string' && typeof region.text === 'string')
  return typeof target.kind === 'string'
}

function validItem(item: unknown): item is WatchItem {
  return isJsonObject(item) && isNonEmptyString(item.id) && isNonEmptyString(item.kind) &&
    (item.after_id === null || isNonEmptyString(item.after_id)) &&
    (item.turn_id === null || isNonEmptyString(item.turn_id)) && (item.author === null || validUser(item.author)) &&
    (item.created_at === null || isFiniteNumber(item.created_at)) && typeof item.open === 'boolean' &&
    isJsonObject(item.content)
}

function validUser(user: unknown): user is ThreadUser {
  return isJsonObject(user) && (user.user_id === null || isNonEmptyString(user.user_id)) &&
    (user.name === null || typeof user.name === 'string') &&
    (user.actor_id === undefined || isNonEmptyString(user.actor_id))
}

export function parseThreadStatus(line: string): ThreadStatus {
  const status: unknown = JSON.parse(line)
  const failure = envelopeError(status)
  if (failure) throw failure
  if (isJsonObject(status) && status.operation === 'status' && validBinding(status)) return status
  throw new Error('Unexpected thread status; use matching CLI and plugin builds')
}

function validBinding(frame: JsonObject): frame is ThreadStatus {
  return isNonEmptyString(frame.thread_id) && (frame.url === null || isNonEmptyString(frame.url)) &&
    (frame.title === null || typeof frame.title === 'string') &&
    isJsonObject(frame.access) && isOneOf(frame.access.state, ['local_only', 'granted']) &&
    (frame.access.is_owner === null || typeof frame.access.is_owner === 'boolean') &&
    (frame.visibility === null || isOneOf(frame.visibility, ['private', 'organization', 'unlisted'])) &&
    (frame.upload === null || validUpload(frame.upload)) &&
    validWorktrees(frame.worktrees) && validProducer(frame.producer)
}

function validUpload(value: unknown): boolean {
  return isJsonObject(value) && isOneOf(value.state, ['queued', 'uploading', 'uploaded', 'failed']) &&
    (value.organization_id === null || isNonEmptyString(value.organization_id)) &&
    (value.error === null || validErrorObject(value.error))
}

/** An error object as status reports one for an upload or an inspection. */
function validErrorObject(error: unknown): boolean {
  return isJsonObject(error) && typeof error.code === 'string' &&
    (error.reason === undefined || typeof error.reason === 'string') && typeof error.message === 'string'
}

function validProducer(value: unknown): value is ThreadState['producer'] {
  return value === null || (isJsonObject(value) && isNonEmptyString(value.source) && isNonEmptyString(value.external_id) &&
    isSafeInteger(value.next_sequence) && value.next_sequence >= 1 &&
    (value.actor_id === undefined || value.actor_id === null || isNonEmptyString(value.actor_id)) &&
    (value.turn === null || validTurn(value.turn)))
}

function validWorktrees(value: unknown): boolean {
  if (!isJsonObject(value)) return false
  if (value.status === 'unavailable') return validErrorObject(value.error)
  return value.status === 'available' && Array.isArray(value.items) && value.items.every((worktree) =>
    isJsonObject(worktree) && isNonEmptyString(worktree.reference) && Array.isArray(worktree.checkouts) &&
    worktree.checkouts.every((checkout) => isJsonObject(checkout) && isNonEmptyString(checkout.directory) &&
      isOneOf(checkout.state, ['attached', 'inactive', 'detached', 'missing']) &&
      (checkout.active === undefined || typeof checkout.active === 'boolean')))
}

/** Word a failed checkout inspection, keeping the CLI's reason when it adds to the published code. */
function inspectionUnavailableMessage(error: { code: string; reason?: string; message: string }): string {
  const label = error.reason && error.reason !== error.code ? `${error.code} (${error.reason})` : error.code
  return `Delta checkout inspection unavailable (${label}): ${error.message}. Resolve the inspection failure and retry; the existing binding and queued messages were preserved.`
}

/**
 * The oldest recording-output contract version this plugin speaks. Neither the plugin nor the CLI
 * has shipped, so nothing older is supported; raise this rather than keep a gate for an old CLI.
 */
const PLUGIN_CONTRACT_MIN = 8
/**
 * The newest recording-output contract version this plugin speaks. A capability added by a later
 * version is gated on the session's negotiated version (`contractVersion`) until `PLUGIN_CONTRACT_MIN`
 * reaches it.
 */
const PLUGIN_CONTRACT_MAX = 8
/**
 * The name Delta shows for this producer: the recording's attribution (`append --producer-name`)
 * and the harness beside a present person (`watch --participate`). Identity stays the source and
 * external id; this is only presentation.
 */
export const PRODUCER_NAME = 'Claude Code'
/**
 * The first contract that records subagents: `thread create --parent` creates a subagent's own child
 * thread, and a prompt names the conversation that sent it in `_meta.delta.sender`.
 */
export const CHILD_CONTRACT_VERSION = 7

/** The range of recording-output contract versions a CLI build speaks. */
export type ThreadContract = { operation: 'contract'; min: number; max: number }

/** Decode a `thread contract` result, or fail on a malformed one. */
export function parseThreadContract(line: string): ThreadContract {
  let result: unknown
  try { result = JSON.parse(line) } catch { throw new Error('Unexpected thread contract; use matching CLI and plugin builds') }
  const failure = envelopeError(result)
  if (failure) throw failure
  if (!isJsonObject(result) || result.operation !== 'contract' || !isSafeInteger(result.min) || !isSafeInteger(result.max) ||
      result.min < 0 || result.max < result.min)
    throw new Error('Unexpected thread contract; use matching CLI and plugin builds')
  return { operation: 'contract', min: result.min, max: result.max }
}

/** The result of `thread fork`: the new kept thread that holds the refused local changes. */
export type ForkedThread = { thread_id: string }

/**
 * Decode a `thread fork` result from its whole pretty-printed stdout, or fail on a malformed one or a
 * typed error envelope.
 */
export function parseThreadFork(stdout: string): ForkedThread {
  let result: unknown
  try { result = JSON.parse(stdout) } catch { throw new Error('Unexpected thread fork result; use matching CLI and plugin builds') }
  const failure = envelopeError(result)
  if (failure) throw failure
  if (!isJsonObject(result) || !isNonEmptyString(result.thread_id))
    throw new Error('Unexpected thread fork result; use matching CLI and plugin builds')
  return { thread_id: result.thread_id }
}

/** This plugin cannot record against the selected Delta CLI; the message says which to update. */
export class ContractRefusalError extends Error {}

/**
 * Why this plugin may not record against a CLI's contract range, or undefined when it may. An
 * `undefined` range means the CLI predates `thread contract`, so it is older than this plugin.
 */
export function contractRefusal(range: ThreadContract | undefined): string | undefined {
  if (!range || range.max < PLUGIN_CONTRACT_MIN)
    return 'This Delta is too old for this plugin. Update Delta to continue'
  if (range.min > PLUGIN_CONTRACT_MAX)
    return 'This Delta is newer than this plugin. Update the Delta plugin to continue'
}

/** The newest contract version both this plugin and a CLI it may record against speak. */
export function contractVersion(range: ThreadContract): number {
  return Math.min(range.max, PLUGIN_CONTRACT_MAX)
}

/**
 * Select this binding's checkout, never the first entry in a native inventory. A session this plugin
 * created itself may participate while its thread is still local-only: its upload intent means the
 * checkout is attached and recorded, and registering the thread with the cloud happens in the
 * background. Other bindings still require authenticated shared access.
 */
export function validateThreadCheckout(
  state: ThreadState,
  binding: { checkout?: string; checkoutReference?: string; autoUpload?: unknown },
): { directory: string; reference: string } {
  if (state.access.state !== 'granted' && !(binding.autoUpload && state.access.state === 'local_only'))
    throw new Error('The thread has no authenticated shared access; run /delta-share to explicitly publish it')
  if (state.worktrees.status === 'unavailable')
    throw new DeltaCommandError(state.worktrees.error.code, inspectionUnavailableMessage(state.worktrees.error), {}, state.worktrees.error.reason)
  const matches = state.worktrees.items.flatMap((worktree) => worktree.checkouts
    .filter((checkout) => binding.checkout !== undefined && samePath(checkout.directory, binding.checkout) &&
      worktree.reference === binding.checkoutReference &&
      ((checkout.state === 'attached' && checkout.active !== false) ||
        (checkout.state === 'detached' && checkout.active === true)))
    .map((checkout) => ({ directory: checkout.directory, reference: worktree.reference })))
  if (matches.length !== 1 && state.worktrees.items.some((worktree) => worktree.reference === binding.checkoutReference &&
    worktree.checkouts.some((checkout) => binding.checkout !== undefined && samePath(checkout.directory, binding.checkout) &&
      checkout.state === 'inactive')))
    throw new CheckoutInactiveError("The checkout's synchronization stopped")
  if (matches.length !== 1)
    throw new Error('The bound checkout is detached, inactive, missing, ambiguous, or has a different reference; the existing binding was preserved. Run /delta-share from the intended checkout.')
  return matches[0]!
}

/** A session's own checkout is still bound to its thread, but Delta no longer synchronizes it. */
export class CheckoutInactiveError extends Error {}

/** One worktree of a joined thread, as `thread mount` placed it on this machine. */
export type ThreadMount = { reference: string; name: string; directory: string; state: string }
/** The result of `thread mount`: where Claude works and every worktree's checkout. */
export type MountedThread = { thread_id: string; owner: string; directory: string; worktrees: ThreadMount[] }

/**
 * A joined session is not in a state to run a prompt: Claude is outside the session's directory, or a
 * worktree's checkout is not mounted. The message tells a person what to wait for or do.
 */
export class JoinNotReadyError extends Error {}

export function parseThreadMount(line: string, owner: string): MountedThread {
  const result: unknown = JSON.parse(line)
  const failure = envelopeError(result)
  if (failure) throw failure
  if (!isJsonObject(result) || result.operation !== 'mounted' || !isNonEmptyString(result.thread_id) || result.owner !== owner ||
      !isNonEmptyString(result.directory) || !Array.isArray(result.worktrees) || !result.worktrees.every(validMount))
    throw new Error('Unexpected thread mount result; use matching CLI and plugin builds')
  return {
    thread_id: result.thread_id, owner, directory: result.directory,
    worktrees: result.worktrees.map((tree) => ({
      reference: tree.reference, name: tree.name, directory: tree.directory, state: tree.state,
    })),
  }
}

/** Check that the thread grants access and each joined worktree's checkout is active where it was mounted. */
export function validateJoinedMounts(
  state: ThreadState, mounts: readonly { reference: string; name: string; directory: string }[],
  binding: { autoUpload?: unknown; movedFrom?: string } = {},
) {
  // An automatic session Delta moved to a checkout of its own thread may still be local-only.
  if (state.access.state !== 'granted' && !(binding.movedFrom && binding.autoUpload && state.access.state === 'local_only'))
    throw new Error('Access to the joined thread is not granted; check your Delta sign-in and thread access')
  if (state.worktrees.status === 'unavailable')
    throw new DeltaCommandError(state.worktrees.error.code, inspectionUnavailableMessage(state.worktrees.error), {}, state.worktrees.error.reason)
  const items = state.worktrees.items
  for (const mount of mounts) {
    const ready = items.some((tree) => tree.reference === mount.reference && tree.checkouts.some((checkout) =>
      samePath(checkout.directory, mount.directory) && checkout.active === true && ['attached', 'detached'].includes(checkout.state)))
    if (!ready)
      throw new JoinNotReadyError(`The worktree "${mount.name}" is not mounted at ${mount.directory} yet. Wait for Delta to finish mounting it, or run /delta-join with this thread's link to mount it again`)
  }
}

function validMount(tree: unknown): tree is ThreadMount {
  return isJsonObject(tree) && isNonEmptyString(tree.reference) && isNonEmptyString(tree.name) &&
    isNonEmptyString(tree.directory) && isNonEmptyString(tree.state)
}

export function parseAppendReceipt(line: string, thread: string, sequence: number): AppendReceipt {
  const ack: unknown = JSON.parse(line)
  if (!isJsonObject(ack) || !validReceipt(ack, thread, sequence))
    throw new Error('Invalid thread acknowledgment; no delivery assumed')
  return ack
}

function validReceipt(ack: JsonObject, thread: string, sequence: number): ack is AppendReceipt {
  return ack.thread_id === thread && ack.sequence === sequence &&
    isSafeInteger(ack.next_sequence) && ack.next_sequence > sequence &&
    typeof ack.duplicate === 'boolean' && isNonEmptyString(ack.version) &&
    ack.operation === 'appended' &&
    isOneOf(ack.disposition, ['recorded', 'fenced', 'duplicate']) &&
    (ack.turn_sequence === null || (isSafeInteger(ack.turn_sequence) && ack.turn_sequence > 0 && ack.turn_sequence <= sequence))
}

function validTurn(value: unknown): value is ThreadTurn {
  return isJsonObject(value) && isSafeInteger(value.sequence) && value.sequence > 0 &&
    isOneOf(value.status, ['running', 'finished', 'superseded'])
}

/** A reset client ledger must never cause re-import or sequence reuse. */
export function validateThreadFrontier(
  ready: Pick<ThreadState, 'thread_id' | 'producer'>,
  binding: { session: string; producer?: string; thread?: string; next: number; pending: readonly { sequence: number }[] },
): void {
  if (binding.thread && binding.thread !== ready.thread_id)
    throw new Error('Delta returned a different conversation; the existing binding was preserved')
  // A continued conversation records as the session that started it; see `Binding.producer`.
  if (!ready.producer || ready.producer.source !== 'claude-code' || ready.producer.external_id !== (binding.producer ?? binding.session))
    throw new Error('Delta returned a different or missing Claude producer; the existing binding was preserved')
  const acknowledgedThrough = binding.pending.reduce((frontier, entry) => Math.min(frontier, entry.sequence), binding.next)
  if (ready.producer.next_sequence < acknowledgedThrough)
    throw new Error('Delta has lost acknowledged client history. Restore the common account store or start a new Claude session; do not reset the sequence.')
  if (ready.producer.next_sequence > binding.next)
    throw new Error('Delta is ahead of this Claude outbox. Restore the matching producer state; do not reuse sequence numbers.')
}

