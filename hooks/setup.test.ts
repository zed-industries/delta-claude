import { describe, expect, test } from 'claude-code/testing'
import { AccessRequiredError } from './auth'
import { InteractionDismissed, InteractionUnavailable, inviteResultsFrom, offerOnboarding, runSetupWizard, type Interaction, type SetupEnv } from './setup'

/** An environment over an in-memory file, with the questions answered from a queue. */
function harness(options: {
  answers?: (string | undefined)[]
  file?: string
  /** Undefined defaults to `/repo`; pass `null` for a session outside a checkout. */
  root?: string | null
  commonDir?: string | undefined
  contractMax?: number
  organizations?: { id: string; name: string; current: boolean; personal?: boolean }[]
  login?: string
  shared?: boolean
  failWrite?: boolean
  failCreate?: boolean
  failInvite?: string
  /** `contract` rejects, as when installing a missing CLI fails. */
  failInstall?: boolean
  /** `signIn` rejects with this error. */
  failSignIn?: Error
  /** Whether `openLink` can open a browser; true unless set. */
  canOpen?: boolean
  /** The checkout's Git remotes; `origin` unless set. */
  remotes?: string[]
  others?: Record<string, string>
} = {}) {
  const answers = [...options.answers ?? []]
  const asks: { question: string; options: unknown }[] = []
  const logs: string[] = []
  let file = options.file
  const writes: { path: string; text: string }[] = []
  // Files other than the setting itself, such as the repository's Git exclude list, by path.
  const others = new Map<string, string>(Object.entries(options.others ?? {}))
  let shares = 0
  const creates: string[] = []
  const invites: { organization: string; emails: string[] }[] = []
  const opened: string[] = []
  let signIns = 0
  const interaction: Interaction = {
    async ask(question, askOptions) {
      // Claude's `$.ui.ask` shows plain-text options only; anything else cannot be drawn.
      const offered: unknown[] = Array.isArray(askOptions) ? askOptions : (askOptions as { options: unknown[] }).options
      if (!offered.every((option) => typeof option === 'string')) throw new Error(`non-text options: ${JSON.stringify(offered)}`)
      asks.push({ question, options: askOptions })
      const answer = answers.shift()
      if (answer === undefined) throw new InteractionDismissed('dismissed')
      if (answer === '__unavailable__') throw new InteractionUnavailable('no API')
      return answer
    },
    async log(text) { logs.push(text) },
  }
  const env: SetupEnv = {
    checkoutRoot: async () => {
      const root = options.root === undefined ? '/repo' : options.root
      if (root === null) throw new Error('not a checkout')
      return root
    },
    gitCommonDir: async () => options.commonDir,
    remotes: async () => options.remotes ?? ['origin'],
    contract: async () => {
      if (options.failInstall) throw new Error('Delta installation failed: no network')
      return { operation: 'contract', min: 1, max: options.contractMax ?? 6 }
    },
    signIn: async () => {
      signIns++
      if (options.failSignIn) throw options.failSignIn
    },
    openLink: async (url) => {
      opened.push(url)
      return options.canOpen ?? true
    },
    organizations: async () => options.organizations ?? [{ id: 'org-1', name: 'Zed', current: true }],
    login: async () => options.login,
    createOrganization: async (name) => {
      creates.push(name)
      if (options.failCreate) throw new Error('network error')
      return { id: `org-${name}`, name, current: false }
    },
    inviteMembers: async (organization, emails) => {
      invites.push({ organization, emails })
      return emails.map((email) => email === options.failInvite
        ? { email, invited: false as const, message: 'already a member' } : { email, invited: true as const })
    },
    readFile: async (path) => path.endsWith('settings.json') ? file : others.get(path),
    writeFile: async (path, text) => {
      if (!path.endsWith('settings.json')) { others.set(path, text); return }
      if (options.failWrite) throw new Error('read-only checkout')
      writes.push({ path, text })
      file = text
    },
    sessionShared: async () => options.shared ?? false,
    shareSession: async () => { shares++; return true },
  }
  return { env, interaction, asks, logs, writes, creates, invites, others, opened, current: () => file, shares: () => shares, signIns: () => signIns }
}

