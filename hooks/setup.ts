//! The `/delta setup` wizard and the once-per-repository onboarding offer.
//!
//! Both write the shared project policy and never commit it. Every question, filesystem read, and
//! write is injected, so the decisions here are exercised without a live Claude UI or Git checkout;
//! `register.tsx` supplies the real Claude Code bindings.

import { policyPath, readProjectPolicy, recordsAutomatically, serializeProjectPolicy, type PolicyFile, type ThreadMode } from './project-policy'
import { AccessRequiredError } from './auth'
import { commandErrorFromEnvelope, contractRefusal, type ThreadContract } from './thread-commands'

/** A question could not be shown: this Claude has no interactive question API. */
export class InteractionUnavailable extends Error {}
/** The person dismissed the question. */
export class InteractionDismissed extends Error {}

/** One answer a question offers: a plain-text label, which is also what the question answers. */
export type AskOption = string
/**
 * A question's answers. `descriptions` maps a label to the short hint Claude Code's dialog draws
 * beside that option; the label alone is still the answer.
 */
export type AskOptions = readonly AskOption[] | {
  options: readonly AskOption[]; header?: string; multiSelect?: boolean
  descriptions?: Readonly<Record<AskOption, string>>
}

/** The interactive surface the wizard and onboarding speak through. */
export type Interaction = {
  /** Ask one question and answer the chosen or typed label; rejects only with `InteractionDismissed` or `InteractionUnavailable`. */
  ask(question: string, options: AskOptions): Promise<string>
  log(text: string, to?: 'transcript' | 'debug'): Promise<void>
}

/**
 * One organization from `delta --json org list`. `personal` is absent from CLIs that do not report
 * it yet; see `isPersonalOrganization`.
 */
export type Organization = { id: string; name: string; current: boolean; personal?: boolean }

/**
 * Whether an organization is the account's personal one, which has no other members and cannot
 * invite any. The CLI's `personal` flag decides when present. Otherwise the name decides: Delta names
 * a personal organization `<GitHub login>'s Organization` when the account is created, and personal
 * organizations cannot be renamed. A team someone named exactly that way is the one misreading.
 */
export function isPersonalOrganization(organization: Organization, login: string | undefined): boolean {
  return organization.personal ?? (!!login && organization.name === `${login}'s Organization`)
}

/** Everything the wizard and onboarding need from the host, injected for testability. */
export type SetupEnv = {
  /** The Git checkout root, or a rejection when the session is not inside one. */
  checkoutRoot(): Promise<string>
  /** The absolute Git common directory, shared by linked worktrees. */
  gitCommonDir(): Promise<string | undefined>
  /** The checkout's Git remote names, or undefined when Git cannot list them. */
  remotes(): Promise<string[] | undefined>
  /** Find or install the CLI and read its contract; undefined when it predates `thread contract`. */
  contract(): Promise<ThreadContract | undefined>
  /** Sign in before account operations, only after the person chooses to set up syncing. */
  authenticate(notice: (text: string) => Promise<void>): Promise<void>
  /** Open a web page in the person's browser; false when this platform cannot. */
  openLink(url: string): Promise<boolean>
  /** Organizations for `thread create`, or a typed rejection when the CLI cannot list them. */
  organizations(): Promise<Organization[]>
  /** The signed-in account's GitHub login, or undefined when it cannot be read. */
  login(): Promise<string | undefined>
  /**
   * Create a team organization owned by this account, without selecting it. Never retried: after a
   * lost response the organization may exist anyway.
   */
  createOrganization(name: string): Promise<Organization>
  /** Invite people by email to an organization; answers which addresses were invited and which failed, and why. */
  inviteMembers(organization: string, emails: string[]): Promise<InviteResult[]>
  /** Read a policy file, or undefined when it does not exist. */
  readFile(path: string): Promise<string | undefined>
  /** Write a policy file; the wizard does not commit it. */
  writeFile(path: string, text: string): Promise<void>
  /**
   * Who already sees this session: nobody (`none`, it doesn't sync), only its owner (`private`), or
   * people beyond its owner (`shared`, including a joined thread).
   */
  sessionAudience(): Promise<'none' | 'private' | 'shared'>
  /**
   * Start syncing this session privately or with the organization, as `/delta share` does; false when
   * it cannot start now.
   */
  shareSession(audience: 'private' | 'organization'): Promise<boolean>
}

