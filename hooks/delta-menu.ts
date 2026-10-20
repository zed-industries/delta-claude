//! The menu bare `/delta` opens: which Delta action to run.
//!
//! Claude Code's command menu can't list a plugin command's subcommands, so `/delta` with nothing
//! after it asks instead. Each answer becomes the `/delta` action its dedicated command runs, so the
//! menu is another way in, not another flow. The questions are decided here, against an injected
//! interaction; `register.tsx` runs the chosen action.

import { TYPE_SOMETHING, emailsIn, type Interaction } from './setup'

const HEADER = 'Delta'
const SHARE = 'Share this session'
const JOIN = 'Join a shared session'
const SETUP = 'Set up this repository'
const TEAM = 'Manage your team'
const INVITE = 'Invite people'
const LIST = 'List my teams'
const MANAGE = 'Manage team in browser'
const BACK = 'Back to the menu'
const CANCEL = 'Cancel'

/** Where the menu opens: its first question, or straight at joining or the team, as bare `/delta-join` and `/delta-org` do. */
export type MenuStart = 'menu' | 'join' | 'team'

/**
 * Ask which Delta action to run and answer it as a `/delta` action, such as `share` or `join <link>`.
 * Opened at `join` or `team`, going back leads to the full menu. Undefined when the person chose
 * nothing. Rejects with the interaction's `InteractionDismissed` or `InteractionUnavailable`.
 */
export async function chooseDeltaAction(interaction: Interaction, start: MenuStart = 'menu'): Promise<string | undefined> {
  for (let step = start; ; step = 'menu') {
    if (step === 'menu') {
      const answer = await interaction.ask('What would you like to do with Delta?', {
        options: [SHARE, JOIN, SETUP, TEAM], header: HEADER,
        descriptions: { [JOIN]: 'Needs the link someone shared with you' },
      })
      if (answer === SHARE) return 'share'
      if (answer === SETUP) return 'setup'
      if (answer === JOIN) step = 'join'
      else if (answer === TEAM) step = 'team'
      // Anything typed in place of a choice decides nothing.
      else return undefined
    }
    const chosen = step === 'join' ? await chooseThread(interaction) : await chooseTeamAction(interaction)
    if (chosen !== BACK) return chosen
  }
}

/** Ask for the link of the thread to join: a `join` action, `BACK`, or undefined. */
async function chooseThread(interaction: Interaction): Promise<string | undefined> {
  const answer = await interaction.ask(`Which shared session? Select ${TYPE_SOMETHING} and paste its link.`,
    { options: [BACK, CANCEL], header: HEADER })
  if (answer === BACK) return BACK
  const link = answer.trim()
  // A typed slash command is not a link; nor is an answer with spaces in it.
  if (answer === CANCEL || !link || link.startsWith('/') || /\s/.test(link)) return undefined
  return `join ${link}`
}

/** Ask what to do with the team: an `org` action, `BACK`, or undefined. */
async function chooseTeamAction(interaction: Interaction): Promise<string | undefined> {
  const answer = await interaction.ask('What would you like to do with your team?',
    { options: [INVITE, MANAGE, LIST, BACK], header: HEADER })
  if (answer === LIST) return 'org list'
  if (answer === MANAGE) return 'org manage'
  if (answer === BACK) return BACK
  if (answer !== INVITE) return undefined
  const invited = await interaction.ask(
    `Who should join your team? Select ${TYPE_SOMETHING} and enter their email addresses, separated by commas.`,
    { options: [BACK, CANCEL], header: HEADER })
  if (invited === BACK) return BACK
  if (invited === CANCEL) return undefined
  // Text with no address still runs the invite, which explains what it needs.
  return `org invite ${emailsIn(invited).join(' ')}`.trim()
}
