import type { EngineInterface, HookFailure, On } from 'claude-code'
import { activate, followTranscript, forgetSessionStart, noticeStart } from './setup/activation'
import { clearProgress, drawBand, forgetBarTheme } from './band/band'
import {
  DELTA_USAGE, deltaMenu, installationUpdates, installUpdateHost, JOIN_USAGE, ORG_USAGE, registerCommands,
  runDeltaCommand,
} from './setup/commands'
import { claudeVersionWarning } from './core/compatibility'
import { completeTurn, recordRow, recordToolCall, startTurn } from './recording/delivery'
import { forgetContract } from './cli/delta-cli'
import type { Host } from './core/host'
import { withQuestionHints } from './setup/interaction'
import { releaseOnEnd } from './sharing/join'
import { admitPrompt } from './recording/prompt'
import { recheckPluginUpdates, startPluginUpdates, stopPluginUpdates } from './plugin-update/updates'
import { showAnswer, shownItemId } from './watch/row-delivery'
import { drawEcho, drawRow } from './watch/rows'
import {
  cancelRequestsOf, endActivationOf, forgetRuntime, forgetTranscriptPath, markEnded, report, requests,
  resetRuntime, type HookEvent, type HookNext, stateFor,
} from './core/session-state'
import {
  children, completeChildTurn, followAgentCall, forgetSubagents, recordChildRow, recordChildToolCall, recordsChildren,
  startChildTurn,
} from './subagents/subagents'
import { errorText } from './core/text'
import { isAgentTool } from './subagents/children'
import { forgetThreadNotes, sendToThread } from './subagents/thread-runs'
import { forgetTitleReader } from './recording/title'
import { stopWatching } from './watch/watch'

/**
 * Write why a hook failed to the debug log, for its `.catch` handler. Every hook but `prompt.submit`
 * fails open: Claude goes on as if Delta were not installed, so recording can never block a
 * person's work. A re-entry is no failure, and a handler's own `$` calls reject during one.
 */
async function logHookFailure($: EngineInterface, hook: string, failure: HookFailure) {
  // Claude Code before 2.1.306 also reports a re-entry here, which is no failure.
  if (failure.kind !== 'throw' && failure.kind !== 'timeout') return
  try { await $.ui.log(`Delta's ${hook} hook failed (${failure.kind}): ${failure.message ?? 'no detail'}`, { to: 'debug' }) }
  // The log is best effort; the handler's answer does not depend on it.
  catch {}
}

function recordAppended($: EngineInterface, e: HookEvent<'session.append'>, next: HookNext<'session.append'>) {
  const host = hostOf($)
  return e.agentId !== undefined ? recordChildRow(host, e, e.agentId, next) : recordRow(host, e, next)
}

/**
 * Bind the engine calls Delta's features make to one hook's `$`. The directory lists a plugin's
 * capabilities from plain `$.noun.method(...)` calls in the file that registers its hooks, and refuses
 * `$` handed to a function in another file, so this is the only place features reach the engine.
 * Each hook binds its own: `$` carries the context of the hook that received it.
 */
