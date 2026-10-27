import { expect, test } from 'claude-code/testing'
import { projectFolder, transcriptCandidate } from './transcript'

test("a session's transcript is named for it in its working directory's folder, as Claude Code names both", () => {
  // Each character but a letter or digit becomes a dash in the folder's name.
  expect(projectFolder('/private/tmp/claude-501/-Users-x/probe_cwd')).toBe('-private-tmp-claude-501--Users-x-probe-cwd')
  expect(projectFolder('C:\\Users\\Ada\\repo.git')).toBe('C--Users-Ada-repo-git')
  expect(transcriptCandidate('/home/ada/.claude', '/repo', 'abc-123'))
    .toBe('/home/ada/.claude/projects/-repo/abc-123.jsonl')
})
