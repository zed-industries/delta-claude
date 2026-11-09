/**
 * Attributing a tool call's file edits to the call. Claude edits files itself, so Delta sees them only
 * when its mounted checkout ingests them, before the call's records arrive. Delta captures what the
 * checkout ingests while the call runs and names the call by its `tool_use_id`. Each start and stop
 * carries the time the call started or ended, so the call doesn't wait for Delta, and Delta pairs a
 * stop that arrives before its start.
 */
import { threadCapture, verifiedContract } from '../cli/delta-cli'
import { CAPTURE_CONTRACT_VERSION } from '../cli/thread-commands'
import type { Host } from '../core/host'
import { errorText } from '../core/text'

/** The tools that can change files in the checkout. Others run without a capture. */
const EDITING_TOOLS = new Set(['Bash', 'Edit', 'MultiEdit', 'NotebookEdit', 'Write'])

const START_TIMEOUT_MS = 5_000
const STOP_TIMEOUT_MS = 60_000

/** Whether calls of `tool` are captured. */
export function capturesEdits(tool: string): boolean {
  return EDITING_TOOLS.has(tool)
}

/** Remember a call's start, submitting it immediately when its thread is already known. */
export async function startCapture(
  host: Host, session: string, call: { reference?: string; externalId: string; toolUseId: string },
): Promise<EditCapture | undefined> {
  if ((verifiedContract(session) ?? 0) < CAPTURE_CONTRACT_VERSION) return undefined
  const capture = new EditCapture(host, call, await host.clock.now())
  if (call.reference) capture.submit(call.reference)
  return capture
}

/** A call's capture can finish before its thread exists; submission keeps both original timestamps. */
export class EditCapture {
  private reference?: string
  private endedAt?: number

  constructor(
    private readonly host: Host,
    private readonly call: { externalId: string; toolUseId: string },
    private readonly startedAt: number,
  ) {}

  submit(reference: string) {
    if (this.reference) return
    this.reference = reference
    sendCapture(this.host, { ...this.call, reference }, 'start', this.startedAt)
    if (this.endedAt !== undefined)
      sendCapture(this.host, { ...this.call, reference }, 'stop', this.endedAt)
  }

  stop() {
    void this.host.clock.now().then((endedAt) => {
      this.endedAt = endedAt
      if (this.reference)
        sendCapture(this.host, { ...this.call, reference: this.reference }, 'stop', endedAt)
    }).catch((error) => logCaptureFailure(this.host, 'stop', error))
  }
}

function sendCapture(
  host: Host, call: { reference: string; externalId: string; toolUseId: string }, action: 'start' | 'stop', at: number,
) {
  void threadCapture(host, call, action, at, action === 'start' ? START_TIMEOUT_MS : STOP_TIMEOUT_MS)
    .catch((error) => logCaptureFailure(host, action, error))
}

async function logCaptureFailure(host: Host, action: 'start' | 'stop', error: unknown) {
  try { await host.ui.log(`Delta could not ${action} attributing a tool call's edits: ${errorText(error)}`, { to: 'debug' }) }
  catch { /* reporting never fails a hook */ }
}