function hostOf($: EngineInterface): Host {
  return {
    agent: {
      list: () => $.agent.list(),
      spawn: (input) => $.agent.spawn(input),
    },
    clock: {
      after: (ms, run) => $.clock.after(ms, run),
      every: (ms, run) => $.clock.every(ms, run),
      now: () => $.clock.now(),
      sleep: (ms, options) => $.clock.sleep(ms, options),
    },
    command: {
      list: () => $.command.list(),
      register: (command) => $.command.register(command),
      run: (input) => $.command.run(input),
    },
    config: {
      list: () => $.config.list(),
    },
    env: {
      claudeCodeRemote: () => $.env.get('CLAUDE_CODE_REMOTE'),
      claudeConfigDir: () => $.env.get('CLAUDE_CONFIG_DIR'),
      disableNonessentialTraffic: () => $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'),
      home: () => $.env.get('HOME'),
      os: () => $.env.get('OS'),
      userProfile: () => $.env.get('USERPROFILE'),
    },
    fs: {
      exists: (path) => $.fs.exists(path),
      list: (path) => $.fs.list(path),
      read: (path) => $.fs.read(path),
      stat: (path, options) => $.fs.stat(path, options),
      write: (path, text) => $.fs.write(path, text),
    },
    http: {
      fetch: (url, init) => $.http.fetch(url, init),
    },
    plugin: {
      name: $.plugin.name,
      root: $.plugin.root,
    },
    process: {
      run: (argv, init) => $.process.run(argv, init),
      spawn: (request) => $.process.spawn(request),
    },
    prompt: {
      submit: (input) => $.prompt.submit(input),
    },
    settings: {
      policy: () => $.settings.read({ source: 'policy' }),
    },
    session: {
      agentApiMessages: (agentId) => $.session.messages({ agentId, as: 'api' }),
      agentMessages: (args) => $.session.messages(args),
      apiMessages: () => $.session.messages({ as: 'api' }),
      append: (args) => $.session.append(args),
      cwd: () => $.session.cwd(),
      id: () => $.session.id(),
      messages: () => $.session.messages(),
      root: () => $.session.root(),
      surfaces: () => $.session.surfaces(),
      turns: () => $.session.turns(),
      version: () => $.session.version(),
    },
    store: {
      delete: (key) => $.store.delete(key),
      get: (key) => $.store.get(key),
      keys: () => $.store.keys(),
      set: (key, value) => $.store.set(key, value),
    },
    tool: {
      stopTask: (taskId) => $.tool.call({ tool: 'TaskStop', task_id: taskId }),
    },
    turn: {
      abort: (input) => $.turn.abort(input),
    },
    ui: {
      ask: (question, options) => $.ui.ask(question, options),
      copy: (args) => $.ui.copy(args),
      invalidate: () => $.ui.invalidate('ui.render'),
      log: (text, options) => $.ui.log(text, options),
      resolve: (e) => $.ui.resolve(e),
      status: (text) => $.ui.status(text),
    },
  }
}

