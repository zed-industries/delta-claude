/**
 * Recording a Claude conversation forked from a recorded one, as `/fork` and `/branch` make it. The fork
 * records into a subthread of the parent's thread that holds the parent's conversation through the fork
 * point, and shares the parent's checkout, where Claude starts the fork.
 */
import type { ApiMessage } from 'claude-code'
import { requireContract, threadCreate } from '../cli/delta-cli'
import { DeltaCommandError, FORK_CONTRACT_VERSION } from '../cli/thread-commands'
import { isJsonObject } from '../core/json'
import { type Binding, key, listStoreKeys, load, producerOf, save, serial, storedBinding, transcriptPathOf } from '../core/session-state'
import type { Host } from '../core/host'
import { expectedTranscript } from '../core/transcript'
import { messageUpdates } from '../recording/content'
import { stageRecord } from '../recording/delivery'
import { snapshotMessages } from '../recording/snapshot'
import { FS_READ_LIMIT, readFrom } from '../recording/title'

/**
 * How many of the fork's last shared rows are tried as its fork point. A row the parent never recorded,
 * such as a slash command's, is skipped for the one before it.
 */
const MAX_FORK_POINTS = 8
/**
 * How much of a transcript's start is read to tell whether it is a fork: `/fork` writes its
 * `derived-from` row among the first rows, and `/branch` marks the first rows it copies.
 */
const FORK_HEAD_BYTES = 64 * 1024

/**
 * The `derived-from` sources that copied a conversation. Others only name a related session, such as
 * `launch` for the session whose `claude --bg` started this one.
 */
const COPIED_VIA = new Set(['fork', 'background', 'branch'])

/** The session a forked transcript was copied from, and the name Claude gave the fork. */
export type ForkOrigin = { parent: string; name?: string }

/**
 * Where a transcript's conversation was forked from. `/fork` writes a `derived-from` row naming the
 * session it copied; `/branch` marks each copied row with `forkedFrom`.
 */
export function forkOriginOf(rows: readonly unknown[]): ForkOrigin | undefined {
  let parent: string | undefined
  let name: string | undefined
  for (const row of rows) {
    if (!isJsonObject(row)) continue
    if (row.type === 'agent-name' && typeof row.agentName === 'string' && row.agentName.trim()) name = row.agentName
    if (parent) continue
    if (row.type === 'derived-from' && Array.isArray(row.sessions)) {
      const source = row.sessions.find((entry) => isJsonObject(entry) && entry.type === 'claude_code_session' &&
        typeof entry.via === 'string' && COPIED_VIA.has(entry.via))
      if (isJsonObject(source) && typeof source.id === 'string') parent = source.id
    } else if (isJsonObject(row.forkedFrom) && typeof row.forkedFrom.sessionId === 'string') {
      parent = row.forkedFrom.sessionId
    }
  }
  return parent ? { parent, ...name ? { name } : {} } : undefined
}

/**
 * The ids a fork point can be named by, latest first: for each message row the fork shares with its
 * parent, the id of the last record recording made of it. A fork keeps the ids of the rows it copies.
 */
export function forkPoints(rows: readonly unknown[], parentRows: ReadonlySet<string>): string[] {
  const points: string[] = []
  for (const { uuid, message } of messageRows(rows)) {
    if (!parentRows.has(uuid)) continue
    const last = messageUpdates(message, uuid).at(-1)
    const id = last?.messageId ?? last?.toolCallId
    if (typeof id === 'string') points.push(id)
  }
  return points.reverse()
}

/**
 * The messages the fork added after the history it shares with its parent, each with its row's id, by
 * which live recording names its records too.
 */
export function forkedMessages(rows: readonly unknown[], parentRows: ReadonlySet<string>): MessageRow[] {
  return messageRows(rows).flatMap(({ uuid, message }) => {
    if (parentRows.has(uuid)) return []
    // Framing a person never wrote, such as a command's echo, is left out as a share's export leaves it.
    const [kept] = snapshotMessages([message])
    return kept ? [{ uuid, message: kept }] : []
  })
}

/** A transcript row holding a message of the conversation, and the row's id. */
type MessageRow = { uuid: string; message: ApiMessage }

function messageRows(rows: readonly unknown[]): MessageRow[] {
  return rows.flatMap((row) => {
    if (!isJsonObject(row) || typeof row.uuid !== 'string' || row.isMeta === true) return []
    if (row.type !== 'user' && row.type !== 'assistant') return []
    const message = row.message
    if (!isJsonObject(message)) return []
    const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
    if (!Array.isArray(content)) return []
    // Transcript rows hold the Messages API content that recording converts.
    return [{ uuid: row.uuid, message: { role: row.type, content } as ApiMessage }]
  })
}

/** Whether Claude forked `session` from a session that records into Delta. */
export async function isRecordedFork(host: Host, session: string): Promise<boolean> {
  return await recordedForkOf(host, session) !== undefined
}