describe('setup wizard', () => {
  test('cancelling or dismissing any step leaves the file untouched', async () => {
    // The mode question is the last one before saving, so dismissing or cancelling it writes nothing.
    for (const answers of [undefined, ['Cancel']]) {
      const h = harness({ answers, file: undefined })
      const outcome = await runSetupWizard(h.env, h.interaction)
      expect(h.writes).toEqual([])
      expect(outcome.status === 'wrote').toBe(false)
    }
  })

  test('a saved setting is kept out of Git through the repository exclude list, once', async () => {
    const exclude = '/repo/.git/info/exclude'
    const h = harness({ answers: ['Zed', 'Manual'], commonDir: '/repo/.git', others: { [exclude]: '# local\n/.delta/worktrees/' } })
    expect((await runSetupWizard(h.env, h.interaction)).status).toBe('wrote')
    expect(h.others.get(exclude)).toBe('# local\n/.delta/worktrees/\n/.delta/settings.json\n')
    const again = harness({ answers: ['Zed', 'Manual'], commonDir: '/repo/.git', others: { [exclude]: h.others.get(exclude)! } })
    await runSetupWizard(again.env, again.interaction)
    expect(again.others.get(exclude)).toBe(h.others.get(exclude))
    expect(again.logs.some((log) => log.includes("couldn't keep"))).toBe(false)
    // Outside a Git repository it can't be excluded; the person is told how instead.
    const unknown = harness({ answers: ['Zed', 'Manual'] })
    await runSetupWizard(unknown.env, unknown.interaction)
    expect(unknown.logs.join('\n')).toContain('add it to .gitignore')
  })

  test('a malformed file is replaced only after explicit confirmation', async () => {
    const cancelled = harness({ answers: ['Cancel'], file: '{ broken' })
    expect((await runSetupWizard(cancelled.env, cancelled.interaction)).status).toBe('cancelled')
    expect(cancelled.writes).toEqual([])
    expect(cancelled.logs.join('\n')).toContain('could not read')

    const replaced = harness({ answers: ['Replace it', 'Zed', 'Manual'], file: '{ broken' })
    expect((await runSetupWizard(replaced.env, replaced.interaction)).status).toBe('wrote')
    // Manual keeps the team too, as the organization /delta-share shares to.
    expect(JSON.parse(replaced.current()!)).toEqual({ threads: { mode: 'manual', organization: 'org-1' } })
  })

  test('after saving, only Team sharing offers to sync this session, and only while it is unshared', async () => {
    const synced = harness({ answers: ['Zed', 'Team sharing', 'Sync it'] })
    expect((await runSetupWizard(synced.env, synced.interaction)).status).toBe('wrote')
    expect(synced.asks.at(-1)?.question).toContain('Sync this session to Zed')
    expect(synced.shares()).toBe(1)

    const declined = harness({ answers: ['Zed', 'Team sharing'] })
    expect((await runSetupWizard(declined.env, declined.interaction)).status).toBe('wrote')
    expect(declined.shares()).toBe(0)

    // A share would publish to the organization, which Private sync and Manual did not ask for.
    for (const answers of [['Zed', 'Private sync'], ['Zed', 'Manual']]) {
      const other = harness({ answers })
      expect((await runSetupWizard(other.env, other.interaction)).status).toBe('wrote')
      expect(other.asks.some((ask) => ask.question.includes('Sync this session'))).toBe(false)
    }
    const already = harness({ answers: ['Zed', 'Team sharing'], shared: true })
    await runSetupWizard(already.env, already.interaction)
    expect(already.asks.some((ask) => ask.question.includes('Sync this session'))).toBe(false)
  })

  test('an account with no team is asked to name one before choosing a mode', async () => {
    const cases: { answers: string[]; created: string[]; status: string; failCreate?: boolean }[] = [
      { answers: ['Acme Team', 'Invite later', 'Team sharing'], created: ['Acme Team'], status: 'wrote' },
      { answers: ['Cancel'], created: [], status: 'cancelled' },
      // A slash command typed while the dialog was open is not a name.
      { answers: ['/delta-share'], created: [], status: 'cancelled' },
      // A failed creation is reported once and never retried: the organization may exist anyway.
      { answers: ['Acme'], created: ['Acme'], status: 'failed', failCreate: true },
    ]
    for (const { answers, created, status, failCreate } of cases) {
      const h = harness({ answers, organizations: [], failCreate })
      const outcome = await runSetupWizard(h.env, h.interaction)
      expect({ status: outcome.status, created: h.creates }).toEqual({ status, created })
      if (status === 'wrote') expect(JSON.parse(h.current()!).threads.organization).toBe(`org-${created[0]}`)
    }
  })

  test('an account with only a personal organization is recommended a team, and may keep its sessions personal', async () => {
    const keep = 'Skip this step (keep sessions to myself)'
    const options = (h: ReturnType<typeof harness>, index: number) => (h.asks[index]!.options as { options: string[] }).options
    // Without the CLI's flag, the personal organization is recognised by the name Delta gives it.
    const named = harness({ answers: [keep, 'Private sync'], login: 'ada',
      organizations: [{ id: 'org-ada', name: "ada's Organization", current: true }] })
    expect((await runSetupWizard(named.env, named.interaction)).status).toBe('wrote')
    expect(options(named, 0)).toEqual(['Create a team', keep])
    expect(JSON.parse(named.current()!).threads).toEqual({ mode: 'private', organization: 'org-ada' })
    // Nobody else is in a personal organization, so it offers no Team sharing.
    expect(options(named, 1).some((label) => label.startsWith('Team sharing'))).toBe(false)
    // The flag decides whatever the name, and a created team is offered every mode.
    const flagged = harness({ answers: ['Acme', 'Invite later', 'Team sharing'],
      organizations: [{ id: 'org-p', name: 'Renamed', current: true, personal: true }] })
    expect((await runSetupWizard(flagged.env, flagged.interaction)).status).toBe('wrote')
    expect(JSON.parse(flagged.current()!).threads).toEqual({ mode: 'organization', organization: 'org-Acme' })
    expect(options(flagged, 2)).toEqual(['Private sync (every new session, only you see it until you share)',
      'Team sharing (every new session, visible to Acme)', 'Manual (only sessions you share with /delta-share)'])
  })

  test('an account with several teams can still create a new one, or go back to the list', async () => {
    const teams = [{ id: 'org-1', name: 'Zed', current: true }, { id: 'org-2', name: 'Guild', current: false }]
    const created = harness({ organizations: teams, answers: ['Create a team', 'Acme', 'Invite later', 'Team sharing', 'Not now'] })
    expect((await runSetupWizard(created.env, created.interaction)).status).toBe('wrote')
    expect(created.creates).toEqual(['Acme'])
    expect(JSON.parse(created.current()!).threads).toEqual({ mode: 'organization', organization: 'org-Acme' })
    // Going back from the name asks which team again; Cancel ends setup.
    const back = harness({ organizations: teams, answers: ['Create a team', 'Back to the list', 'Zed', 'Private sync'] })
    expect((await runSetupWizard(back.env, back.interaction)).status).toBe('wrote')
    expect(back.creates).toEqual([])
    expect(JSON.parse(back.current()!).threads.organization).toBe('org-1')
    const cancelled = harness({ organizations: teams, answers: ['Create a team', 'Cancel'] })
    expect((await runSetupWizard(cancelled.env, cancelled.interaction)).status).toBe('cancelled')
  })

  test('a newly created organization offers to invite teammates by email, and setup continues either way', async () => {
    const invited = harness({ answers: ['Acme', 'ada@example.com, bo@example.com nonsense', 'Private sync'],
      organizations: [], failInvite: 'bo@example.com' })
    expect((await runSetupWizard(invited.env, invited.interaction)).status).toBe('wrote')
    expect(invited.invites).toEqual([{ organization: 'org-Acme', emails: ['ada@example.com', 'bo@example.com'] }])
    expect(invited.logs.join('\n')).toContain("Couldn't invite bo@example.com (already a member)")
    // Bulk invitations live on the dashboard's members page, which the result links.
    expect(invited.logs.join('\n')).toContain('Manage members: https://dashboard.zed.dev/org-Acme/members')
    // Managing the team opens that page, or links it where no browser can be opened, and setup continues.
    for (const canOpen of [true, false]) {
      const managed = harness({ answers: ['Acme', 'Manage team in browser', 'Private sync'], organizations: [], canOpen })
      expect((await runSetupWizard(managed.env, managed.interaction)).status).toBe('wrote')
      expect(managed.opened).toEqual(['https://dashboard.zed.dev/org-Acme/members'])
      expect(managed.logs.join('\n')).toContain('https://dashboard.zed.dev/org-Acme/members')
      expect(managed.invites).toEqual([])
    }
    // Text with no address invites nobody and says how to invite later.
    const none = harness({ answers: ['Acme', 'later please', 'Private sync'], organizations: [] })
    expect((await runSetupWizard(none.env, none.interaction)).status).toBe('wrote')
    expect(none.invites).toEqual([])
    // An existing organization is never offered invitations.
    const existing = harness({ answers: ['Zed', 'Private sync'] })
    await runSetupWizard(existing.env, existing.interaction)
    expect(existing.asks.some((ask) => ask.question.startsWith('Who should join'))).toBe(false)
  })

  test('invitation results decode from the CLI wire format', () => {
    // `delta --json org invite` output, as `OrganizationResult::Invited` serializes it.
    expect(inviteResultsFrom({
      operation: 'invited', organization: { id: 'org-1', name: 'Acme', current: false },
      results: [{ status: 'invited', email: 'ada@example.com' },
        { status: 'failed', email: 'bo@example.com', reason: 'already_member', message: 'already a member' }],
    })).toEqual([{ email: 'ada@example.com', invited: true }, { email: 'bo@example.com', invited: false, message: 'already a member' }])
    expect(() => inviteResultsFrom({ operation: 'listed', organizations: [] })).toThrow()
  })

  test('a Delta this plugin cannot record against stops setup before any question', async () => {
    const h = harness({ answers: ['Team sharing'], contractMax: 3 })
    const outcome = await runSetupWizard(h.env, h.interaction)
    expect(outcome).toMatchObject({ status: 'failed', text: expect.stringContaining('Update Delta') })
    expect(h.asks).toEqual([])
    expect(h.writes).toEqual([])
    // A Delta too old to record against is not asked to sign in.
    expect(h.signIns()).toBe(0)
  })

  test('a repository Delta cannot identify by its remote stops setup before any question, saying why', async () => {
    const cases = [
      { remotes: [], text: 'This repository has no Git remote, and Delta needs one to sync it. Add a remote and push to it, then run /delta-setup again.' },
      { remotes: ['fork', 'upstream'], text: "Delta can't sync this repository because it has several Git remotes (fork, upstream) and none is named origin, so Delta can't tell which one is the repository. Rename the one you push to: git remote rename <name> origin. Then run /delta-setup again." },
    ]
    for (const { remotes, text } of cases) {
      const h = harness({ answers: ['Zed', 'Manual'], remotes })
      expect(await runSetupWizard(h.env, h.interaction)).toEqual({ status: 'failed', text })
      expect(h.asks).toEqual([])
      expect(h.signIns()).toBe(0)
    }
    // Several remotes are fine when one is origin, as Delta then uses it.
    const named = harness({ answers: ['Zed', 'Manual'], remotes: ['upstream', 'origin'] })
    expect((await runSetupWizard(named.env, named.interaction)).status).toBe('wrote')
  })

  test('a Delta that cannot be installed or signed in to stops setup before any question, saying why', async () => {
    const cases = [
      { failInstall: true, text: "/delta-setup couldn't start Delta: Error: Delta installation failed: no network" },
      { failSignIn: new Error('Delta sign-in expired'), text: "/delta-setup couldn't sign in to Delta: Error: Delta sign-in expired" },
      // Access Delta has not granted yet is explained as Delta words it, not as a failure.
      { failSignIn: new AccessRequiredError('Delta needs you to accept its beta terms first.'), text: 'Delta needs you to accept its beta terms first.' },
    ]
    for (const { text, ...failure } of cases) {
      const h = harness({ answers: ['Zed', 'Manual'], ...failure })
      expect(await runSetupWizard(h.env, h.interaction)).toEqual({ status: 'failed', text })
      expect(h.asks).toEqual([])
    }
  })

  test('a policy naming an organization the account is not in is called out before the first question', async () => {
    const h = harness({ file: JSON.stringify({ threads: { mode: 'organization', organization: 'org-other' } }) })
    await runSetupWizard(h.env, h.interaction)
    expect(h.logs.join('\n')).toContain("org-other, which your Delta account isn't a member of")

    const member = harness({ file: JSON.stringify({ threads: { mode: 'organization', organization: 'org-1' } }) })
    await runSetupWizard(member.env, member.interaction)
    expect(member.logs.join('\n')).not.toContain("isn't a member")
  })

  test('the organization question resolves every kind of answer to one organization', async () => {
    const six = Array.from({ length: 6 }, (_, index) => ({ id: `org-${index}`, name: `Organization ${index}`, current: index === 0 }))
    const twins = [{ id: 'org-1', name: 'Zed', current: true }, { id: 'org-2', name: 'Zed', current: false }]
    const cases: { answers: string[]; organizations?: typeof six; chosen: string; offered?: string[] }[] = [
      // Even a single team is offered beside a new one.
      { answers: ['Zed', 'Private sync'], chosen: 'org-1', offered: ['Zed', 'Create a team'] },
      // At most three are offered, then a new one; the rest are reached by typing a name or an id.
      { answers: ['Organization 5', 'Private sync'], organizations: six, chosen: 'org-5',
        offered: ['Organization 0', 'Organization 1', 'Organization 2', 'Create a team'] },
      { answers: ['org-3', 'Private sync'], organizations: six, chosen: 'org-3' },
      // An unknown answer asks again instead of guessing.
      { answers: ['nobody', 'Organization 2', 'Private sync'], organizations: six, chosen: 'org-2' },
      // Organizations sharing a name are offered with their ids, so choosing one never loops.
      { answers: ['Zed (org-2)', 'Private sync'], organizations: twins, chosen: 'org-2',
        offered: ['Zed (org-1)', 'Zed (org-2)', 'Create a team'] },
    ]
    for (const { answers, organizations, chosen, offered } of cases) {
      const h = harness({ answers, organizations })
      await runSetupWizard(h.env, h.interaction)
      expect(JSON.parse(h.current()!).threads).toEqual({ mode: 'private', organization: chosen })
      if (offered) {
        const question = h.asks.find((ask) => ask.question.includes('Which team'))!
        expect((question.options as { options: string[] }).options).toEqual(offered)
      }
    }
  })

  test('an unavailable question API reports it without writing', async () => {
    const h = harness({ answers: ['__unavailable__'] })
    const outcome = await runSetupWizard(h.env, h.interaction)
    expect(outcome.status).toBe('unavailable')
    expect(h.writes).toEqual([])
  })
})