/** Validate the parsed body of `delta --json org list`, keeping the CLI's typed error envelope. */
export function organizationsFrom(result: any): Organization[] {
  const failure = commandErrorFromEnvelope(result?.error)
  if (failure) throw failure
  if (!Array.isArray(result?.organizations) ||
      !result.organizations.every((org: any) => typeof org?.id === 'string' && org.id &&
        typeof org.name === 'string' && typeof org.current === 'boolean'))
    throw new Error('Unexpected organization list; use matching CLI and plugin builds')
  return result.organizations.map((org: any) => ({
    id: org.id, name: org.name, current: !!org.current,
    ...typeof org.personal === 'boolean' ? { personal: org.personal } : {},
  }))
}

/** Validate the parsed body of `delta --json org create`, keeping the CLI's typed error envelope. */
export function createdOrganizationFrom(result: any): Organization {
  const failure = commandErrorFromEnvelope(result?.error)
  if (failure) throw failure
  const org = result?.organization
  if (result?.operation !== 'created' || typeof org?.id !== 'string' || !org.id || typeof org.name !== 'string')
    throw new Error('Unexpected organization creation result; use matching CLI and plugin builds')
  return { id: org.id, name: org.name, current: !!org.current }
}

/** One address from `delta --json org invite`. */
export type InviteResult = { email: string; invited: true } | { email: string; invited: false; message: string }

/** Validate the parsed body of `delta --json org invite`, keeping the CLI's typed error envelope. */
export function inviteResultsFrom(result: any): InviteResult[] {
  const failure = commandErrorFromEnvelope(result?.error)
  if (failure) throw failure
  if (result?.operation !== 'invited' || !Array.isArray(result.results) ||
      !result.results.every((entry: any) => typeof entry?.email === 'string' && ['invited', 'failed'].includes(entry.status)))
    throw new Error('Unexpected invitation result; use matching CLI and plugin builds')
  return result.results.map((entry: any): InviteResult => entry.status === 'invited'
    ? { email: entry.email, invited: true }
    : { email: entry.email, invited: false, message: String(entry.message ?? entry.reason ?? 'failed') })
}

/** Say which addresses were invited to `target` and which were not, and why. */
export function invitationSummary(results: readonly InviteResult[], target: string): string {
  const invited = results.filter((result) => result.invited).map((result) => result.email)
  const failed = results.flatMap((result) => result.invited ? [] : [`${result.email} (${result.message})`])
  return [
    invited.length ? `Invited ${invited.join(', ')} to ${target}.` : '',
    failed.length ? `Couldn't invite ${failed.join(', ')}.` : '',
  ].filter(Boolean).join(' ')
}

/**
 * Why Delta can't sync a checkout with these Git remotes, ending without a period, or undefined when
 * it can. Delta identifies a repository by its remote, so it refuses a checkout with none, or with
 * several and none named `origin`. Unknown remotes (Git couldn't list them) are left to Delta.
 */
export function remoteRefusal(remotes: readonly string[] | undefined, command: string): string | undefined {
  if (!remotes) return
  if (!remotes.length)
    return `This repository has no Git remote, and Delta needs one to sync it. Add a remote and push to it, then run ${command} again`
  if (remotes.length > 1 && !remotes.includes('origin'))
    return `Delta can't sync this repository because it has several Git remotes (${remotes.join(', ')}) and none is named origin, ` +
      `so Delta can't tell which one is the repository. Rename the one you push to: git remote rename <name> origin. Then run ${command} again`
}

/**
 * How questions name Claude Code's free-text row. The dialog always draws it last, under this label,
 * and a plugin can neither move nor rename it, so a question that expects typing points at it.
 */
export const TYPE_SOMETHING = '“Type something”'

/** Delta's web dashboard, where an organization's members are managed in bulk. */
export const DASHBOARD_URL = 'https://dashboard.zed.dev'

/** An organization's members page on the dashboard, as the Delta app links it. */
export function membersUrl(organization: string): string {
  return `${DASHBOARD_URL}/${organization}/members`
}

/** Open an organization's members page in the browser, and say so; where it can't, give the link. */
export async function openMembersPage(env: Pick<SetupEnv, 'openLink'>, organization: Organization): Promise<string> {
  const members = membersUrl(organization.id)
  return await env.openLink(members)
    ? `Opened ${organization.name}'s members page in your browser: ${members}`
    : `Manage ${organization.name}'s members here: ${members}`
}

