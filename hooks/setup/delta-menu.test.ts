import { expect, test } from 'claude-code/testing'
import { chooseDeltaAction, type MenuStart } from './delta-menu'
import { type Interaction, InteractionDismissedError } from './setup'

test('each menu answer becomes the action its dedicated command runs', async () => {
  const cases: [string[], string | undefined, MenuStart?][] = [
    [['Share this session'], 'share'],
    [['Set up this repository'], 'setup'],
    [['Join a shared session', ' https://delta.dev/join/abc '], 'join https://delta.dev/join/abc'],
    [['More actions', 'Manage your team', 'List my teams'], 'org list'],
    [['More actions', 'Manage your team', 'Manage team in browser'], 'org manage'],
    [['More actions', 'Manage your team', 'Invite people', 'ada@example.com, bo@example.com'], 'org invite ada@example.com bo@example.com'],
    [['More actions', 'Update Claude Code plugin'], 'plugin-update'],
    [['More actions', 'Update Delta app and CLI'], 'update'],
    [['More actions', 'Back to the menu', 'Share this session'], 'share'],
    // Text with no address still runs the invite, which says what it needs.
    [['More actions', 'Manage your team', 'Invite people', 'later'], 'org invite'],
    // Going back reopens the menu, including from a menu opened straight at a step.
    [['Join a shared session', 'Back to the menu', 'Share this session'], 'share'],
    [['Back to the menu', 'Share this session'], 'share', 'team'],
    [['https://delta.dev/join/abc'], 'join https://delta.dev/join/abc', 'join'],
    // Cancelling, or typing something that isn't a choice or a link, runs nothing.
    [['Join a shared session', 'Cancel'], undefined],
    [['Join a shared session', '/delta-share'], undefined],
    [['More actions', 'Manage your team', 'Invite people', 'Cancel'], undefined],
    [['something typed'], undefined],
  ]
  for (const [answers, action, start] of cases) expect(await chooseDeltaAction(scripted(answers), start)).toBe(action)
})

/** An interaction that answers each question from `answers` in order and is dismissed once they run out. */
function scripted(answers: string[]): Interaction {
  const queue = [...answers]
  return {
    async ask() {
      const answer = queue.shift()
      if (answer === undefined) throw new InteractionDismissedError('dismissed')
      return answer
    },
    async log() {},
  }
}
