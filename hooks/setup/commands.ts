/**
 * The `/delta` command and its dedicated forms: parsing, the menu, and running each action.
 */
import { activate, noticeSession, refreshReminder } from './activation'
import { setProgress, showUpdateProgress } from '../band/band'
import { type CommandForm, orgCommand } from '../cli/delta-cli'
import { chooseDeltaAction, type MenuStart } from './delta-menu'
import { InstallationUpdates, type UpdateHost } from '../cli/install-update'
import { claudeInteraction, offerToStopWaiting, setupEnv } from './interaction'
import { startJoin } from '../sharing/join'
import { isOneOf } from '../core/json'
import { hasInteractiveSurface } from '../sharing/lifecycle'
import { currentOrganizationId, listOrganizations } from './organizations'
import { activation, recoveryCommand, requests, type Runtime, stateFor } from '../core/session-state'
import {
  DASHBOARD_URL, emailsIn, HEADLESS_REFUSAL, InteractionDismissedError, InteractionUnavailableError, membersUrl,
  openMembersPage, type Organization, runSetupWizard,
} from './setup'
import { shareFailureText, startShare } from '../sharing/share'
import { errorText } from '../core/text'

/** Run `/delta setup` for the active session and answer with what it did. */
async function setupCommand($: Runtime): Promise<string> {
  if (!hasInteractiveSurface(await $.session.surfaces())) return HEADLESS_REFUSAL
  const outcome = await runSetupWizard(setupEnv($), claudeInteraction($))
  if (outcome.status === 'wrote') await refreshReminder($, await $.session.id())
  return outcome.text
}

/** Every `/delta` action, for a surface that can't show the menu and for an action it doesn't know. */
export const DELTA_USAGE = 'Usage: /delta share [<email>…] | /delta join <shared-link-or-thread> | /delta setup | /delta update | /delta org list | /delta org current | /delta org switch <ID> | /delta org invite <email>… | /delta org manage'
/** `/delta-join` typed without its link. */
export const JOIN_USAGE = 'Usage: /delta-join <link>. Paste the Delta link someone shared with you, such as /delta-join https://delta.dev/join/…, or a thread ID.'
/** `/delta-org` typed without an action. */
export const ORG_USAGE = 'Usage: /delta-org list (your teams), /delta-org current (the selected one), /delta-org switch <ID>, /delta-org invite <email>… (invite people to the selected one), or /delta-org manage (open the selected one on the dashboard).'

/** Add `/delta`, and a command of its own for each of its actions, to Claude's slash-command menu. */
export async function registerCommands($: Runtime) {
  await $.command.register({ name: 'delta', description: 'Share or join a Delta session, set up syncing, choose a team, or update Delta', argumentHint: 'share [<email>…] | join <shared-link-or-thread> | setup | update | org list | org current | org switch <ID> | org manage' })
  // Plugin commands cannot declare subcommands, so each `/delta` action is also its own command and
  // appears in the slash-command menu.
  await $.command.register({ name: 'delta-share', description: 'Delta: sync this session and its code to DeltaDB, and choose who sees it', argumentHint: '[<email>…]' })
  // Claude's menu shows a command's description but not its argument hint, so the description carries the format.
  await $.command.register({ name: 'delta-join', description: 'Delta: join a shared conversation. Needs its link: /delta-join <link>', argumentHint: '<shared-link-or-thread>' })
  await $.command.register({ name: 'delta-setup', description: 'Delta: choose which sessions in this repository sync to DeltaDB' })
  await $.command.register({ name: 'delta-update', description: 'Delta: update the installed Delta app and CLI' })
  await $.command.register({ name: 'delta-org', description: 'Delta: manage your team. /delta-org list, current, switch <ID>, invite <email>, or manage', argumentHint: 'list | current | switch <ID> | invite <email>… | manage' })
}

/**
 * Answer a command typed without what it needs, such as bare `/delta`, with a menu of its actions,
 * and run the chosen one. A surface that can't ask gets `usage` instead, and choosing nothing adds
 * nothing to the transcript.
 */
export async function deltaMenu($: Runtime, start: MenuStart, usage: string, form: CommandForm): Promise<{ text?: string }> {
  if (!hasInteractiveSurface(await $.session.surfaces())) return { text: usage }
  let action: string | undefined
  try { action = await chooseDeltaAction(claudeInteraction($), start) }
  catch (error) {
    if (error instanceof InteractionDismissedError) return {}
    if (error instanceof InteractionUnavailableError) return { text: usage }
    throw error
  }
  return action ? runDeltaCommand($, action, form) : {}
}

