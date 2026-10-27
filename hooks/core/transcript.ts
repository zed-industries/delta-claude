/**
 * Where Claude Code keeps a session's transcript. A `classic.*` hook reports the path, but the
 * organization's built-in guard keeps every such hook from a plugin a person installs, so a session
 * that cannot be told it is also looked up here.
 */
import type { FsEntry } from 'claude-code'
import type { Runtime } from './session-state'

/** Claude Code's folder for a working directory under `projects`: each character but a letter or digit is a `-`. */
export function projectFolder(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** The transcript file Claude Code writes for a session that runs in `cwd`, in the configuration folder `config`. */
export function transcriptCandidate(config: string, cwd: string, session: string): string {
  return `${config}/projects/${projectFolder(cwd)}/${session}.jsonl`
}

/** Claude Code's configuration folder, or undefined when neither it nor a home folder is set. */
export async function claudeConfigDir($: Runtime): Promise<string | undefined> {
  const home = await $.env.get('HOME') ?? await $.env.get('USERPROFILE')
  return await $.env.get('CLAUDE_CONFIG_DIR') ?? (home ? `${home}/.claude` : undefined)
}

/**
 * Where a session's transcript will be, though Claude Code may not have written it yet: a new session's
 * file appears with its first row. Undefined when the configuration folder cannot be found.
 */
export async function expectedTranscript($: Runtime, session: string): Promise<string | undefined> {
  const config = await claudeConfigDir($)
  if (!config) return
  return transcriptCandidate(config, await $.session.cwd(), session)
}

/**
 * The transcript file a session has now. Claude Code moves it with a `/cd` and shortens the folder name
 * of a very long path, so when neither the folder for the working directory nor `current` holds it,
 * every project's folder is searched. Undefined when no folder holds it.
 */
export async function findTranscript($: Runtime, session: string, current: string | undefined): Promise<string | undefined> {
  const config = await claudeConfigDir($)
  if (!config) return
  const expected = transcriptCandidate(config, await $.session.cwd(), session)
  for (const path of current && current !== expected ? [expected, current] : [expected])
    if (await $.fs.exists(path)) return path
  let projects: FsEntry[]
  try { projects = await $.fs.list(`${config}/projects`) }
  catch { return }
  for (const project of projects) {
    if (project.kind !== 'dir') continue
    const path = `${config}/projects/${project.name}/${session}.jsonl`
    if (await $.fs.exists(path)) return path
  }
}