/** The email addresses in a typed answer: words separated by commas or spaces that contain an `@`. */
export function emailsIn(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).filter((word) => /^[^@\s]+@[^@\s]+$/.test(word)))]
}

/** What the setup wizard did, for the command's answer and its tests. */
export type SetupOutcome = {
  status: 'wrote' | 'cancelled' | 'unavailable' | 'no-checkout' | 'failed'
  text: string
}

const MODE_NAMES: Record<ThreadMode, string> = { manual: 'Manual', private: 'Private sync', organization: 'Team sharing' }
/**
 * Each mode's answer in the setup question, recommended one first. `$.ui.ask` shows no per-option
 * description, so the label carries its own short explanation. A personal organization has nobody
 * to share with, so it is offered no Organization sharing.
 */
function modeLabels(organization: Organization | undefined, personal: boolean): [ThreadMode, string][] {
  return [
    ['private', 'Private sync (every new session, only you see it until you share)'],
    ...personal ? [] : [['organization', `Team sharing (every new session, visible to ${organization?.name ?? 'your team'})`] as [ThreadMode, string]],
    ['manual', 'Manual (only sessions you share with /delta-share)'],
  ]
}
/** The team question's first option for an account with no team yet. */
const CREATE_ORGANIZATION = 'Create a team'
/** The team question's last option, keeping sessions in the account's personal organization. */
const KEEP_PERSONAL = 'Skip this step (keep sessions to myself)'
/** The tag above each setup question; Claude Code allows at most 12 characters. */
const HEADER = 'Delta setup'
/** The new team's name question, which is answered in Claude Code's free-text row. */
const TEAM_NAME_QUESTION = `Create a team: select ${TYPE_SOMETHING} and enter its name.`
/** The setting's file, relative to the checkout root, as people see it named. */
const SETTINGS_FILE = '.delta/settings.json'
/** The setting's line in the repository-local `info/exclude`, anchored to the checkout root as the app's are. */
const EXCLUDE_ENTRY = '/.delta/settings.json'

/**
 * Add `entry` to the repository's `$GIT_COMMON_DIR/info/exclude`, which Git reads in every linked
 * worktree and never commits, keeping its other lines. False when it could not be written.
 */
async function excludeFromGit(env: SetupEnv, entry: string): Promise<boolean> {
  try {
    const commonDir = await env.gitCommonDir()
    if (!commonDir) return false
    const path = `${commonDir.replace(/[\\/]+$/, '')}/info/exclude`
    const contents = await env.readFile(path) ?? ''
    const lines = contents.split(/\r?\n/)
    if (lines.some((line) => line.trim() === entry)) return true
    await env.writeFile(path, `${contents}${contents && !contents.endsWith('\n') ? '\n' : ''}${entry}\n`)
    return true
  } catch { return false }
}
/**
 * `$.ui.ask` takes at most four options, and one is always "Create a new organization"; the rest of an
 * organization list is reached by typing.
 */
const MAX_ORGANIZATION_OPTIONS = 3
const CANCELLED: SetupOutcome = { status: 'cancelled', text: 'Left the existing Delta settings untouched.' }

const UNAVAILABLE_NOTICE =
  'This Claude build cannot show /delta-setup\'s questions. Update Claude Code, or edit .delta/settings.json at the checkout root by hand.'

/** What `/delta setup` answers a session with no interactive surface: it can never ask. */
export const HEADLESS_REFUSAL =
  '/delta-setup needs an interactive Claude Code terminal or Desktop Code tab. Print mode and SDK sessions cannot answer its questions. Edit .delta/settings.json at the checkout root by hand instead.'

/** An organization's option label: its name, plus its id when another organization shares the name. */
function organizationLabel(organization: Organization, organizations: readonly Organization[]): string {
  const shared = organizations.some((other) => other !== organization && other.name.toLowerCase() === organization.name.toLowerCase())
  return shared ? `${organization.name} (${organization.id})` : organization.name
}

/**
 * The organization an answer names: an exact id, an offered label, or the single organization with
 * that name (case-insensitively). An unknown or ambiguous answer matches nothing, so the wizard asks
 * again.
 */
