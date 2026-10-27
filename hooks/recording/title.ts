import { conversationText } from '../watch/conversation'
import { drain, stageRecord } from './delivery'
import { isJsonObject } from '../core/json'
import { load, report, save, serial, stateFor } from '../core/session-state'
import type { Host } from '../core/host'
import { cutsSurrogatePair } from '../core/text'

/** A thread title keeps at most this much. */
export const TITLE_LIMIT = 200

/**
 * Claude writes each title as one compact JSON row that opens this way: `ai-title` for the title it
 * chose, `custom-title` for a person's `/rename`.
 */
const TITLE_OPENINGS = ['{"type":"ai-title"', '{"type":"custom-title"']

/** A title row is short; a longer line is not one, so it is skipped rather than held. */
const TITLE_LINE_LIMIT = 16 * 1024

/**
 * Finds the session's title in transcript text fed to it in pieces, in file order. Only a line that
 * opens like a title row is held until its end, so a large row costs nothing to pass over. The last
 * rename wins over any title Claude chose, before or after it, as in Claude's own session lists.
 * A line still unfinished when the text ends is not read.
 */
export class TitleScanner {
  private chosen?: string
  private renamed?: string
  /** The current line so far, while it may still be a title row. */
  private line = ''
  private skipping = false

  get title(): string | undefined { return this.renamed ?? this.chosen }

  push(text: string) {
    let start = 0
    while (start < text.length) {
      const end = text.indexOf('\n', start)
      if (!this.skipping) {
        this.line += text.slice(start, end < 0 ? text.length : end)
        const opening = this.line.slice(0, Math.max(...TITLE_OPENINGS.map((value) => value.length)))
        if (this.line.length > TITLE_LINE_LIMIT ||
            !TITLE_OPENINGS.some((value) => value.startsWith(opening) || opening.startsWith(value))) {
          this.line = ''
          this.skipping = true
        }
      }
      if (end < 0) return
      if (!this.skipping) this.read(this.line)
      this.line = ''
      this.skipping = false
      start = end + 1
    }
  }

  private read(line: string) {
    let row: unknown
    try { row = JSON.parse(line) } catch { return }
    if (!isJsonObject(row)) return
    if (row.type === 'ai-title' && typeof row.aiTitle === 'string') this.chosen = cleanTitle(row.aiTitle) ?? this.chosen
    else if (row.type === 'custom-title' && typeof row.customTitle === 'string') this.renamed = cleanTitle(row.customTitle) ?? this.renamed
  }
}

/**
 * The command that prints a file from byte `offset` to its end, without reading what comes before:
 * `tail` on POSIX, and on Windows PowerShell seeking a stream it opens alongside Claude's own writer.
 * The path and offset reach PowerShell as JSON on stdin, never as command text.
 */
export function transcriptRead(path: string, offset: number, windows: boolean): { argv: string[]; input?: string } {
  if (!windows) return { argv: ['tail', '-c', `+${offset + 1}`, path] }
  return {
    argv: ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '[Console]::InputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference = "Stop"; ' +
      '$read = ConvertFrom-Json ([Console]::In.ReadToEnd()); ' +
      '$file = [IO.File]::Open($read.path, "Open", "Read", "ReadWrite, Delete"); ' +
      'try { [void]$file.Seek([long]$read.offset, "Begin"); $out = [Console]::OpenStandardOutput(); ' +
      '$file.CopyTo($out); $out.Flush() } finally { $file.Dispose() }'],
    input: JSON.stringify({ path, offset }),
  }
}

/** One line of at most {@link TITLE_LIMIT} characters, or undefined when nothing is left. */
function cleanTitle(title: string): string | undefined {
  const line = conversationText(title).replace(/\s+/g, ' ').trim()
  if (!line) return
  if (line.length <= TITLE_LIMIT) return line
  const end = cutsSurrogatePair(line, TITLE_LIMIT - 1) ? TITLE_LIMIT - 2 : TITLE_LIMIT - 1
  return `${line.slice(0, end)}…`
}

/** A read of what a transcript gained gives up after this long; the next turn's end reads it again. */
const TITLE_TIMEOUT_MS = 10_000
/**
 * How much of a transcript's end the first read takes in. Claude appends a title when it is chosen
 * or renamed, and repeats it as the transcript grows, so the end of the file holds the current one.
 */
const TITLE_WINDOW_BYTES = 256 * 1024
/** `$.fs.read` refuses a larger file, so reading a transcript whole is possible only below this. */
export const FS_READ_LIMIT = 4 * 1024 * 1024
/**
 * Where a session's transcript was last read to and the title found so far. `ranged` is cleared
 * once reading from an offset fails, so the session reads its transcript whole from then on.
 */
