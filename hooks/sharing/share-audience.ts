/**
 * `/delta share`'s question: who should see this session.
 *
 * The question and its answers are decided here, against an injected interaction, so they are
 * exercised without a live Claude UI; `share.ts` runs the share the answer asks for.
 */

import { conversationWebLink } from '../watch/conversation'
import type { JsonObject } from '../core/json'
import { emailsIn, type Interaction, type InviteResult, inviteResultsFrom, TYPE_SOMETHING } from '../setup/setup'

/**
 * Who a share makes the session visible to: its organization, only its owner (a private upload), or
 * the owner and people invited by email. `unchanged` keeps a synced session's audience and only
 * reconnects it, which is how `/delta share` repairs a session.
 */
export type ShareAudience =
  { kind: 'organization' } | { kind: 'private' } | { kind: 'invite'; emails: string[] } | { kind: 'unchanged' }

/** The answer to who should see a session: an audience, or `none` and why nothing is shared (empty when the person chose not to). */
export type AudienceAnswer = ShareAudience | { kind: 'none'; reason: string }

/** What the question may offer. */
export type AudienceChoices = {
  /**
   * The organization's name, when the session can be shared with it. Undefined for a personal
   * organization, which has nobody to share with.
   */
  team?: string
  /**
   * The session already syncs: it is on the server or handed to Delta's background uploader. It can
   * keep its audience through `/delta share`; changing it to private uses `/delta unshare`.
   */
  synced: boolean
}

/** The tag above the question; Claude Code allows at most 12 characters. */
const HEADER = 'Delta share'
const JUST_ME = 'Just me (sync privately)'
const KEEP = 'Keep current sharing'
/** `$.ui.ask` needs two options; a question with only one answer to choose adds this one. */
const CANCEL = 'Cancel'

/**
 * Ask who should see the session. Rejects with the interaction's `InteractionDismissedError` or
 * `InteractionUnavailableError`.
 */
export async function chooseShareAudience(interaction: Interaction, choices: AudienceChoices): Promise<AudienceAnswer> {
  const team = choices.team === undefined ? undefined : `Share with ${choices.team}`
  const options = [...team ? [team] : [], choices.synced ? KEEP : JUST_ME]
  const answer = await interaction.ask(
    "Who should see this session? Delta syncs its conversation and a copy of this checkout's code, " +
    `including uncommitted changes, to DeltaDB. To invite people by email instead, select ${TYPE_SOMETHING} ` +
    'and enter their addresses, separated by commas.',
    { options: options.length < 2 ? [...options, CANCEL] : options, header: HEADER })
  if (answer === CANCEL) return { kind: 'none', reason: '' }
  if (answer === team) return { kind: 'organization' }
  if (answer === JUST_ME) return { kind: 'private' }
  if (answer === KEEP) return { kind: 'unchanged' }
  const emails = emailsIn(answer)
  if (emails.length) return { kind: 'invite', emails }
  return { kind: 'none', reason: `No email addresses found in "${answer.trim()}", so nothing was shared. Run /delta-share again to choose.` }
}

/**
 * Validate the parsed body of `delta --json thread invite`, keeping the CLI's typed error envelope:
 * each address's outcome, and the thread's link.
 */
export function threadInvitationsFrom(result: JsonObject, thread: string): { url: string; results: InviteResult[] } {
  const results = inviteResultsFrom(result)
  if (result.thread_id !== thread || typeof result.url !== 'string' || !conversationWebLink(result.url))
    throw new Error('Unexpected invitation result; use matching CLI and plugin builds')
  return { url: result.url, results }
}
