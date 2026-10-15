import { describe, expect, test } from 'claude-code/testing'
import { InteractionDismissed, InteractionUnavailable, offerOnboarding, runSetupWizard, type Interaction, type SetupEnv } from './setup'

/** An environment over an in-memory file, with the questions answered from a queue. */
function harness(options: {
  answers?: (string | undefined)[]
  file?: string
  /** Undefined defaults to `/repo`; pass `null` for a session outside a checkout. */
  root?: string | null
  commonDir?: string | undefined
  contractMax?: number
  organizations?: { id: string; name: string; current: boolean }[]
  shared?: boolean
  failWrite?: boolean
} = {}) {
  const answers = [...options.answers ?? []]
  const asks: { question: string; options: unknown }[] = []
  const logs: string[] = []
  let file = options.file
  const writes: { path: string; text: string }[] = []
  let shares = 0
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
    contract: async () => ({ operation: 'contract', min: 1, max: options.contractMax ?? 4 }),
    organizations: async () => options.organizations ?? [{ id: 'org-1', name: 'Zed', current: true }],
    readFile: async () => file,
    writeFile: async (path, text) => {
      if (options.failWrite) throw new Error('read-only checkout')
      writes.push({ path, text })
      file = text
    },
    sessionShared: async () => options.shared ?? false,
    shareSession: async () => { shares++; return true },
  }
  return { env, interaction, asks, logs, writes, current: () => file, shares: () => shares }
}

