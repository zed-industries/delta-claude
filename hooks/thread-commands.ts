export type ThreadState = {
  thread_id: string
  url: string | null
  access: { state: 'local_only' | 'granted'; is_owner: boolean | null }
  worktrees: {
    status: 'available'
    items: {
      reference: string
      checkouts: { directory: string; state: 'attached' | 'inactive' | 'detached' | 'missing'; active?: boolean }[]
    }[]
  } | { status: 'unavailable'; error: { code: string; reason?: string; message: string } }
  producer: {
    source: string; external_id: string; next_sequence: number; turn: ThreadTurn | null
  } | null
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
export type ThreadUser = { user_id: string | null; name: string | null }
/** Child kinds and statuses are open-ended so newer CLI values remain visible. */
export type WatchChild = {
  thread_id: string
  /** Opaque command locator; older CLI builds report only the identity. */
  reference?: string
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
export function commandErrorFromEnvelope(error: any, name?: string): DeltaCommandError | undefined {
  if (typeof error?.code !== 'string' || typeof error.message !== 'string') return
  const reason = typeof error.reason === 'string' && error.reason.length > 0 ? error.reason : undefined
  // A reason is a diagnostic, not the code's identity: show it only when it adds something.
  const label = reason && reason !== error.code ? `${error.code} (${reason})` : error.code
  return new DeltaCommandError(error.code, `${name ? `${name}: ` : ''}${label}: ${error.message}`, {
    ...typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {},
    ...Number.isFinite(error.retry_after_ms) && error.retry_after_ms >= 0 ? { retryAfterMs: error.retry_after_ms } : {},
  }, reason)
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

/** What is wrong with a failure that will not be retried, for a person to act on. */
export function permanentFailureAdvice(code: string): string {
  if (['not_visible', 'authentication_required', 'wrong_account'].includes(code))
    return 'Check your Delta sign-in and access to this thread'
  if (code === 'organization_required')
    return 'Select an organization with `delta org switch`'
  if (code === 'not_shared')
    return 'Share the thread with /delta share'
  if (code === 'invalid_reference')
    return 'Fix the thread, worktree, path, or producer reference'
  if (['invalid_record', 'invalid_acknowledgment'].includes(code))
    return "This Delta version can't record this message. Update Delta, or report a plugin bug"
  if (code === 'sequence_gap')
    return "Delta's record of this session is out of step with the plugin's outbox. Restore the matching Delta account store or start a new Claude session; do not reset the sequence"
  if (code === 'history_reset')
    return "Delta replaced this thread's history while this session's records were being sent"
  if (code === 'reload_required')
    return 'Discard the rejected local changes with `delta thread discard` so the thread reloads'
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
    } catch {}
  }
  return new DeltaCommandError('process_failed', stderr.trim() || `append exited ${exitCode ?? 'abnormally'}`)
}

/**
 * Decode one `thread watch` line. Unknown event types decode to undefined so a newer CLI can add
 * events; a known event with a malformed shape is an error.
 */
export function parseWatchEvent(line: string): WatchEvent | undefined {
  const event = JSON.parse(line)
  const failure = commandErrorFromEnvelope(event?.error)
  if (failure) return { type: 'error', error: failure }
  switch (event?.type) {
    case 'ready':
      if (nonempty(event.thread_id) && validProducer(event.producer))
        return { type: 'ready', thread_id: event.thread_id, producer: event.producer }
      break
    case 'item':
      if (validItem(event.item)) return { type: 'item', item: event.item }
      break
    case 'item.append':
      if (nonempty(event.id) && typeof event.text === 'string') return { type: 'item.append', id: event.id, text: event.text }
      break
    case 'remove':
      if (nonempty(event.id)) return { type: 'remove', id: event.id }
      break
    case 'live':
      return { type: 'live' }
    case 'turn':
      if (['idle', 'running'].includes(event.state) && (event.turn_id === null || nonempty(event.turn_id)) &&
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
      if (nonempty(event.thread_id)) return { type: 'child.remove', thread_id: event.thread_id }
      break
    case 'worktrees':
      if (Array.isArray(event.worktrees) && event.worktrees.every((tree: any) => nonempty(tree?.reference)))
        return { type: 'worktrees', worktrees: event.worktrees.map((tree: any) => ({
          reference: tree.reference, name: typeof tree.name === 'string' ? tree.name : tree.reference,
        })) }
      break
    case 'comment':
      if (validComment(event.comment)) return { type: 'comment', comment: event.comment }
      break
    case 'comment.remove':
      if (nonempty(event.id)) return { type: 'comment.remove', id: event.id }
      break
    default:
      if (typeof event?.type === 'string') return
  }
  throw new Error('Unexpected thread watch event; use matching CLI and plugin builds')
}

function validChild(child: any): child is WatchChild {
  return nonempty(child?.thread_id) && nonempty(child.kind) &&
    typeof child.name === 'string' && nonempty(child.status) &&
    (child.reference === undefined || nonempty(child.reference))
}

function watchChild(child: WatchChild): WatchChild {
  return {
    thread_id: child.thread_id, kind: child.kind, name: child.name, status: child.status,
    ...child.reference === undefined ? {} : { reference: child.reference },
  }
}

function validComment(comment: any): comment is WatchComment {
  return nonempty(comment?.id) && nonempty(comment.chain) && nonempty(comment.delivered_with) &&
    (comment.after_id === null || nonempty(comment.after_id)) &&
    (comment.routed_to === null || nonempty(comment.routed_to)) && validUser(comment.author) &&
    Array.isArray(comment.co_authors) && comment.co_authors.every(validUser) && typeof comment.agent === 'boolean' &&
    (comment.created_at === null || Number.isFinite(comment.created_at)) && typeof comment.text === 'string' &&
    (comment.target === null || validCommentTarget(comment.target))
}

/** A target of a kind this plugin does not know is still a target; Delta may add kinds. */
function validCommentTarget(target: any): boolean {
  if (target?.kind === 'transcript')
    return (target.item_id === null || nonempty(target.item_id)) && typeof target.quote === 'string'
  if (target?.kind === 'file')
    return typeof target.path === 'string' && typeof target.view === 'string' &&
      (target.worktree === null || nonempty(target.worktree)) &&
      (target.selected === null || typeof target.selected === 'string') &&
      Array.isArray(target.regions) && target.regions.every((region: any) =>
        Number.isSafeInteger(region?.first_line) && Number.isSafeInteger(region.last_line) &&
        typeof region.status === 'string' && typeof region.text === 'string')
  return typeof target?.kind === 'string'
}

function validItem(item: any): item is WatchItem {
  return nonempty(item?.id) && nonempty(item.kind) && (item.after_id === null || nonempty(item.after_id)) &&
    (item.turn_id === null || nonempty(item.turn_id)) && (item.author === null || validUser(item.author)) &&
    (item.created_at === null || Number.isFinite(item.created_at)) && typeof item.open === 'boolean' &&
    item.content !== null && typeof item.content === 'object' && !Array.isArray(item.content)
}

function validUser(user: any): user is ThreadUser {
  return (user?.user_id === null || nonempty(user?.user_id)) && (user.name === null || typeof user.name === 'string')
}

export function parseThreadStatus(line: string): ThreadStatus {
  const status = JSON.parse(line)
  const failure = commandErrorFromEnvelope(status?.error)
  if (failure) throw failure
  if (status?.operation === 'status' && validBinding(status)) return status
  throw new Error('Unexpected thread status; use matching CLI and plugin builds')
}

function validBinding(frame: any): boolean {
  return nonempty(frame.thread_id) && (frame.url === null || nonempty(frame.url)) &&
    ['local_only', 'granted'].includes(frame.access?.state) &&
    (frame.access.is_owner === null || typeof frame.access.is_owner === 'boolean') &&
    validWorktrees(frame.worktrees) && validProducer(frame.producer)
}

function validProducer(value: any): boolean {
  return value === null || (nonempty(value?.source) && nonempty(value.external_id) &&
    Number.isSafeInteger(value.next_sequence) && value.next_sequence >= 1 &&
    (value.turn === null || validTurn(value.turn)))
}

function validWorktrees(value: any): boolean {
  if (value?.status === 'unavailable')
    return typeof value.error?.code === 'string' && typeof value.error.message === 'string' &&
      (value.error.reason === undefined || typeof value.error.reason === 'string')
  return value?.status === 'available' && Array.isArray(value.items) && value.items.every((worktree: any) =>
    nonempty(worktree?.reference) && Array.isArray(worktree.checkouts) &&
    worktree.checkouts.every((checkout: any) => nonempty(checkout?.directory) &&
      ['attached', 'inactive', 'detached', 'missing'].includes(checkout.state) &&
      (checkout.active === undefined || typeof checkout.active === 'boolean')))
}

/** Word a failed checkout inspection, keeping the CLI's reason when it adds to the published code. */
function inspectionUnavailableMessage(error: { code: string; reason?: string; message: string }): string {
  const label = error.reason && error.reason !== error.code ? `${error.code} (${error.reason})` : error.code
  return `Delta checkout inspection unavailable (${label}): ${error.message}. Resolve the inspection failure and retry; the existing binding and queued messages were preserved.`
}

/** The oldest recording-output contract version this plugin speaks. */
export const PLUGIN_CONTRACT_VERSION = 1
/** The newest recording-output contract version this plugin speaks. */
export const PLUGIN_CONTRACT_MAX = 3
/** The first contract version whose `append` accepts `session_info_update`, which carries a title. */
export const TITLE_CONTRACT_VERSION = 2
/** The first contract whose mount command accepts an explicit join-intent flag. */
export const JOIN_INTENT_CONTRACT_VERSION = 3

/** The range of recording-output contract versions a CLI build speaks. */
export type ThreadContract = { operation: 'contract'; min: number; max: number }

/** Decode a `thread contract` result, or fail on a malformed one. */
export function parseThreadContract(line: string): ThreadContract {
  let result: any
  try { result = JSON.parse(line) } catch { throw new Error('Unexpected thread contract; use matching CLI and plugin builds') }
  const failure = commandErrorFromEnvelope(result?.error)
  if (failure) throw failure
  if (result?.operation !== 'contract' || !Number.isSafeInteger(result.min) || !Number.isSafeInteger(result.max) ||
      result.min < 0 || result.max < result.min)
    throw new Error('Unexpected thread contract; use matching CLI and plugin builds')
  return { operation: 'contract', min: result.min, max: result.max }
}

/**
 * Why this plugin may not record against a CLI's contract range, or undefined when it may. An
 * `undefined` range means the CLI predates `thread contract`, so it is older than this plugin.
 */
export function contractRefusal(range: ThreadContract | undefined): string | undefined {
  if (!range)
    return 'This Delta CLI does not recognize `thread contract`, so it is too old for this plugin. Update Delta to continue'
  const ours = `${PLUGIN_CONTRACT_VERSION}..${PLUGIN_CONTRACT_MAX}`
  if (PLUGIN_CONTRACT_VERSION > range.max)
    return `Delta speaks recording contract ${range.min}..${range.max}, older than this plugin's ${ours}. Update Delta to continue`
  if (PLUGIN_CONTRACT_MAX < range.min)
    return `Delta speaks recording contract ${range.min}..${range.max}, newer than this plugin's ${ours}. Update the Delta plugin to continue`
}

/** The newest contract version both this plugin and a CLI it may record against speak. */
export function contractVersion(range: ThreadContract): number {
  return Math.min(range.max, PLUGIN_CONTRACT_MAX)
}

/** Select this binding's checkout, never the first entry in a native inventory. */
export function validateThreadCheckout(
  state: ThreadState,
  binding: { checkout?: string; checkoutReference?: string },
): { directory: string; reference: string } {
  if (state.access.state !== 'granted')
    throw new Error('The thread has no authenticated shared access; run /delta share to explicitly publish it')
  if (state.worktrees.status === 'unavailable')
    throw new DeltaCommandError(state.worktrees.error.code, inspectionUnavailableMessage(state.worktrees.error), {}, state.worktrees.error.reason)
  const matches = state.worktrees.items.flatMap((worktree) => worktree.checkouts
    .filter((checkout) => checkout.directory === binding.checkout &&
      (binding.checkoutReference === undefined || worktree.reference === binding.checkoutReference) &&
      checkout.state === 'attached' && checkout.active !== false)
    .map((checkout) => ({ directory: checkout.directory, reference: worktree.reference })))
  if (matches.length !== 1)
    throw new Error('The bound checkout is detached, inactive, missing, ambiguous, or has a different reference; the existing binding was preserved. Run /delta share from the intended checkout.')
  return matches[0]!
}

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
  const result = JSON.parse(line)
  const failure = commandErrorFromEnvelope(result?.error)
  if (failure) throw failure
  if (result?.operation !== 'mounted' || !nonempty(result.thread_id) || result.owner !== owner ||
      !nonempty(result.directory) || !Array.isArray(result.worktrees) ||
      !result.worktrees.every((tree: any) => nonempty(tree?.reference) && nonempty(tree.directory) && nonempty(tree.state)))
    throw new Error('Unexpected thread mount result; use matching CLI and plugin builds')
  return {
    thread_id: result.thread_id, owner, directory: result.directory,
    worktrees: result.worktrees.map((tree: any) => ({
      reference: tree.reference, directory: tree.directory, state: tree.state,
      name: nonempty(tree.name) ? tree.name : tree.directory.split('/').filter(Boolean).pop() ?? tree.reference,
    })),
  }
}

/** Check that the thread grants access and each joined worktree's checkout is active where it was mounted. */
export function validateJoinedMounts(state: ThreadState, mounts: readonly { reference: string; name: string; directory: string }[]) {
  if (state.access.state !== 'granted')
    throw new Error('Access to the joined thread is not granted; check your Delta sign-in and thread access')
  if (state.worktrees.status === 'unavailable')
    throw new DeltaCommandError(state.worktrees.error.code, inspectionUnavailableMessage(state.worktrees.error), {}, state.worktrees.error.reason)
  const items = state.worktrees.items
  for (const mount of mounts) {
    const ready = items.some((tree) => tree.reference === mount.reference && tree.checkouts.some((checkout) =>
      checkout.directory === mount.directory && checkout.active === true && ['attached', 'detached'].includes(checkout.state)))
    if (!ready)
      throw new JoinNotReadyError(`The worktree "${mount.name}" is not mounted at ${mount.directory} yet. Wait for Delta to finish mounting it, or run /delta join with this thread's link to mount it again`)
  }
}

export function parseAppendReceipt(line: string, thread: string, sequence: number): AppendReceipt {
  const ack = JSON.parse(line)
  if (ack?.thread_id !== thread || ack.sequence !== sequence ||
      !Number.isSafeInteger(ack.next_sequence) || ack.next_sequence <= sequence ||
      typeof ack.duplicate !== 'boolean' || !nonempty(ack.version) ||
      ack.operation !== 'appended' ||
      !['recorded', 'fenced', 'duplicate'].includes(ack.disposition) ||
      !(ack.turn_sequence === null || (Number.isSafeInteger(ack.turn_sequence) && ack.turn_sequence > 0 && ack.turn_sequence <= sequence)))
    throw new Error('Invalid thread acknowledgment; no delivery assumed')
  return ack
}

function validTurn(value: any): value is ThreadTurn {
  return value && Number.isSafeInteger(value.sequence) && value.sequence > 0 &&
    ['running', 'finished', 'superseded'].includes(value.status)
}

/** A reset client ledger must never cause re-import or sequence reuse. */
export function validateThreadFrontier(
  ready: Pick<ThreadState, 'thread_id' | 'producer'>,
  binding: { session: string; thread?: string; next: number; pending: readonly { sequence: number }[] },
): void {
  if (binding.thread && binding.thread !== ready.thread_id)
    throw new Error('Delta returned a different conversation; the existing binding was preserved')
  if (!ready.producer || ready.producer.source !== 'claude-code' || ready.producer.external_id !== binding.session)
    throw new Error('Delta returned a different or missing Claude producer; the existing binding was preserved')
  const acknowledgedThrough = binding.pending.reduce((frontier, entry) => Math.min(frontier, entry.sequence), binding.next)
  if (ready.producer.next_sequence < acknowledgedThrough)
    throw new Error('Delta has lost acknowledged client history. Restore the common account store or start a new Claude session; do not reset the sequence.')
  if (ready.producer.next_sequence > binding.next)
    throw new Error('Delta is ahead of this Claude outbox. Restore the matching producer state; do not reuse sequence numbers.')
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
