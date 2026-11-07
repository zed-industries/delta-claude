/**
 * Attributing a tool call's file edits to the call. Claude edits files itself, so Delta sees them only
 * when its mounted checkout ingests them, before the call's records arrive. Delta captures what the
 * checkout ingests while the call runs and names the call by its `tool_use_id`. Each start and stop
 * carries the time the call started or ended, so the call doesn't wait for Delta, and Delta pairs a
 * stop that arrives before its start.
 */
import { threadCapture } from '../cli/delta-cli'
import type { Host } from '../core/host'
import { errorText } from '../core/text'

/** The tools that can change files in the checkout. Others run without a capture. */
const EDITING_TOOLS = new Set(['Bash', 'Edit', 'MultiEdit', 'NotebookEdit', 'Write'])

/**
 * How long a start may take. The first call waits for its start, so a slower answer, which means Delta
 * is busy, lets that call run uncaptured.
 */
const START_TIMEOUT_MS = 5_000

/** Stopping runs after the call, so it can wait longer without delaying anything. */
const STOP_TIMEOUT_MS = 60_000

/**
 * Set once the CLI turns out to predate `thread capture` or its `--started-at`. It spans sessions
 * because they share the CLI, which Claude Code is restarted to change.
 */
let unsupported = false

/** Set once a call has waited for its start, whose answer says whether the CLI supports capture. */
let probed = false

/** Whether calls of `tool` are captured. */
export function capturesEdits(tool: string): boolean {
  return EDITING_TOOLS.has(tool)
}

/**
 * Start capturing the edits of the tool call `call.toolUseId`, returning a function that stops it, or
 * undefined when the CLI can't capture. Only the process's first call waits for Delta; later starts
 * run beside their calls. A failure is logged and at worst leaves the call uncaptured: attribution
 * never keeps a tool from running. The stop runs even after a failed start, which Delta may still
 * have registered; Delta forgets a stop no start pairs with after a minute.
 */
export async function startCapture(
  host: Host, call: { reference: string; externalId: string; toolUseId: string },
): Promise<(() => void) | undefined> {
  if (unsupported) return undefined
  const started = threadCapture(host, call, 'start', await host.clock.now(), START_TIMEOUT_MS)
  if (probed) void started.catch((error) => logCaptureFailure(host, 'start', error))
  else {
    probed = true
    try {
      if (!await started) {
        unsupported = true
        return undefined
      }
    } catch (error) { await logCaptureFailure(host, 'start', error) }
  }
  // Delta also stops the capture once Claude Code exits, so a stop that fails only ends it later.
  return () => void stopCapture(host, call)
}

async function stopCapture(host: Host, call: { reference: string; externalId: string; toolUseId: string }) {
  try { await threadCapture(host, call, 'stop', await host.clock.now(), STOP_TIMEOUT_MS) }
  catch (error) { await logCaptureFailure(host, 'stop', error) }
}

async function logCaptureFailure(host: Host, action: 'start' | 'stop', error: unknown) {
  try { await host.ui.log(`Delta could not ${action} attributing a tool call's edits: ${errorText(error)}`, { to: 'debug' }) }
  catch { /* reporting never fails a hook */ }
}