function matchOrganization(answer: string, organizations: readonly Organization[]): Organization | undefined {
  const text = answer.trim()
  const byId = organizations.find((organization) => organization.id === text)
  if (byId) return byId
  const byLabel = organizations.find((organization) => organizationLabel(organization, organizations) === text)
  if (byLabel) return byLabel
  const matches = organizations.filter((organization) => organization.name.toLowerCase() === text.toLowerCase())
  return matches.length === 1 ? matches[0] : undefined
}

/** Describe a repository's current policy for the wizard's first question. */
function currentPolicy(policy: PolicyFile['policy'], organizations: readonly Organization[]): string {
  if (!policy.configured) return 'Delta isn\'t set up for this repository yet.'
  if (policy.mode === 'manual') return 'Currently: Manual (only sessions you share with /delta-share).'
  // A person knows an organization by its name; the id is shown only for one this account can't see.
  const where = organizations.find((org) => org.id === policy.organization)?.name ?? policy.organization
  return `Currently: ${MODE_NAMES[policy.mode]}${where ? ` with ${where}` : ''}.`
}

/**
 * Run the interactive setup wizard. Every step is a question; dismissing any of them, or writing
 * nothing before the final confirmation, leaves the policy file exactly as it was.
 */
export async function runSetupWizard(env: SetupEnv, interaction: Interaction): Promise<SetupOutcome> {
  try { return await askAndWrite(env, interaction) }
  catch (error) {
    if (error instanceof InteractionUnavailable) return { status: 'unavailable', text: UNAVAILABLE_NOTICE }
    if (error instanceof InteractionDismissed) return CANCELLED
    throw error
  }
}