describe('setup wizard', () => {
  test('cancelling or dismissing any step leaves the file untouched', async () => {
    for (const answers of [undefined, ['Cancel'], ['Manual', 'Cancel']]) {
      const h = harness({ answers, file: undefined })
      const outcome = await runSetupWizard(h.env, h.interaction)
      expect(h.writes).toEqual([])
      expect(outcome.status === 'wrote').toBe(false)
    }
  })

  test('a malformed file is replaced only after explicit confirmation', async () => {
    const cancelled = harness({ answers: ['Cancel'], file: '{ broken' })
    expect((await runSetupWizard(cancelled.env, cancelled.interaction)).status).toBe('cancelled')
    expect(cancelled.writes).toEqual([])
    expect(cancelled.logs.join('\n')).toContain('could not read')

    const replaced = harness({ answers: ['Replace it', 'Manual', 'Save it'], file: '{ broken' })
    expect((await runSetupWizard(replaced.env, replaced.interaction)).status).toBe('wrote')
    expect(JSON.parse(replaced.current()!)).toEqual({ threads: { mode: 'manual' } })
  })

  test('after saving, only Organization sharing offers to sync this session, and only while it is unshared', async () => {
    const synced = harness({ answers: ['Organization sharing', 'Save it', 'Sync it'] })
    expect((await runSetupWizard(synced.env, synced.interaction)).status).toBe('wrote')
    expect(synced.asks.at(-1)?.question).toContain('Sync this session to Zed')
    expect(synced.shares()).toBe(1)

    const declined = harness({ answers: ['Organization sharing', 'Save it'] })
    expect((await runSetupWizard(declined.env, declined.interaction)).status).toBe('wrote')
    expect(declined.shares()).toBe(0)

    // A share would publish to the organization, which Private sync and Manual did not ask for.
    for (const answers of [['Private sync', 'Save it'], ['Manual', 'Save it']]) {
      const other = harness({ answers })
      expect((await runSetupWizard(other.env, other.interaction)).status).toBe('wrote')
      expect(other.asks.at(-1)?.question).toContain('Save this setting')
    }
    const already = harness({ answers: ['Organization sharing', 'Save it'], shared: true })
    await runSetupWizard(already.env, already.interaction)
    expect(already.asks.at(-1)?.question).toContain('Save this setting')
  })

  test('an automatic mode needs a CLI that records offline', async () => {
    const h = harness({ answers: ['Organization sharing'], contractMax: 2 })
    const outcome = await runSetupWizard(h.env, h.interaction)
    expect(outcome.status).toBe('needs-update')
    expect(h.writes).toEqual([])
  })

  test('a policy naming an organization the account is not in is called out before the first question', async () => {
    const h = harness({ file: JSON.stringify({ threads: { mode: 'organization', organization: 'org-other' } }) })
    await runSetupWizard(h.env, h.interaction)
    expect(h.logs.join('\n')).toContain("org-other, which your Delta account isn't a member of")

    const member = harness({ file: JSON.stringify({ threads: { mode: 'organization', organization: 'org-1' } }) })
    await runSetupWizard(member.env, member.interaction)
    expect(member.logs).toEqual([])
  })

  test('the organization question resolves every kind of answer to one organization', async () => {
    const six = Array.from({ length: 6 }, (_, index) => ({ id: `org-${index}`, name: `Organization ${index}`, current: index === 0 }))
    const twins = [{ id: 'org-1', name: 'Zed', current: true }, { id: 'org-2', name: 'Zed', current: false }]
    const cases: { answers: string[]; organizations?: typeof six; chosen: string; offered?: string[] }[] = [
      // One organization needs no question.
      { answers: ['Private sync', 'Save it'], chosen: 'org-1' },
      // At most four are offered; the rest are reached by typing a name or an id.
      { answers: ['Private sync', 'Organization 5', 'Save it'], organizations: six, chosen: 'org-5',
        offered: ['Organization 0', 'Organization 1', 'Organization 2', 'Organization 3'] },
      { answers: ['Private sync', 'org-3', 'Save it'], organizations: six, chosen: 'org-3' },
      // An unknown answer asks again instead of guessing.
      { answers: ['Private sync', 'nobody', 'Organization 2', 'Save it'], organizations: six, chosen: 'org-2' },
      // Organizations sharing a name are offered with their ids, so choosing one never loops.
      { answers: ['Private sync', 'Zed (org-2)', 'Save it'], organizations: twins, chosen: 'org-2',
        offered: ['Zed (org-1)', 'Zed (org-2)'] },
    ]
    for (const { answers, organizations, chosen, offered } of cases) {
      const h = harness({ answers, organizations })
      await runSetupWizard(h.env, h.interaction)
      expect(JSON.parse(h.current()!).threads).toEqual({ mode: 'private', organization: chosen })
      if (offered) {
        const question = h.asks.find((ask) => ask.question.includes('Which organization'))!
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
    const second = harness({ answers: ['Set it up', 'Manual', 'Save it'], commonDir: '/repo/.git' })
    expect(await offerOnboarding(second.env, second.interaction, backend, newSession())).toBe('skipped')
    expect(second.asks).toEqual([])
  })

  test('never offers in a configured, joined, joining, or resumed repository', async () => {
    const { backend } = memoryStore()
    for (const flags of [{ configured: true }, { newSession: false }, { joined: true }, { joining: true }]) {
      const h = harness({ answers: ['Set it up'] })
      expect(await offerOnboarding(h.env, h.interaction, backend, newSession(flags))).toBe('skipped')
      expect(h.asks).toEqual([])
    }
  })

  test('only a decision consumes the offer; a setup left unfinished is offered again from the start', async () => {
    const unfinished: (string | undefined)[][] = [
      // A typed answer, like a command entered while the dialog was open, is not a decision.
      ['__unavailable__'], [undefined], ['/delta-share'], ['Set it up', undefined],
      // A setup that fails partway: the policy write is refused.
      ['Set it up', 'Manual', 'Save it', '__write_fails__'],
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
    for (const answers of [['Not now'], ['Set it up', 'Manual', 'Save it']]) {
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
    const second = harness({ answers: ['Set it up'] })
    expect(await offerOnboarding(second.env, second.interaction, backend, newSession())).toBe('skipped')
    release()
    expect(await offering).toBe('offered')
  })

  test('a setup started from the offer reports its outcome', async () => {
    const { backend } = memoryStore()
    const h = harness({ answers: ['Set it up', 'Private sync', 'Save it'] })
    await offerOnboarding(h.env, h.interaction, backend, newSession())
    expect(h.logs.at(-1)).toContain('Saved to .delta/settings.json')
  })
})

/** Onboarding flags for a new, unconfigured session in `/repo`, with `overrides` applied. */
function newSession(overrides: Partial<Parameters<typeof offerOnboarding>[3]> = {}) {
  return { root: '/repo', configured: false, newSession: true, joined: false, joining: false, ...overrides }
}

function memoryStore() {
  const store = new Map<string, unknown>()
  const backend = { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value) } }
  return { store, backend }
}
