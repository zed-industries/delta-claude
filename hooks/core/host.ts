/**
 * The engine calls Delta's features make, as `hostOf` in `register.tsx` binds them from a hook's `$`.
 * Only `register.tsx` names `$`; every other module reaches the engine through a `Host`.
 */
import type {
  ApiMessage, EngineInterface, SessionMessage, SessionMessagesApiResult, SessionMessagesResult,
} from 'claude-code'

/**
 * The engine's namespaces, narrowed to the methods Delta calls. An overloaded engine method is split
 * into one member per form Delta uses, and an environment variable is one member per name, so each
 * member in `hostOf` is a single literal engine call.
 */
export type Host = {
  agent: Pick<EngineInterface['agent'], 'list' | 'spawn'>
  clock: Pick<EngineInterface['clock'], 'after' | 'every' | 'now' | 'sleep'>
  command: Pick<EngineInterface['command'], 'list' | 'register' | 'run'>
  config: Pick<EngineInterface['config'], 'list'>
  env: {
    claudeCodeRemote(): Promise<string | undefined>
    claudeConfigDir(): Promise<string | undefined>
    /** Set when Delta runs this session over ACP and records it itself. */
    deltaAcpSession(): Promise<string | undefined>
    disableNonessentialTraffic(): Promise<string | undefined>
    /** How Claude Code was started: `claude-desktop` in a Claude Code Desktop session. */
    entrypoint(): Promise<string | undefined>
    home(): Promise<string | undefined>
    os(): Promise<string | undefined>
    /** Have Claude load the instruction files of each directory `/add-dir` adds. */
    setAdditionalDirectoriesClaudeMd(): Promise<unknown>
    userProfile(): Promise<string | undefined>
  }
  fs: Pick<EngineInterface['fs'], 'exists' | 'list' | 'stat' | 'write'> & {
    read(path: string): Promise<string>
  }
  http: Pick<EngineInterface['http'], 'fetch'>
  model: Pick<EngineInterface['model'], 'complete'>
  plugin: Pick<EngineInterface['plugin'], 'name' | 'root'>
  process: Pick<EngineInterface['process'], 'run' | 'spawn'>
  prompt: Pick<EngineInterface['prompt'], 'submit'>
  session: Pick<EngineInterface['session'], 'append' | 'cwd' | 'id' | 'root' | 'surfaces' | 'turns' | 'version'> & {
    /** The main conversation's rows. */
    messages(): Promise<SessionMessage[]>
    /** The main conversation as API messages. */
    apiMessages(): Promise<ApiMessage[]>
    /** A subagent's rows, or the main conversation's when `agentId` is absent. */
    agentMessages(args: { agentId?: string }): Promise<SessionMessagesResult>
    /** A subagent's conversation as API messages. */
    agentApiMessages(agentId: string): Promise<SessionMessagesApiResult>
  }
  settings: {
    /** The organization's managed settings. */
    policy(): Promise<Readonly<Record<string, unknown>>>
  }
  store: Pick<EngineInterface['store'], 'delete' | 'get' | 'keys' | 'set'>
  tool: {
    /** Stop a background subagent, as the `TaskStop` tool does. */
    stopTask(taskId: string): Promise<unknown>
  }
  turn: Pick<EngineInterface['turn'], 'abort'>
  ui: Pick<EngineInterface['ui'], 'ask' | 'copy' | 'log' | 'resolve' | 'status'> & {
    /** Redraw the plugin's `ui.render` sites. */
    invalidate(): void
  }
}