async function askAndWrite(env: SetupEnv, interaction: Interaction): Promise<SetupOutcome> {
  let root: string
  try { root = await env.checkoutRoot() }
  catch (error) { return { status: 'no-checkout', text: `/delta-setup needs a Git checkout: ${String(error)}` } }
  // Nothing below can work in a repository Delta can't identify, so that is said before any question.
  const unidentified = remoteRefusal(await env.remotes(), '/delta-setup')
  if (unidentified) return { status: 'failed', text: `${unidentified}.` }
  const path = policyPath(root)
  let file: PolicyFile
  try { file = readProjectPolicy(await env.readFile(path)) }
  catch (error) { return { status: 'failed', text: `/delta-setup could not read ${path}: ${String(error)}` } }

  if (file.malformed) {
    await interaction.log(`Delta could not read ${path}: ${file.policy.problem}. Its contents were left untouched.`, 'transcript')
    if (await interaction.ask(`Replace the unreadable Delta settings at ${path}?`, { options: ['Replace it', 'Cancel'], header: HEADER }) !== 'Replace it') return CANCELLED
  }

  // A Delta this plugin cannot record against would make every choice below fail later.
  let contract: ThreadContract | undefined
  try { contract = await env.contract() }
  catch (error) { return { status: 'failed', text: `/delta-setup could not prepare Delta: ${String(error)}` } }
  const refusal = contractRefusal(contract)
  if (refusal) return { status: 'failed', text: `/delta-setup: ${refusal}, then run /delta-setup again.` }
  try { await env.authenticate((text) => interaction.log(text, 'transcript')) }
  catch (error) {
    return { status: 'failed', text: error instanceof AccessRequiredError ? error.message : `/delta-setup could not sign in to Delta: ${String(error)}` }
  }

  let organizations: Organization[]
  try { organizations = await env.organizations() }
  catch (error) { return { status: 'failed', text: `/delta-setup could not list your Delta teams: ${String(error)}` } }
  // A policy that records to an organization this account isn't in records nothing for it; say so
  // before asking, so the person can see why.
  if (recordsAutomatically(file.policy) && file.policy.organization && organizations.length &&
      !organizations.some((org) => org.id === file.policy.organization))
    await interaction.log(`This repository syncs to ${file.policy.organization}, which your Delta account isn't a member of, so its sessions don't sync for you. Choose a team you're in, or cancel to leave it unchanged.`, 'transcript')

  // The team comes first, so sessions land in an organization they can later be shared from: a
  // thread's organization never changes once it syncs, and a personal one has nobody to share with.
  const login = await env.login().catch(() => undefined)
  const teams = organizations.filter((org) => !isPersonalOrganization(org, login))
  const personalOrganization = organizations.find((org) => isPersonalOrganization(org, login))
  // An account with teams is offered the current one and up to two others; one with none is offered
  // to create one. Either may instead keep its sessions in its personal organization. A typed answer
  // names a team: an existing one by its exact name or id (an ambiguous name asks again), or else a new
  // one, created once confirmed. Going back from a new team returns here.
  const current = teams.find((org) => org.current) ?? teams[0]
  const offered = current ? [current, ...teams.filter((org) => org !== current)].slice(0, MAX_ORGANIZATION_OPTIONS) : []
  const alternative = personalOrganization ? KEEP_PERSONAL : 'Cancel'
  const question = teams.length
    ? 'Which team should sessions from this repository sync to? Only you see a session until you share it. ' +
      `To create a new team, select ${TYPE_SOMETHING} and enter its name; creating a team makes sharing easier.`
    : 'Create a team to more easily share sessions with others. Only you see a session until you share it, ' +
      'or skip this step to keep sessions to yourself.'
  const options = teams.length
    ? [...offered.map((org) => organizationLabel(org, organizations)), alternative]
    : [CREATE_ORGANIZATION, alternative]
  let chosen: Organization | SetupOutcome | 'declined' | undefined
  while (!chosen || chosen === 'declined') {
    // Only what the labels can't say gets a hint: which team Delta has selected.
    const answer = await interaction.ask(question, {
      options, header: 'Team',
      ...current?.current ? { descriptions: { [organizationLabel(current, organizations)]: 'Current team' } } : {},
    })
    if (answer === 'Cancel') return CANCELLED
    chosen = answer === KEEP_PERSONAL ? personalOrganization
      : answer === CREATE_ORGANIZATION ? await offerNewOrganization(env, interaction, TEAM_NAME_QUESTION, 'Back to the list')
      // With no team to choose, a typed answer is the new team's name.
      : !teams.length ? await createTeam(env, interaction, answer)
      : matchOrganization(answer, organizations) ?? await confirmNewTeam(env, interaction, answer, organizations)
  }
  if ('status' in chosen) return chosen
  const team = chosen

  const labels = modeLabels(team, isPersonalOrganization(team, login))
  const answer = await interaction.ask(
    `${currentPolicy(file.policy, organizations)} When Delta syncs a Claude Code session, it stores the conversation and ` +
    'a copy of this checkout\'s code, including uncommitted changes, in DeltaDB. This applies to new ' +
    'sessions, not this one. Which sessions should Delta sync?',
    { options: labels.map(([, label]) => label), header: HEADER })
  // A typed answer may name a mode by its short name instead of choosing its label.
  const mode = labels.find(([candidate, label]) =>
    answer === label || answer.trim().toLowerCase() === MODE_NAMES[candidate].toLowerCase())?.[0]
  if (!mode) return CANCELLED

  // Every mode saves the team: the automatic ones sync to it, and Manual shares to it.
  const organizationName = team.name
  const text = serializeProjectPolicy(file.document, mode, team.id)
  // Choosing a mode is the decision; saving it needs no second confirmation, and the answer says what was saved.
  try { await env.writeFile(path, text) }
  catch (error) { return { status: 'failed', text: `Delta could not save ${path}: ${String(error)}` } }
  // The setting is personal, so it stays out of commits, as the Delta app keeps its own `.delta/`
  // files out. A file that is already committed keeps being tracked; excluding it changes nothing.
  if (!await excludeFromGit(env, EXCLUDE_ENTRY))
    await interaction.log(`Delta couldn't keep ${SETTINGS_FILE} out of Git; add it to .gitignore if you don't want to commit it.`, 'transcript')
  const summary = `${MODE_NAMES[mode]} with ${organizationName}`
  const saved = `Saved ${summary} to ${SETTINGS_FILE}. New sessions follow it from now on; run /delta-setup to change it.`
  // The setting never applies to the session that saved it, so an automatic mode offers to sync this
  // one the way it chose, privately or with the team, unless it already syncs that way. Manual syncs
  // sessions by hand, so it only says how.
  const notSyncing = `${saved} This session isn't syncing; run /delta-share to sync and share it.`
  const audience = await env.sessionAudience()
  if (mode === 'manual') return { status: 'wrote', text: audience === 'none' ? notSyncing : saved }
  if (audience === 'shared' || (mode === 'private' && audience === 'private')) return { status: 'wrote', text: saved }
  let share: string | undefined
  try {
    share = await interaction.ask(mode === 'private'
      ? 'Your new setting starts with your next session. Sync this session privately too?'
      : `Your new setting starts with your next session. Sync this session to ${organizationName} too?`,
    { options: ['Sync it', 'Not now'], header: HEADER })
  }
  catch (error) { if (!(error instanceof InteractionDismissed || error instanceof InteractionUnavailable)) throw error }
  if (share !== 'Sync it') return { status: 'wrote', text: notSyncing }
  return {
    status: 'wrote',
    text: await env.shareSession(mode === 'private' ? 'private' : 'organization')
      ? `${saved} Syncing this session now.`
      : `${saved} This session couldn't start syncing now; use /delta-share once Claude is idle.`,
  }
}

