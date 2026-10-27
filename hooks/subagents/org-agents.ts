/**
 * Which agent types the organization provides. The organization's built-in guard keeps the plugins a
 * person installs out of such agents, so this plugin leaves their worktrees as Claude made them rather
 * than moving them into a fork. An organization provides agents in two places only: the plugins its
 * managed settings seat, whose agents are `<plugin>:<agent>`, and the managed settings directory's
 * `.claude/agents/`, whose agents can take any name.
 */
import type { FsEntry } from 'claude-code'
import { isJsonObject } from '../core/json'
import type { Runtime } from '../core/session-state'

/** Where each platform keeps managed settings; WSL can also read the Windows one through `/mnt/c`. */
const MANAGED_DIRECTORIES = [
  '/Library/Application Support/ClaudeCode',
  '/etc/claude-code',
  'C:\\Program Files\\ClaudeCode',
  '/mnt/c/Program Files/ClaudeCode',
]
/** How deep managed agent folders are searched, and how many definitions are read at most. */
const MAX_AGENT_DEPTH = 4
const MAX_AGENT_FILES = 200

/**
 * The plugins managed settings name, lower-cased: those seated ahead of or after the plugins a person
 * installs, and those managed settings enable, any of which may be the organization's own.
 */
export function organizationPluginNames(policy: unknown): Set<string> {
  const names = new Set<string>()
  if (!isJsonObject(policy)) return names
  const add = (id: unknown) => {
    if (typeof id !== 'string' || !id) return
    // A plugin id is its name, `@`, and its marketplace; the name is everything before the last `@`.
    const at = id.lastIndexOf('@')
    names.add((at > 0 ? id.slice(0, at) : id).toLowerCase())
  }
  for (const key of ['prependPlugins', 'appendPlugins']) {
    const ids = policy[key]
    if (Array.isArray(ids)) ids.forEach(add)
  }
  const enabled = policy.enabledPlugins
  if (isJsonObject(enabled)) for (const [id, value] of Object.entries(enabled)) if (value) add(id)
  return names
}

/** An agent definition's name: its frontmatter `name`, or its file's name without `.md`. */
export function agentDefinitionName(fileName: string, text: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]
  const named = frontmatter && /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(frontmatter)?.[1]
  return named || fileName.replace(/\.md$/i, '')
}

/**
 * Whether the organization may provide the agent type `type`. Anything that cannot be read counts as
 * the organization's, so a call this plugin cannot follow is left as Claude made it.
 */
export async function providedByOrganization($: Runtime, type: string): Promise<boolean> {
  try {
    const colon = type.indexOf(':')
    if (colon >= 0)
      return organizationPluginNames(await $.settings.read({ source: 'policy' })).has(type.slice(0, colon).toLowerCase())
    return (await managedAgentNames($)).has(type)
  } catch {
    return true
  }
}

/** The names of the agents in every managed settings directory's `.claude/agents/`. */
async function managedAgentNames($: Runtime): Promise<Set<string>> {
  const names = new Set<string>()
  let read = 0
  const visit = async (folder: string, depth: number) => {
    let entries: FsEntry[]
    try { entries = await $.fs.list(folder) }
    catch { return }
    for (const entry of entries) {
      const path = `${folder}/${entry.name}`
      if (entry.kind === 'dir' && depth < MAX_AGENT_DEPTH) await visit(path, depth + 1)
      else if (entry.kind === 'file' && /\.md$/i.test(entry.name)) {
        if (++read > MAX_AGENT_FILES) throw new Error('too many managed agent definitions to read')
        names.add(agentDefinitionName(entry.name, await $.fs.read(path)))
      }
    }
  }
  for (const directory of MANAGED_DIRECTORIES) {
    const agents = `${directory}/.claude/agents`
    if (await $.fs.exists(agents)) await visit(agents, 0)
  }
  return names
}
