/**
 * `/delta unshare`: make the current session's Cloud thread private without stopping sync.
 */
import { type CommandForm, threadUnshare } from '../cli/delta-cli'
import { load, requests, save, serial, stillActive } from '../core/session-state'
import type { Host } from '../core/host'
import { errorText } from '../core/text'

/** Change the server's audience, then preserve it for future share recovery and band redraws. */
export async function unshare(host: Host, form: CommandForm): Promise<string> {
  const session = await host.session.id()
  const current = stillActive(session)
  const binding = await serial(() => load(host, session))
  if (!binding.thread) throw new Error('This session has no Delta thread yet. Run /delta-share to sync it first')
  const unshared = await threadUnshare(host, binding.thread, form)
  if (requests.shareAfterTurn?.session === session) requests.shareAfterTurn = undefined
  try {
    await serial(async () => {
      const saved = await load(host, session)
      if (saved.thread !== unshared.thread_id)
        throw new Error('The session changed while unsharing')
      await save(host, { ...saved, visibility: 'private' }, current)
    })
  } catch (error) {
    host.ui.invalidate()
    return `The thread is private on Delta, but its local sharing status could not be saved (${errorText(error)}). Retry /delta-unshare before using /delta-share.`
  }
  host.ui.invalidate()
  return 'This thread is private. Explicitly invited people still have access, and syncing continues.'
}