/**
 * Ask for a new team's typed name, then create it and offer invitations. The question's options are
 * `decline`, answered as `declined`, and Cancel, which ends setup; anything typed that is not a name
 * is undefined, and a failed creation is the setup's outcome.
 */
async function offerNewOrganization(env: SetupEnv, interaction: Interaction, question: string, decline: string): Promise<Organization | SetupOutcome | 'declined' | undefined> {
  const answer = await interaction.ask(question, { options: [decline, 'Cancel'], header: HEADER })
  if (answer === decline) return 'declined'
  if (answer === 'Cancel') return CANCELLED
  return createTeam(env, interaction, answer)
}

/**
 * Offer to create a team under a typed name that matches no organization, so a mistyped name of an
 * existing team doesn't silently create another. Undefined for a name several organizations share,
 * or an answer that is not a name, so the team question asks again.
 */
async function confirmNewTeam(env: SetupEnv, interaction: Interaction, answer: string, organizations: readonly Organization[]): Promise<Organization | SetupOutcome | 'declined' | undefined> {
  const name = answer.trim()
  if (!name || name.startsWith('/') || organizations.some((org) => org.name.toLowerCase() === name.toLowerCase())) return undefined
  const create = 'Create it'
  if (await interaction.ask(`Create a new team called “${name}”?`, { options: [create, 'Back to the list'], header: HEADER }) !== create)
    return 'declined'
  return createTeam(env, interaction, name)
}

/**
 * Create a team under a typed name and offer invitations. Undefined for an answer that is not a name;
 * a failed creation is the setup's outcome.
 */
async function createTeam(env: SetupEnv, interaction: Interaction, answer: string): Promise<Organization | SetupOutcome | undefined> {
  const name = answer.trim()
  // A typed slash command, entered while the dialog was open, is not a name.
  if (!name || name.startsWith('/')) return undefined
  let created: Organization
  try { created = await env.createOrganization(name) }
  catch (error) { return { status: 'failed', text: `/delta-setup couldn't create the team "${name}": ${String(error)}. Check /delta-org list before trying again; it may have been created.` } }
  await interaction.log(`Created the team "${created.name}".`, 'transcript')
  await offerInvites(env, interaction, created)
  return created
}

/**
 * Offer to invite teammates to an organization setup just created. Nothing here can stop setup: the
 * organization exists either way, and a skipped or failed invitation can be sent later with
 * /delta-org invite.
 */
async function offerInvites(env: SetupEnv, interaction: Interaction, organization: Organization) {
  const later = 'Invite later'
  const manage = 'Manage team in browser'
  let answer: string
  try {
    answer = await interaction.ask(`Who should join ${organization.name}? Select ${TYPE_SOMETHING} and enter their email addresses, separated by commas.`,
      {
        options: [later, manage], header: HEADER,
        descriptions: { [later]: 'Invite anytime with /delta-org invite' },
      })
  } catch (error) {
    if (error instanceof InteractionDismissed) return
    throw error
  }
  if (answer === later) {
    await interaction.log(`Invite teammates to ${organization.name} anytime with /delta-org invite <email>.`, 'transcript')
    return
  }
  if (answer === manage) {
    await interaction.log(await openMembersPage(env, organization), 'transcript')
    return
  }
  const emails = emailsIn(answer)
  if (!emails.length) {
    await interaction.log('No email addresses found, so nobody was invited. Use /delta-org invite <email> to invite teammates later.', 'transcript')
    return
  }
  let results: InviteResult[]
  try { results = await env.inviteMembers(organization.id, emails) }
  catch (error) {
    await interaction.log(`Couldn't send the invitations: ${String(error)}. Use /delta-org invite <email> to try again.`, 'transcript')
    return
  }
  await interaction.log(`${invitationSummary(results, organization.name)} Manage members: ${membersUrl(organization.id)}`, 'transcript')
}