/**
 * Record `session` into a fork of the thread its parent records, when Claude forked it from a recorded
 * session. The fork is a subthread holding the parent's conversation through the last row both share,
 * and the session records into it as a producer of its own, from the start.
 */
export async function adoptFork(host: Host, session: string, isCurrent: () => boolean): Promise<Binding | undefined> {
  const fork = await recordedForkOf(host, session)
  if (!fork || !isCurrent()) return
  const { transcript, origin, parent } = fork
  const rows = await readRows(host, transcript)
  const parentRows = new Set((await readRows(host, parent.transcript)).flatMap((row) =>
    isJsonObject(row) && typeof row.uuid === 'string' ? [row.uuid] : []))
  const points = forkPoints(rows, parentRows)
  let created: Awaited<ReturnType<typeof threadCreate>> | undefined
  for (const after of points.slice(0, MAX_FORK_POINTS)) {
    if (!isCurrent()) return
    try {
      created = await threadCreate(host, {
        externalId: session,
        parent: { reference: parent.locator ?? parent.thread, name: origin.name, fork: { externalId: producerOf(parent), after } },
      })
      break
    } catch (error) {
      // The parent recorded nothing of this row, so the fork point is an earlier one.
      if (!(error instanceof DeltaCommandError && error.code === 'invalid_reference')) throw error
    }
  }
  if (!created) throw new Error(`Delta has no record of where this conversation was forked from session ${origin.parent}`)
  const thread = created.thread_id
  const locator = typeof created.reference === 'string' ? created.reference : undefined
  return serial(async () => {
    const current = await load(host, session)
    if (current.thread || !isCurrent()) return
    let forked: Binding = {
      ...current, thread, ...locator ? { locator } : {}, snapshot: true, transcript,
      ...parent.checkout ? { checkout: parent.checkout } : {},
      ...parent.checkoutReference ? { checkoutReference: parent.checkoutReference } : {},
      ...parent.autoUpload ? { autoUpload: parent.autoUpload } : {},
      ...parent.organization ? { organization: parent.organization } : {},
      ...parent.visibility ? { visibility: parent.visibility } : {},
    }
    // What the fork said before it recorded, read last so a row stored after this records live.
    for (const { uuid, message } of forkedMessages(await readRows(host, transcript), parentRows)) {
      for (const update of messageUpdates(message, uuid, undefined, { root: forked.checkout }))
        forked = await stageRecord(host, forked, { update })
    }
    await save(host, forked)
    return forked
  })
}

/** Whether a session other than `session` records in a way a fork of it could be adopted. */
async function anyForkParent(host: Host, session: string): Promise<boolean> {
  for (const storeKey of await listStoreKeys(host)) {
    if (!storeKey.startsWith('session:') || storeKey === key(session)) continue
    const binding = await storedBinding(host, storeKey)
    if (binding && canParentFork(binding)) return true
  }
  return false
}

/**
 * Whether a fork of the session bound by `binding` can record into a fork of its thread. A joined
 * session works in Delta's mounts rather than a checkout the fork starts in.
 */
function canParentFork(binding: Binding): binding is Binding & { thread: string; transcript: string } {
  return !!binding.thread && !!binding.snapshot && !binding.joined && !!binding.transcript
}

/** A fork of a recorded session: its transcript, where Claude forked it from, and that session's binding. */
type RecordedFork = { transcript: string; origin: ForkOrigin; parent: Binding & { thread: string; transcript: string } }

/** The fork `session` is of a recorded session; a transcript that is missing or unreadable is no fork. */
async function recordedForkOf(host: Host, session: string): Promise<RecordedFork | undefined> {
  let transcript: string | undefined
  let head: unknown[]
  try {
    // Only a fork of a recorded session is adopted, so without one the transcript isn't read.
    if (!await anyForkParent(host, session)) return
    transcript = transcriptPathOf(session) ?? await expectedTranscript(host, session)
    if (!transcript || !await host.fs.exists(transcript)) return
    head = await readRows(host, transcript, FORK_HEAD_BYTES)
  } catch { return }
  const origin = forkOriginOf(head)
  if (!origin) return
  const parent = await storedBinding(host, key(origin.parent))
  if (!parent || !canParentFork(parent)) return
  // An older Delta cannot fork a thread at a recorded point, so the fork goes unrecorded.
  try { if (await requireContract(host, session) < FORK_CONTRACT_VERSION) return }
  catch { return }
  return { transcript, origin, parent }
}

/**
 * The rows of the transcript at `path`, or of about its first `limit` bytes, where the read stops; a
 * line that does not parse, such as the cut last line of a limited read, is left out.
 */
async function readRows(host: Host, path: string, limit = Infinity): Promise<unknown[]> {
  let text = ''
  try { await readFrom(host, path, 0, (piece) => { text += piece; return text.length < limit }) }
  catch {
    if ((await host.fs.stat(path)).size > FS_READ_LIMIT) throw new Error(`${path} is too large to read`)
    text = await host.fs.read(path)
  }
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return []
    try { return [JSON.parse(line) as unknown] }
    catch { return [] }
  })
}
