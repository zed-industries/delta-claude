import { describe, expect, test } from 'claude-code/testing'
import { cliFixture } from './cli-fixtures'
import { chooseShareAudience, threadInvitationsFrom, type AudienceChoices } from './share-audience'
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
  test('each answer the question can get decides one audience, or none', async () => {
    const team = 'Share with Zed'
    const justMe = 'Just me (sync privately)'
    const cases: { choices: AudienceChoices; answer?: string; result: unknown; offered: string[] }[] = [
      { choices: { team: 'Zed', synced: false }, answer: team, result: { kind: 'organization' }, offered: [team, justMe] },
      { choices: { team: 'Zed', synced: false }, answer: justMe, result: { kind: 'private' }, offered: [team, justMe] },
      // A synced session can widen its audience or keep it, never become private again.
      { choices: { team: 'Zed', synced: true }, answer: 'Keep current sharing', result: { kind: 'unchanged' }, offered: [team, 'Keep current sharing'] },
      // A personal organization has no team, so "just me" is paired with Cancel.
      { choices: { synced: false }, answer: 'Cancel', result: '', offered: [justMe, 'Cancel'] },
      { choices: { team: 'Zed', synced: false }, answer: 'ada@example.com, bo@example.com',
        result: { kind: 'invite', emails: ['ada@example.com', 'bo@example.com'] }, offered: [team, justMe] },
      { choices: { team: 'Zed', synced: false }, answer: 'ada', result: expect.stringContaining('No email addresses'), offered: [team, justMe] },
    ]
    for (const { choices, answer, result, offered } of cases)
      expect(await ask(choices, answer)).toEqual({ result, offered: [offered] })
    expect(() => threadInvitationsFrom(cliFixture('invite'), 'other-thread')).toThrow('matching CLI and plugin builds')
  })
})