type TitleReader = { path: string; offset: number; scanner: TitleScanner; ranged: boolean; reading?: true }
const titleReaders = new Map<string, TitleReader>()

/** An ended session's transcript is not read again here. */
export function forgetTitleReader(session: string) {
  titleReaders.delete(session)
}

/**
 * Record the session's title for its thread when it changed since the last one recorded. Only a
 * shared session names its thread; a joined session takes part in someone else's. Nothing here can fail a turn or sharing: a title that cannot be read or staged is skipped, and
 * the next turn's end tries again.
 */
export async function recordTitle(host: Host, session: string, transcript: string) {
  const binding = stateFor(session).binding
  if (!binding?.snapshot || binding.joined || !binding.thread) return
  try {
    const title = await readTitle(host, session, transcript)
    if (title === undefined || title === stateFor(session).binding?.title) return
    const staged = await serial(async () => {
      const current = await load(host, session)
      if (!current.snapshot || current.joined || current.title === title) return false
      await save(host, { ...await stageRecord(host, current, { update: { sessionUpdate: 'session_info_update', title } }), title })
      return true
    })
    // Once staged, the title is delivered and reported like every other record.
    if (staged) void drain(host, session).catch((error) => report(host, error))
  } catch (error) {
    await host.ui.log(`Couldn't record this session's title: ${String(error)}`, { to: 'debug' })
  }
}

/**
 * The session's title, from what its transcript gained since the last read: the first read takes
 * in the file's last {@link TITLE_WINDOW_BYTES}, and each later one only the bytes added since. A
 * transcript that shrank was rewritten, as compaction does, and is read from its end again.
 *
 * Reading from an offset needs `tail`, or PowerShell allowed to call .NET on Windows, and either
 * may be missing or refused, as under Constrained Language Mode. Once it fails, the session reads
 * its transcript whole with `$.fs.read`, which works wherever the plugin does, up to
 * {@link FS_READ_LIMIT}; past that it has no title to offer. A read already running is not
 * doubled; the next turn's end picks up what it left.
 */
async function readTitle(host: Host, session: string, transcript: string): Promise<string | undefined> {
  const previous = titleReaders.get(session)
  if (previous?.reading) return previous.scanner.title
  const { size } = await host.fs.stat(transcript)
  let reader = previous
  if (!reader || reader.path !== transcript || size < reader.offset) {
    reader = {
      path: transcript, offset: Math.max(0, size - TITLE_WINDOW_BYTES), scanner: new TitleScanner(),
      ranged: previous?.ranged ?? true,
    }
    titleReaders.set(session, reader)
  }
  if (size === reader.offset) return reader.scanner.title
  reader.reading = true
  try {
    if (reader.ranged) {
      try {
        await readFrom(host, transcript, reader.offset, (text) => reader.scanner.push(text))
        reader.offset = size
        return reader.scanner.title
      } catch (error) {
        reader.ranged = false
        await host.ui.log(`Couldn't read the transcript from an offset (${String(error)}); reading it whole from now on.`, { to: 'debug' })
      }
    }
    if (size > FS_READ_LIMIT) throw new Error(`the transcript is ${size} bytes, more than it can be read whole`)
    const scanner = new TitleScanner()
    scanner.push(await host.fs.read(transcript))
    reader.scanner = scanner
    reader.offset = size
    return scanner.title
  } finally {
    reader.reading = undefined
  }
}

/** Stream a file from a byte offset to its end, without holding it whole. */
export async function readFrom(host: Host, path: string, offset: number, onText: (text: string) => void) {
  const stream = host.process.spawn(transcriptRead(path, offset, await host.env.os() === 'Windows_NT'))
  const deadline = new AbortController()
  let timedOut = false
  void host.clock.sleep(TITLE_TIMEOUT_MS, { signal: deadline.signal }).then(() => {
    timedOut = true
    void stream.return({ code: null, signal: 'SIGTERM' }).catch(() => {})
  // The deadline's sleep rejects when the read ends first and cancels it.
  }).catch(() => {})
  let stderr = ''
  try {
    while (true) {
      const piece = await stream.next()
      if (timedOut) throw new Error('reading the transcript timed out')
      if (piece.done) {
        if (piece.value.code !== 0) throw new Error(stderr.trim() || `the read exited ${piece.value.code ?? piece.value.signal}`)
        return
      }
      if (piece.value.stream === 'stderr') stderr = (stderr + piece.value.text).slice(-4000)
      else onText(piece.value.text)
    }
  } finally {
    deadline.abort()
    await stream.return({ code: null, signal: 'SIGTERM' })
  }
}