describe('onboarding', () => {
  test('offers once per repository through the Git common directory, then never again', async () => {
    const { backend } = memoryStore()
    const first = harness({ answers: ['Not now'], commonDir: '/repo/.git' })
    expect(await offerOnboarding(first.env, first.interaction, backend, newSession())).toBe('offered')
    // A second session in a linked worktree shares the common directory and is not offered again.
    const second = harness({ answers: ['Set up now', 'Zed', 'Manual'], commonDir: '/repo/.git' })
    expect(await offerOnboarding(second.env, second.interaction, backend, newSession())).toBe('skipped')
    expect(second.asks).toEqual([])
  })

  test('never offers in a configured, joined, joining, or resumed repository', async () => {
    const { backend } = memoryStore()
    for (const flags of [{ configured: true }, { newToPlugin: false }, { joined: true }, { joining: true }]) {
      const h = harness({ answers: ['Set up now'] })
      expect(await offerOnboarding(h.env, h.interaction, backend, newSession(flags))).toBe('skipped')
      expect(h.asks).toEqual([])
    }
  })

  test('only a decision consumes the offer; a setup left unfinished is offered again from the start', async () => {
    const unfinished: (string | undefined)[][] = [
      // A typed answer, like a command entered while the dialog was open, is not a decision.
      ['__unavailable__'], [undefined], ['/delta-share'], ['Set up now', undefined],
      // A setup that fails partway: the policy write is refused.
      ['Set up now', 'Zed', 'Manual', '__write_fails__'],
    ]
    for (const answers of unfinished) {
      const { store, backend } = memoryStore()
      const h = harness({ answers: answers.filter((answer) => answer !== '__write_fails__'), failWrite: answers.includes('__write_fails__') })
      await offerOnboarding(h.env, h.interaction, backend, newSession())
      expect([...store.values()].some(Boolean)).toBe(false)
      const again = harness({ answers: ['Not now'] })
      expect(await offerOnboarding(again.env, again.interaction, backend, newSession())).toBe('offered')
      expect(again.asks).toHaveLength(1)
    }
    for (const answers of [['Not now'], ['Set up now', 'Zed', 'Manual']]) {
      const { store, backend } = memoryStore()
      const h = harness({ answers })
      await offerOnboarding(h.env, h.interaction, backend, newSession())
      expect([...store.values()]).toEqual([true])
    }
  })


  test('the offer is recorded while its dialog is open, so a session starting meanwhile skips it', async () => {
    const { backend } = memoryStore()
    let release!: () => void
    let opened!: () => void
    const dialogOpen = new Promise<void>((resolve) => { opened = resolve })
    const first = harness({ answers: ['Not now'] })
    const ask = first.interaction.ask
    first.interaction.ask = async (question, options) => {
      opened()
      await new Promise<void>((resolve) => { release = resolve })
      return ask(question, options)
    }
    const offering = offerOnboarding(first.env, first.interaction, backend, newSession())
    await dialogOpen
    const second = harness({ answers: ['Set up now'] })
    expect(await offerOnboarding(second.env, second.interaction, backend, newSession())).toBe('skipped')
    release()
    expect(await offering).toBe('offered')
  })

  test('a setup started from the offer reports its outcome', async () => {
    const { backend } = memoryStore()
    const h = harness({ answers: ['Set up now', 'Zed', 'Private sync'] })
    await offerOnboarding(h.env, h.interaction, backend, newSession())
    expect(h.logs.at(-1)).toContain('Saved Private sync with Zed to .delta/settings.json')
  })
})

/** Onboarding flags for a new, unconfigured session in `/repo`, with `overrides` applied. */
function newSession(overrides: Partial<Parameters<typeof offerOnboarding>[3]> = {}) {
  return { root: '/repo', configured: false, newToPlugin: true, joined: false, joining: false, ...overrides }
}

function memoryStore() {
  const store = new Map<string, unknown>()
  const backend = { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value) } }
  return { store, backend }
}
