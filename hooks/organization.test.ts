import { expect, test, tier } from 'claude-code/testing'
import { fakeThreads, sessionStart, shareCommand } from './fake-thread-commands'

tier('user')

test('organization commands return CLI output on a headless host using the selected executable', async ($, on) => {
  const fake = fakeThreads(on)
  fake.surfaces = []
  await $.session.start(sessionStart)
  for (const [args, stdout] of [
    ['org list', '* org_one\tFirst team\n  org_two\tSecond team\n'],
    ['org current', 'org_one\tFirst team\n'],
    ['org switch org_two', 'org_two\tSecond team\n'],
    ['org invite ada@example.com, bo@example.com', 'Invited ada@example.com and bo@example.com\n'],
  ] as const) {
    fake.organizationResult.stdout = stdout
    expect(await $.command.run({ ...shareCommand, args })).toEqual({
      text: stdout.trim(),
    })
  }
  expect(fake.commands).toEqual([
    ['/selected/delta', 'org', 'list'],
    ['/selected/delta', 'org', 'current'],
    ['/selected/delta', 'org', 'switch', '--', 'org_two'],
    ['/selected/delta', 'org', 'invite', '--', 'ada@example.com', 'bo@example.com'],
  ])
  expect(fake.exports).toBe(0)
  expect(fake.authCalls).toEqual([])
  fake.expectClean()
})

test('invalid organization syntax and CLI failures are returned without sharing', async ($, on) => {
  const fake = fakeThreads(on)
  await $.session.start(sessionStart)
  for (const args of ['org switch', 'org switch one two', 'org current extra', 'org create team']) {
    const result = await $.command.run({ ...shareCommand, args })
    expect(result.text).toContain('/delta org switch <ID>')
  }
  // An invite with no address runs nothing and says how to name one.
  const usage = (await $.command.run({ ...shareCommand, args: 'org invite nobody' })).text
  expect(usage).toContain('/delta-org invite <email>')
  expect(usage).toContain('https://dashboard.zed.dev')
  expect(fake.commands).toEqual([])
  fake.organizationResult.exitCode = 1
  fake.organizationResult.stderr = 'organization is not a membership'
  expect(await $.command.run({ ...shareCommand, args: 'org switch --help' })).toEqual({
    text: 'Delta team command failed: Error: organization is not a membership',
  })
  expect(fake.commands).toEqual([['/selected/delta', 'org', 'switch', '--', '--help']])
  fake.organizationResult.exitCode = 0
  fake.organizationResult.stderr = ''
  fake.organizationResult.stdout = 'org_two\tSecond team\n'
  fake.organizationResult.isStdoutTruncated = true
  expect(await $.command.run({ ...shareCommand, args: 'org current' })).toEqual({
    text: 'Delta team command failed: Error: Delta team output was truncated; check the selection with /delta-org current.',
  })
  expect(fake.exports).toBe(0)
  fake.expectClean()
})

test('bare /delta-org opens the selected team on the dashboard, and a headless session gets its link', async ($, on) => {
  const fake = fakeThreads(on)
  fake.organizations = [{ id: 'org-1', name: 'Zed', current: false }, { id: 'org-2', name: 'Acme', current: true }]
  fake.answerQuestion = (question: any) => {
    const text = question.questions[0].question
    if (text === 'What would you like to do with your team?') return { result: { answers: { [text]: 'Manage team in browser' } } }
  }
  await $.session.start(sessionStart)
  const run = (args: string) => $.command.run({ ...shareCommand, command: 'delta-org', args } as never)
  expect(await run('')).toEqual({ text: "Opened Acme's members page in your browser: https://dashboard.zed.dev/org-2/members" })
  fake.surfaces = []
  expect(await run('manage')).toEqual({ text: "Manage Acme's members here: https://dashboard.zed.dev/org-2/members" })
  expect(fake.opened).toEqual(['https://dashboard.zed.dev/org-2/members'])
  fake.expectClean()
})
