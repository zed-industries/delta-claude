import { expect, test } from 'claude-code/testing'
import { chooseDeltaAction } from './delta-menu'
import { InteractionDismissed, type Interaction } from './setup'

test('each menu answer becomes the action its dedicated command runs', async () => {
  const cases: [string[], string | undefined][] = [
    [['Share this session'], 'share'],
    [['Set up this repository'], 'setup'],
    [['Join a shared session', ' https://delta.dev/join/abc '], 'join https://delta.dev/join/abc'],
    [['Manage your team', 'List my teams'], 'org list'],
    [['Manage your team', 'Show current team'], 'org current'],
    [['Manage your team', 'Invite people', 'ada@example.com, bo@example.com'], 'org invite ada@example.com bo@example.com'],
    // Text with no address still runs the invite, which says what it needs.
    [['Manage your team', 'Invite people', 'later'], 'org invite'],
    // Going back reopens the menu.
    [['Join a shared session', 'Back to the menu', 'Manage your team', 'Back to the menu', 'Share this session'], 'share'],
    // Cancelling, or typing something that isn't a choice or a link, runs nothing.
    [['Join a shared session', 'Cancel'], undefined],
    [['Join a shared session', '/delta-share'], undefined],
    [['Join a shared session', 'two words'], undefined],
    [['Manage your team', 'Invite people', 'Cancel'], undefined],
    [['something typed'], undefined],
  ]
  for (const [answers, action] of cases) expect(await chooseDeltaAction(scripted(answers))).toBe(action)
})

test('the menu offers four plain actions and dismissing it rejects', async () => {
  const asked: { question: string; options: readonly string[] }[] = []
  const interaction = scripted([], asked)
  await expect(chooseDeltaAction(interaction)).rejects.toBeInstanceOf(InteractionDismissed)
  expect(asked[0]!.options).toEqual(['Share this session', 'Join a shared session', 'Set up this repository', 'Manage your team'])
})

/** An interaction that answers each question from `answers` in order and is dismissed once they run out. */
function scripted(answers: string[], asked: { question: string; options: readonly string[] }[] = []): Interaction {
  const queue = [...answers]
  return {
    async ask(question, options) {
      asked.push({ question, options: Array.isArray(options) ? options : (options as { options: readonly string[] }).options })
      const answer = queue.shift()
      if (answer === undefined) throw new InteractionDismissed('dismissed')
      return answer
    },
    async log() {},
  }
}