/** How an onboarding attempt ended, mostly for tests and the debug log. */
export type OnboardingOutcome = 'offered' | 'skipped' | 'unavailable'

/** What the startup hook already knows about the session that is starting and its checkout. */
export type OnboardingFlags = {
  root: string
  /** The checkout's policy file deliberately configures a mode, which suppresses the offer. */
  configured: boolean
  /**
   * The plugin is seeing the session's beginning: a new session (startup or `/clear`), or a running
   * one the plugin was just loaded into, as right after it is installed. Not a resume, compaction,
   * or fork.
   */
  newToPlugin: boolean
  joined: boolean
  joining: boolean
}

/** Where a repository's one-time onboarding offer is remembered. */
export type OnboardingStore = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

/**
 * Offer to set up automatic uploads once per repository, recording the offer before asking so two
 * sessions starting together cannot both show it. Linked worktrees share the marker through the
 * repository's Git common directory. Only a decision consumes the offer: "Not now", or a setup that
 * wrote the policy. Anything left unfinished (a dismissed offer, a setup cancelled or failed partway,
 * or a surface that cannot ask) clears the marker, so the next new session offers again from the
 * start. `claimed` receives the marker while the offer is open, so a host whose session ends before
 * it settles can clear it with `releaseOnboarding`. A setup started from the offer reports its
 * outcome in the transcript, as `/delta setup` answers with it.
 */
export async function offerOnboarding(
  env: SetupEnv, interaction: Interaction, store: OnboardingStore, flags: OnboardingFlags,
  claimed: (key: string) => void = () => {},
): Promise<OnboardingOutcome> {
  if (flags.configured || flags.joined || flags.joining || !flags.newToPlugin) return 'skipped'
  const key = `setup-offered:${await env.gitCommonDir() ?? flags.root}`
  if (await store.get(key)) return 'skipped'
  await store.set(key, true)
  claimed(key)
  let unfinished = true
  try {
    const outcome = await askOnboarding(env, interaction)
    unfinished = outcome !== 'settled'
    return outcome === 'unavailable' ? 'unavailable' : 'offered'
  } finally {
    if (unfinished) await releaseOnboarding(store, key)
  }
}

/** Clear an onboarding marker whose offer never reached a decision, so it is offered again. */
export async function releaseOnboarding(store: OnboardingStore, key: string): Promise<void> {
  await store.set(key, false)
}

/** The onboarding question, which also names the command that reopens setup later. */
export const ONBOARDING_QUESTION =
  'The Delta plugin is installed, but nothing in this repository syncs until you set it up. ' +
  'You\'ll configure your team and which sessions to sync. Set it up now?'
/** What declining the onboarding offer leaves in the transcript, since the offer does not return. */
export const ONBOARDING_DECLINED =
  'Delta isn\'t set up here, so nothing syncs. Run /delta-setup to set it up, or /delta-share to sync and share just this session.'
/** The onboarding offer's answer that opens setup. */
const SET_UP_NOW = 'Set up now'

/** Ask the onboarding question and run the setup it opens; `settled` when the person decided. */
async function askOnboarding(env: SetupEnv, interaction: Interaction): Promise<'settled' | 'unfinished' | 'unavailable'> {
  let answer: string | undefined
  try {
    answer = await interaction.ask(ONBOARDING_QUESTION, { options: [SET_UP_NOW, 'Not now'], header: HEADER })
  }
  catch (error) {
    return error instanceof InteractionUnavailable ? 'unavailable' : 'unfinished'
  }
  // Only "Not now" declines. Anything typed instead, such as a slash command entered while the dialog
  // was open, decides nothing, so the offer comes back.
  if (answer === 'Not now') {
    await interaction.log(ONBOARDING_DECLINED, 'transcript')
    return 'settled'
  }
  if (answer !== SET_UP_NOW) return 'unfinished'
  let text: string
  let wrote = false
  try {
    const outcome = await runSetupWizard(env, interaction)
    if (outcome.status === 'cancelled') return 'unfinished'
    wrote = outcome.status === 'wrote'
    text = outcome.text
  } catch (error) { text = `/delta-setup failed: ${String(error)}` }
  await interaction.log(text, 'transcript')
  return wrote ? 'settled' : 'unfinished'
}
