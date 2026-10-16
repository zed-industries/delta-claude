//! Locate, parse, validate, and serialize the shared project policy.
//!
//! Every harness integration reads the same `.delta/settings.json` at the Git checkout root, so a
//! repository opts its collaborators into automatic recording once. This module is pure: it never
//! touches the filesystem or Git, keeping the decisions the wizard and activation make easy to test.

/** How a checkout records Claude Code sessions. `manual` records only through `/delta share` or a join. */
export type ThreadMode = 'manual' | 'private' | 'organization'

/** A checkout's effective recording policy, after validation. */
export type ProjectPolicy = {
  mode: ThreadMode
  organization?: string
  /** Whether the file deliberately configures a policy, which suppresses the onboarding offer. */
  configured: boolean
  /** Why an existing policy could not be used, for a one-time notice. */
  problem?: string
}

/** A policy file as read from disk: the effective policy, the raw document, and whether it parsed. */
export type PolicyFile = {
  policy: ProjectPolicy
  /** The parsed document, kept whole so a rewrite preserves unknown keys. */
  document?: Record<string, unknown>
  malformed?: boolean
}

const MODES: readonly ThreadMode[] = ['manual', 'private', 'organization']

/** Where a checkout's policy lives, given the checkout root from `git rev-parse --show-toplevel`. */
export function policyPath(checkoutRoot: string): string {
  return `${checkoutRoot}/.delta/settings.json`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the effective policy from a file's text, or from `undefined` when there is none. A missing
 * file, a missing `threads` key, or a missing `mode` is unconfigured; malformed JSON or an invalid
 * mode leaves the checkout recording manually with a `problem` a person can act on.
 */
export function readProjectPolicy(text: string | undefined): PolicyFile {
  if (text === undefined) return { policy: { mode: 'manual', configured: false } }
  let document: unknown
  try { document = JSON.parse(text) }
  catch (error) { return { malformed: true, policy: { mode: 'manual', configured: false, problem: `it is not valid JSON (${String(error)})` } } }
  if (!isObject(document))
    return { malformed: true, policy: { mode: 'manual', configured: false, problem: 'it does not contain a JSON object' } }
  const threads = document.threads
  if (threads === undefined)
    return { document, policy: { mode: 'manual', configured: false } }
  if (!isObject(threads))
    return { document, policy: { mode: 'manual', configured: false, problem: 'its `threads` value is not an object' } }
  const mode = threads.mode
  if (mode === undefined)
    return { document, policy: { mode: 'manual', configured: false } }
  if (typeof mode !== 'string' || !MODES.includes(mode as ThreadMode))
    return { document, policy: { mode: 'manual', configured: false, problem: `its mode must be one of ${MODES.join(', ')}` } }
  const organization = threads.organization
  // Manual names the organization `/delta share` shares to, when setup chose one.
  if (mode === 'manual')
    return { document, policy: { mode: 'manual', configured: true, ...typeof organization === 'string' && organization.trim() ? { organization } : {} } }
  if (typeof organization !== 'string' || !organization.trim())
    return { document, policy: { mode: 'manual', configured: false, problem: `mode "${mode}" requires a non-empty organization` } }
  return { document, policy: { mode: mode as ThreadMode, organization, configured: true } }
}

/**
 * Serialize a policy, preserving every unknown top-level and nested key of the previous document.
 * Every mode keeps `organization` when given: the automatic modes sync to it, and `manual` shares to it.
 */
export function serializeProjectPolicy(
  previous: Record<string, unknown> | undefined, mode: ThreadMode, organization?: string,
): string {
  const document = isObject(previous) ? { ...previous } : {}
  const threads = isObject(document.threads) ? { ...document.threads } : {}
  threads.mode = mode
  if (organization === undefined) delete threads.organization
  else threads.organization = organization
  document.threads = threads
  return `${JSON.stringify(document, null, 2)}\n`
}

/** Whether a policy records automatically without an explicit `/delta share`. */
export function recordsAutomatically(policy: ProjectPolicy): boolean {
  return policy.mode === 'private' || policy.mode === 'organization'
}