export function register(on: On) {
  on('session.attach', async ($, e, next) => {
    const host = hostOf($)
    const result = await next(e)
    if (e.surface === 'desktop') recheckPluginUpdates(host, await $.session.id())
    return result
  }).catch(async ($, e, next) => { await logHookFailure($, 'session.attach', next.error); return next(e) })

  on('prompt.submit', ($, e, next) => {
    const host = hostOf($)
    return admitPrompt(host, e, next)
  }).catch(async ($, e, next) => {
    await logHookFailure($, 'prompt.submit', next.error)
    return { drop: 'Delta could not safely prepare this shared turn. Retry after the watcher is ready.' }
  })

  // Claude 2.1.299+ raises turn.start inside a child agent's or teammate's own loop, with `agentId`
  // set. That loop is not the shared conversation: only the main loop's turns may bind
  // `currentTurnId` or open an execution. A recorded subagent's turn is its own thread's.
  on('turn.start', ($, e, next) => {
    const host = hostOf($)
    return e.agentId !== undefined
      ? startChildTurn(host, e, e.agentId, next) : startTurn(host, e, next)
  })

  on('turn.complete', async ($, e, next) => {
    const host = hostOf($)
    if (e.agentId !== undefined) return completeChildTurn(host, e, e.agentId, next)
    const result = await completeTurn(host, e, next)
    // Claude names a session in its transcript file, not through any hook, so the title is read there
    // when a turn ends: the title Claude chose for the first prompt, or a `/rename` made since. A turn's
    // end never waits for the transcript or its title, and neither can fail it.
    void $.session.id().then((session) => followTranscript(host, session)).catch(() => {})
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    const host = hostOf($)
    return drawBand(host, e, next)
  })

  // The plugin's own questions draw a hint beside each option, as the option's description.
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const questions = withQuestionHints(e.props.questions)
    return next(questions ? { ...e, props: { ...e.props, questions } } : e)
  })

  // The plugin's own `show` echo, which Desktop draws as a user row.
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    const host = hostOf($)
    return drawEcho(host, e, next)
  })

  on('ui.render', { component: 'CommandOutput' }, ($, e, next) => {
    const host = hostOf($)
    return drawRow(host, e, next)
  })
  on('session.end', async ($, e, next) => {
    const host = hostOf($)
    const session = e.sessionId
    stopPluginUpdates(host, session)
    await forgetSessionStart(host, session, e.reason)
    cancelRequestsOf(session, e.reason)
    forgetSubagents(session)
    endActivationOf(session)
    const runtime = stateFor(session)
    resetRuntime(runtime)
    await stopWatching(session)
    forgetContract(session)
    forgetTitleReader(session)
    forgetThreadNotes(session)
    // A joined or shared session keeps reporting through its transition; an ordinary end clears it.
    if (!requests.join && !requests.share) clearProgress(host)
    forgetRuntime(session, runtime)
    await markEnded(host, session)
    await releaseOnEnd(host, session, e.reason, runtime)
    // Last, since the hand-off check in releaseOnEnd still reads it.
    forgetTranscriptPath(session)
    return next(e)
  })

  // A changed theme changes the status bar's shade.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    forgetBarTheme()
    $.ui.invalidate('ui.render')
    return result
  }).catch(async ($, e, next) => { await logHookFailure($, 'config.set', next.error); return next(e) })

  on('session.start', async ($, e, next) => {
    const host = hostOf($)
    const version = await $.session.version().catch(() => undefined)
    const warning = claudeVersionWarning(version?.base ?? version?.version)
    if (warning) await $.ui.log(warning, { to: 'transcript' })
    await registerCommands(host)
    const result = await next(e)
    $.clock.after(0, () => { void installationUpdates.check(installUpdateHost(host)) })
    const session = await $.session.id()
    startPluginUpdates(host, session)
    try { await activate(host, session) }
    catch (error) { await report(host, error) }
    // Claude delivers the first prompt only after this hook returns, so a session started for a
    // hand-off finishes joining here, and its opening line meets a joined session. Waiting in
    // `prompt.submit` instead would count the join against that hook's 10-second budget, while
    // the Delta commands the join runs here are `$` calls, which that budget never counts. The
    // claim reports its own failure.
    await stateFor(session).handoffClaim
    // Claude reports how a session started only to `classic.SessionStart`, which the organization's
    // built-in guard keeps from this plugin, so the start is worked out here; after `/clear` or `/resume`,
    // which raise no `session.start`, the session's first activity works it out instead.
    await noticeStart(host, session)
    return result
  })

  on('command.run', { command: 'delta' }, async ($, e) => {
    const host = hostOf($)
    const action = e.args.trim()
    // The plugin's own rows reach this handler, and nothing else: a person who types the internal
    // form gets the usage text below. The argument is an item id, never content.
    const internal = shownItemId(action)
    // A plugin's own run reads this plugin's name; anyone else who types the internal form is a
    // person or another plugin, and gets the usage text below.
    if (internal !== undefined && e.origin?.kind === 'plugin' && e.origin.name === $.plugin.name)
      return { text: showAnswer(internal) }
    if (!action) return deltaMenu(host, 'menu', DELTA_USAGE, 'delta_subcommand')
    return runDeltaCommand(host, action, 'delta_subcommand')
  }).catch(async ($, e, next) => { await logHookFailure($, '/delta', next.error); return next(e) })
  on('command.run', { command: 'delta-share' }, async ($, e) => {
    const host = hostOf($)
    return runDeltaCommand(host, `share ${e.args.trim()}`.trim(), 'dedicated_command')
  }).catch(async ($, e, next) => { await logHookFailure($, '/delta-share', next.error); return next(e) })
  // Typed without its argument, a command asks for it instead of failing.
  on('command.run', { command: 'delta-join' }, async ($, e) => {
    const host = hostOf($)
    return e.args.trim()
      ? runDeltaCommand(host, `join ${e.args.trim()}`, 'dedicated_command')
      : deltaMenu(host, 'join', JOIN_USAGE, 'dedicated_command')
  }).catch(async ($, e, next) => { await logHookFailure($, '/delta-join', next.error); return next(e) })
  on('command.run', { command: 'delta-setup' }, async ($, e) => {
    const host = hostOf($)
    return runDeltaCommand(host, `setup ${e.args.trim()}`.trim(), 'dedicated_command')
  }).catch(async ($, e, next) => { await logHookFailure($, '/delta-setup', next.error); return next(e) })
  on('command.run', { command: 'delta-update' }, async ($, e) => {
    const host = hostOf($)
    return runDeltaCommand(host, `update ${e.args.trim()}`.trim(), 'dedicated_command')
  }).catch(async ($, e, next) => { await logHookFailure($, '/delta-update', next.error); return next(e) })
  on('command.run', { command: 'delta-plugin-update' }, async ($, e) => {
    const host = hostOf($)
    return runDeltaCommand(host, `plugin-update ${e.args.trim()}`.trim(), 'dedicated_command')
  }).catch(async ($, _e, next) => {
    await logHookFailure($, '/delta-plugin-update', next.error)
    return { text: 'Delta could not complete the plugin update command. Retry /delta-plugin-update.' }
  })
  on('command.run', { command: 'delta-org' }, async ($, e) => {
    const host = hostOf($)
    return e.args.trim()
      ? runDeltaCommand(host, `org ${e.args.trim()}`, 'dedicated_command')
      : deltaMenu(host, 'team', ORG_USAGE, 'dedicated_command')
  }).catch(async ($, e, next) => { await logHookFailure($, '/delta-org', next.error); return next(e) })

  // Only the rows this plugin records, so no hook of its own is in the chain of a row the organization's
  // built-in guard keeps from a person's plugins: what Claude adds for the model (attachments, a hook's
  // context, a compaction, a skill's body the Skill tool hands over) and the organization's notes.
  on('session.append', { door: ['prompt', 'command', 'response', 'tool-result', 'delivery'] }, recordAppended)
    .catch(async ($, e, next) => { await logHookFailure($, 'session.append', next.error); return next(e) })
  on('session.append', { door: 'tool-message', origin: { kind: 'tool', tool: /^(?!Skill$)/ } }, recordAppended)
    .catch(async ($, e, next) => { await logHookFailure($, 'session.append', next.error); return next(e) })

  on('session.send', async ($, e, next) => {
    const host = hostOf($)
    const session = await $.session.id()
    if (typeof e.to !== 'string' || !recordsChildren(session)) return next(e)
    const sender = e.agentId !== undefined && children.has(e.agentId) ? e.agentId : session
    try {
      const sent = await sendToThread(host, session, sender, e.to, e.text, (to, text) => next({ ...e, to, text }))
      return sent ?? await next(e)
    } catch (error) {
      return { isDelivered: false, reason: `Delta could not run that thread here: ${errorText(error)}` }
    }
  }).catch(async ($, e, next) => { await logHookFailure($, 'session.send', next.error); return next(e) })

  // An Agent call is followed while it runs, which tells a foreground subagent from a background one.
  on('tool.call', async ($, e, next) => {
    const host = hostOf($)
    const run = () => e.agentId !== undefined ? recordChildToolCall(host, e, e.agentId, next) : recordToolCall(host, e, next)
    return isAgentTool(e.tool) ? followAgentCall(host, e, run) : run()
  }).catch(async ($, e, next) => { await logHookFailure($, 'tool.call', next.error); return next(e) })
}
