import { describe, expect, test } from 'claude-code/testing'
import { cliFixture } from './cli-fixtures'
import { chooseShareAudience, invitationSummary, threadInvitationsFrom, type AudienceChoices } from './share-audience'
import type { Interaction } from './setup'

/** Answer the share question with `answer`, recording the options it offered. */
async function ask(choices: AudienceChoices, answer?: string) {
  const offered: string[][] = []
  const interaction: Interaction = {
    async ask(_question, options) {
      offered.push([...(options as { options: string[] }).options])
      return answer ?? ''
    },
    async log() {},
  }
  return { result: await chooseShareAudience(interaction, choices), offered }
}

describe('share audience', () => {
  test('offers the team and "just me" before anything syncs, and keeping the audience after', async () => {
    expect(await ask({ team: 'Zed', synced: false, invites: true }, 'Share with Zed'))
      .toEqual({ result: { kind: 'organization' }, offered: [['Share with Zed', 'Just me (sync privately)']] })
    expect((await ask({ team: 'Zed', synced: false, invites: true }, 'Just me (sync privately)')).result).toEqual({ kind: 'private' })
    // A synced session can widen its audience or keep it, never become private again.
    expect(await ask({ team: 'Zed', synced: true, invites: true }, 'Keep current sharing'))
      .toEqual({ result: { kind: 'unchanged' }, offered: [['Share with Zed', 'Keep current sharing']] })
    // A personal organization has no team to offer, so the question pairs "just me" with Cancel.
    expect(await ask({ synced: false, invites: true }, 'Cancel')).toEqual({ result: '', offered: [['Just me (sync privately)', 'Cancel']] })
  })

  test('a typed answer invites the addresses in it, and only a CLI that can invite reads them', async () => {
    expect((await ask({ team: 'Zed', synced: false, invites: true }, 'ada@example.com, bo@example.com')).result)
      .toEqual({ kind: 'invite', emails: ['ada@example.com', 'bo@example.com'] })
    expect((await ask({ team: 'Zed', synced: false, invites: true }, 'ada')).result).toContain('No email addresses found')
    expect((await ask({ team: 'Zed', synced: false, invites: false }, 'ada@example.com')).result).toContain('Nothing was shared')
  })

  test('with one possible answer and nothing to type, nothing is asked', async () => {
    expect(await ask({ synced: false, invites: false })).toEqual({ result: { kind: 'private' }, offered: [] })
    expect(await ask({ synced: true, invites: false })).toEqual({ result: { kind: 'unchanged' }, offered: [] })
  })

  test('invitation results decode from the CLI fixture and name every address', () => {
    const invitations = threadInvitationsFrom(cliFixture('invite'), 'thread_example')
    expect(invitationSummary(invitations)).toBe(
      'Invited ada@example.com to this session: https://delta.dev/join/share_example Couldn\'t invite bo@example.com (already a member).')
    expect(() => threadInvitationsFrom(cliFixture('invite'), 'other-thread')).toThrow('matching CLI and plugin builds')
  })
})