/** Open the selected organization's members page on the dashboard; a headless session gets the link. */
async function manageOrganization($: Runtime): Promise<string> {
  let organization: Organization | undefined
  try { organization = (await listOrganizations($)).find((known) => known.current) }
  catch (error) { return `Delta couldn't read your current team (${errorText(error)}). Manage your teams here: ${DASHBOARD_URL}` }
  if (!organization) return `Delta has no team selected. Manage your teams here: ${DASHBOARD_URL}`
  const interactive = hasInteractiveSurface(await $.session.surfaces())
  return openMembersPage({ openLink: async (url) => interactive && setupEnv($).openLink(url) }, organization)
}

export function installUpdateHost($: Runtime): UpdateHost {
  return {
    run: (argv, init) => $.process.run(argv, init),
    spawn: (init) => $.process.spawn(init),
    windows: async () => await $.env.get('OS') === 'Windows_NT',
    exists: (path) => $.fs.exists(path),
    after: (milliseconds, callback) => $.clock.after(milliseconds, callback),
    log: async (text, to) => { await $.ui.log(text, { to }) },
    progress: (text) => showUpdateProgress($, text),
  }
}

/** Run one `/delta` action, such as `share` or `join <link>`, from `/delta` or its menu command. */
export async function runDeltaCommand($: Runtime, action: string, form: CommandForm): Promise<{ text?: string }> {
  await noticeSession($)
  if (action === 'update') return { text: await installationUpdates.update(installUpdateHost($), form) }
  if (action === 'org manage') return { text: await manageOrganization($) }
  // A share, join, or setup started now would sign in again beside the wait, so it asks about that instead.
  if (/^(?:setup|share|join)\b/.test(action) && await offerToStopWaiting($)) return {}
  // The setup wizard only writes the checkout's policy; it needs no session binding or activation.
  if (action === 'setup') return { text: await setupCommand($) }
  const locator = /^join\s+(\S+)$/.exec(action)?.[1]
  const organization = /^org\s+(?:(list|current)|(switch)\s+(\S+))$/.exec(action)
  const invite = /^org\s+invite\b\s*(.*)$/.exec(action)?.[1]
  // `/delta share` asks who should see the session; addresses typed after it answer that up front.
  const shareArguments = /^share(?:\s+(.*))?$/.exec(action)?.[1] ?? ''
  const shareEmails = emailsIn(shareArguments)
  const shareAction = /^share\b/.test(action) && (!shareArguments.trim() || shareEmails.length > 0)
  if (!shareAction && !locator && !organization && invite === undefined)
    return { text: DELTA_USAGE }
  if (requests.join) return { text: 'A Delta join is already in progress. Wait for its result.' }
  if (requests.share) return { text: 'A Delta share is already in progress. Wait for its result.' }
  if (organization)
    return orgCommand($, isOneOf(organization[1], ['list', 'current']) ? organization[1] : { switch: organization[3]! })
  if (invite !== undefined) {
    const emails = emailsIn(invite)
    if (!emails.length) {
      // The current organization is known once anything has listed them; otherwise link the dashboard itself.
      const members = currentOrganizationId ? membersUrl(currentOrganizationId) : DASHBOARD_URL
      return { text: `Usage: /delta-org invite <email> [<email>…]. Invites people to your current Delta team. To invite many people at once, use the dashboard: ${members}` }
    }
    return orgCommand($, { invite: emails })
  }
  const session = await $.session.id()
  try {
    if (session !== activation.session || !stateFor(session).binding) await activate($, session)
    // Sharing and joining report through the band and ask through dialogs, which only these surfaces have.
    if (!hasInteractiveSurface(await $.session.surfaces()))
      return { text: `${locator ? '/delta-join' : '/delta-share'} needs an interactive Claude Code terminal or Desktop Code tab. Print mode, SDK sessions, and cloud runners aren't supported.` }
    if (locator) {
      if (stateFor(session).currentTurnId || stateFor(session).promptEntering)
        return { text: 'Wait for the current Claude turn to finish before joining.' }
      startJoin($, { session, cwd: await $.session.cwd(), locator, form })
      // Progress belongs to the band; a command with no text adds no transcript row.
      return {}
    }
    if (stateFor(session).currentTurnId)
      return { text: 'Wait for the current Claude turn to finish before sharing.' }
    startShare($, { session, cwd: await $.session.cwd(), form, choose: { emails: shareEmails } })
    // Progress belongs to the band; a command with no text adds no transcript row.
    return {}
  }
  catch (error) {
    // Only activation can fail here; the share or join itself runs on the clock and reports there.
    const text = shareFailureText(error, locator ? `/delta-join ${locator}` : recoveryCommand(stateFor(session).binding))
    setProgress($, text, 'error')
    return { text }
  }
}

export const installationUpdates = new InstallationUpdates()
