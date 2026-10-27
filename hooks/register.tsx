import type { HookFailure, On } from 'claude-code'
import { activate, followTranscript, forgetSessionStart, noticeStart } from './setup/activation'
import { clearProgress, drawBand, forgetBarTheme } from './band/band'
import {
  DELTA_USAGE, deltaMenu, installationUpdates, installUpdateHost, JOIN_USAGE, ORG_USAGE, registerCommands,
  runDeltaCommand,
} from './setup/commands'
import { claudeVersionWarning } from './core/compatibility'
import { completeTurn, recordRow, recordToolCall, startTurn } from './recording/delivery'
import { forgetContract } from './cli/delta-cli'
import { withQuestionHints } from './setup/interaction'
import { releaseOnEnd } from './sharing/join'
import { admitPrompt } from './recording/prompt'
import { showAnswer, shownItemId } from './watch/row-delivery'
import { drawEcho, drawRow } from './watch/rows'
import {
  cancelRequestsOf, endActivationOf, forgetRuntime, forgetTranscriptPath, markEnded, report, requests,
  resetRuntime, type HookEvent, type HookNext, type Runtime, stateFor,
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
async function logHookFailure($: Runtime, hook: string, failure: HookFailure) {
  // Claude Code before 2.1.306 also reports a re-entry here, which is no failure.
  if (failure.kind !== 'throw' && failure.kind !== 'timeout') return
  try { await $.ui.log(`Delta's ${hook} hook failed (${failure.kind}): ${failure.message ?? 'no detail'}`, { to: 'debug' }) }
  // The log is best effort; the handler's answer does not depend on it.
  catch {}
}

function recordAppended($: Runtime, e: HookEvent<'session.append'>, next: HookNext<'session.append'>) {
  return e.agentId !== undefined ? recordChildRow($, e, e.agentId, next) : recordRow($, e, next)
}

export function register(on: On) {
  on('prompt.submit', ($, e, next) => admitPrompt($, e, next)).catch(async ($, e, next) => {
    await logHookFailure($, 'prompt.submit', next.error)
    return { drop: 'Delta could not safely prepare this shared turn. Retry after the watcher is ready.' }
  })

  // Claude 2.1.299+ raises turn.start inside a child agent's or teammate's own loop, with `agentId`
  // set. That loop is not the shared conversation: only the main loop's turns may bind
  // `currentTurnId` or open an execution. A recorded subagent's turn is its own thread's.
  on('turn.start', ($, e, next) => e.agentId !== undefined
    ? startChildTurn($, e, e.agentId, next) : startTurn($, e, next))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return completeChildTurn($, e, e.agentId, next)
    const result = await completeTurn($, e, next)
    // Claude names a session in its transcript file, not through any hook, so the title is read there
    // when a turn ends: the title Claude chose for the first prompt, or a `/rename` made since. A turn's
    // end never waits for the transcript or its title, and neither can fail it.
    void $.session.id().then((session) => followTranscript($, session)).catch(() => {})
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => drawBand($, e, next))

  // The plugin's own questions draw a hint beside each option, as the option's description.
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const questions = withQuestionHints(e.props.questions)
    return next(questions ? { ...e, props: { ...e.props, questions } } : e)
  })

  // The plugin's own `show` echo, which Desktop draws as a user row.
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => drawEcho($, e, next))

  on('ui.render', { component: 'CommandOutput' }, ($, e, next) => drawRow($, e, next))
  on('session.end', async ($, e, next) => {
    const session = e.sessionId
    await forgetSessionStart($, session, e.reason)
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
    if (!requests.join && !requests.share) clearProgress($)
    forgetRuntime(session, runtime)
    await markEnded($, session)
    await releaseOnEnd($, session, e.reason, runtime)
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
    const version = await $.session.version().catch(() => undefined)
    const warning = claudeVersionWarning(version?.base ?? version?.version)
    if (warning) await $.ui.log(warning, { to: 'transcript' })
    await registerCommands($)
    const result = await next(e)
    $.clock.after(0, () => { void installationUpdates.check(installUpdateHost($)) })
    const session = await $.session.id()
    try { await activate($, session) }
    catch (error) { await report($, error) }
    // Claude delivers the first prompt only after this hook returns, so a session started for a
    // hand-off finishes joining here, and its opening line meets a joined session. Waiting in
    // `prompt.submit` instead would count the join against that hook's 10-second budget, while
    // the Delta commands the join runs here are `$` calls, which that budget never counts. The
    // claim reports its own failure.
    await stateFor(session).handoffClaim
    // Claude reports how a session started only to `classic.SessionStart`, which the organization's
    // built-in guard keeps from this plugin, so the start is worked out here; after `/clear` or `/resume`,
    // which raise no `session.start`, the session's first activity works it out instead.
    await noticeStart($, session)
    return result
  })

  on('command.run', { command: 'delta' }, async ($, e) => {
    const action = e.args.trim()
    // The plugin's own rows reach this handler, and nothing else: a person who types the internal
    // form gets the usage text below. The argument is an item id, never content.
    const internal = shownItemId(action)
    // A plugin's own run reads this plugin's name; anyone else who types the internal form is a
    // person or another plugin, and gets the usage text below.
    if (internal !== undefined && e.origin?.kind === 'plugin' && e.origin.name === $.plugin.name)
      return { text: showAnswer(internal) }
    if (!action) return deltaMenu($, 'menu', DELTA_USAGE, 'delta_subcommand')
    return runDeltaCommand($, action, 'delta_subcommand')
  })
  on('command.run', { command: 'delta-share' }, async ($, e) => runDeltaCommand($, `share ${e.args.trim()}`.trim(), 'dedicated_command'))
  // Typed without its argument, a command asks for it instead of failing.
  on('command.run', { command: 'delta-join' }, async ($, e) => e.args.trim()
    ? runDeltaCommand($, `join ${e.args.trim()}`, 'dedicated_command')
    : deltaMenu($, 'join', JOIN_USAGE, 'dedicated_command'))
  on('command.run', { command: 'delta-setup' }, async ($, e) => runDeltaCommand($, `setup ${e.args.trim()}`.trim(), 'dedicated_command'))
  on('command.run', { command: 'delta-update' }, async ($, e) => runDeltaCommand($, `update ${e.args.trim()}`.trim(), 'dedicated_command'))
  on('command.run', { command: 'delta-org' }, async ($, e) => e.args.trim()
    ? runDeltaCommand($, `org ${e.args.trim()}`, 'dedicated_command')
    : deltaMenu($, 'team', ORG_USAGE, 'dedicated_command'))

  // Only the rows this plugin records, so no hook of its own is in the chain of a row the organization's
  // built-in guard keeps from a person's plugins: what Claude adds for the model (attachments, a hook's
  // context, a compaction, a skill's body the Skill tool hands over) and the organization's notes.
  on('session.append', { door: ['prompt', 'command', 'response', 'tool-result', 'delivery'] }, recordAppended)
    .catch(async ($, e, next) => { await logHookFailure($, 'session.append', next.error); return next(e) })
  on('session.append', { door: 'tool-message', origin: { kind: 'tool', tool: /^(?!Skill$)/ } }, recordAppended)
    .catch(async ($, e, next) => { await logHookFailure($, 'session.append', next.error); return next(e) })

  on('session.send', async ($, e, next) => {
    const session = await $.session.id()
    if (typeof e.to !== 'string' || !recordsChildren(session)) return next(e)
    const sender = e.agentId !== undefined && children.has(e.agentId) ? e.agentId : session
    try {
      const sent = await sendToThread($, session, sender, e.to, e.text, (to, text) => next({ ...e, to, text }))
      return sent ?? await next(e)
    } catch (error) {
      return { isDelivered: false, reason: `Delta could not run that thread here: ${errorText(error)}` }
    }
  }).catch(async ($, e, next) => { await logHookFailure($, 'session.send', next.error); return next(e) })

  // An Agent call is followed while it runs, which tells a foreground subagent from a background one.
  on('tool.call', async ($, e, next) => {
    const run = () => e.agentId !== undefined ? recordChildToolCall($, e, e.agentId, next) : recordToolCall($, e, next)
    return isAgentTool(e.tool) ? followAgentCall($, e, run) : run()
  }).catch(async ($, e, next) => { await logHookFailure($, 'tool.call', next.error); return next(e) })
}
