/**
 * Attributing a tool call's file edits to the call. Claude edits files itself, so Delta sees them only
 * when its mounted checkout ingests them, before the call's records arrive. Delta captures what the
 * checkout ingests while the call runs and names the call by its `tool_use_id`.
 */
import { threadCapture } from '../cli/delta-cli'
import type { Host } from '../core/host'
import { errorText } from '../core/text'

/** The tools that can change files in the checkout. Others run without a capture. */
const EDITING_TOOLS = new Set(['Bash', 'Edit', 'MultiEdit', 'NotebookEdit', 'Write'])

/**
 * How long a tool call waits for Delta to start capturing before running uncaptured. Delta answers
 * locally, so a slower answer means it is busy, and the call should not wait for it.
 */
const START_TIMEOUT_MS = 5_000

/** Stopping runs after the call, so it can wait longer without delaying anything. */
const STOP_TIMEOUT_MS = 60_000

/**
 * Set once the CLI turns out to predate `thread capture`. It spans sessions because they share the
 * CLI, which Claude Code is restarted to change.
 */
let unsupported = false

/** Whether calls of `tool` are captured. */
export function capturesEdits(tool: string): boolean {
  return EDITING_TOOLS.has(tool)
}

/**
 * Start capturing the edits of the tool call `call.toolUseId`, returning a function that stops it, or
 * undefined when nothing is captured. A failure is logged and leaves the call uncaptured: attribution
 * never keeps a tool from running.
 */
export async function startCapture(
  host: Host, call: { reference: string; externalId: string; toolUseId: string },
): Promise<(() => void) | undefined> {
  if (unsupported) return undefined
  try {
    const started = await threadCapture(host, call, 'start', START_TIMEOUT_MS)
    if (!started) {
      unsupported = true
      return undefined
    }
    if (!started.checkouts) return undefined
  } catch (error) {
    await logCaptureFailure(host, 'start', error)
    return undefined
  }
  return () => {
    // Delta also stops the capture once Claude Code exits, so a stop that fails only ends it later.
    void threadCapture(host, call, 'stop', STOP_TIMEOUT_MS).catch((error) => logCaptureFailure(host, 'stop', error))
  }
}

async function logCaptureFailure(host: Host, action: 'start' | 'stop', error: unknown) {
  try { await host.ui.log(`Delta could not ${action} attributing a tool call's edits: ${errorText(error)}`, { to: 'debug' }) }
  catch { /* reporting never fails a hook */ }
}
