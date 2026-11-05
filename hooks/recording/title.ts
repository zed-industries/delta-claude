import { conversationText } from '../watch/conversation'
import { drain, stageRecord } from './delivery'
import { isJsonObject } from '../core/json'
import { load, report, requests, save, serial, stateFor } from '../core/session-state'
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

/** A read of what a transcript gained gives up after this long; the next read takes it up again. */
const TITLE_TIMEOUT_MS = 10_000
/**
 * How much of a transcript's end the first read takes in. Claude appends the current title when it is
 * chosen or renamed and again at each prompt, so the end of the file usually holds it. A turn can add
 * megabytes after its prompt, so a window without a title is widened {@link TITLE_WINDOW_GROWTH}-fold,
 * up to the whole file.
 */
export const TITLE_WINDOW_BYTES = 256 * 1024
const TITLE_WINDOW_GROWTH = 8
/** `$.fs.read` refuses a larger file, so reading a transcript whole is possible only below this. */
export const FS_READ_LIMIT = 4 * 1024 * 1024
/**
 * Where a session's transcript was last read to, once a read has finished, and the title found so far.
 * `ranged` is cleared once reading from an offset fails, so the session reads its transcript whole
 * from then on.
 */
type TitleReader = { path: string; offset?: number; scanner: TitleScanner; ranged: boolean }
const titleReaders = new Map<string, TitleReader>()
/** Each session's latest read, which the next one waits for: two reads would feed one scanner at once. */
const titleReads = new Map<string, Promise<string | undefined>>()

/** An ended session's transcript is not read again here. */
export function forgetTitleReader(session: string) {
  titleReaders.delete(session)
  titleReads.delete(session)
}

/** Whether a session's thread is recorded by it and has no title from it yet. */
export function awaitsTitle(session: string): boolean {
  const binding = stateFor(session).binding
  return !!binding?.snapshot && !binding.joined && binding.title === undefined
}

/**
 * Record the session's title for its thread when it changed since the last one recorded. Only a
 * shared session names its thread; a joined session takes part in someone else's. An automatic
 * session stages its title before its thread exists, like its other records, so a turn that ends
 * during activation still names the thread. Nothing here can fail a turn or sharing: a title that
 * cannot be read or staged is skipped, and the next read tries again.
 */
export async function recordTitle(host: Host, session: string, transcript: string) {
  const binding = stateFor(session).binding
  if (!binding?.snapshot || binding.joined) return
  try {
    const title = await readTitle(host, session, transcript)
    if (title === undefined || title === stateFor(session).binding?.title) return
    const staged = await serial(async () => {
      const current = await load(host, session)
      if (!current.snapshot || current.joined || current.title === title) return false
      await save(host, { ...await stageRecord(host, current, { update: { sessionUpdate: 'session_info_update', title } }), title })
      return true
    })
    // Once staged, the title is delivered and reported like every other record. A share in flight
    // delivers it itself once the thread is published; delivering earlier would fail and pause sharing.
    if (staged && requests.share?.session !== session) void drain(host, session).catch((error) => report(host, error))
  } catch (error) {
    await host.ui.log(`Couldn't record this session's title: ${String(error)}`, { to: 'debug' })
  }
}

/**
 * The session's title, from what its transcript gained since the last read. The first read takes in
 * the file's last {@link TITLE_WINDOW_BYTES}, widening the window until it holds a title or the whole
 * file; each later one takes only the bytes added since. A transcript that shrank was rewritten, as
 * compaction does, and is read like a new one. A read waits for the session's previous one, so a
 * rename made while another read runs is never missed.
 */
function readTitle(host: Host, session: string, transcript: string): Promise<string | undefined> {
  const read = (titleReads.get(session) ?? Promise.resolve(undefined))
    // The previous read reported its own failure to its caller.
    .catch(() => undefined)
    .then(() => readTitleNow(host, session, transcript))
  titleReads.set(session, read)
  return read
}

async function readTitleNow(host: Host, session: string, transcript: string): Promise<string | undefined> {
  const { size } = await host.fs.stat(transcript)
  const previous = titleReaders.get(session)
  if (previous?.path === transcript && previous.offset !== undefined && size >= previous.offset) {
    if (size > previous.offset) await scanTranscript(host, previous, previous.offset, size)
    return previous.scanner.title
  }
  const reader: TitleReader = { path: transcript, scanner: new TitleScanner(), ranged: previous?.ranged ?? true }
  titleReaders.set(session, reader)
  for (let window = TITLE_WINDOW_BYTES; ; window *= TITLE_WINDOW_GROWTH) {
    const start = Math.max(0, size - window)
    reader.scanner = new TitleScanner()
    await scanTranscript(host, reader, start, size)
    // Once reading from an offset failed, the transcript was read whole: there is no wider window.
    if (reader.scanner.title !== undefined || start === 0 || !reader.ranged) return reader.scanner.title
  }
}

/**
 * Feed `reader` the transcript from byte `start`, which the file's `size` now ends. Reading from an
 * offset needs `tail`, or PowerShell allowed to call .NET on Windows, and either may be missing or
 * refused, as under Constrained Language Mode. Once it fails, the session reads its transcript whole
 * with `$.fs.read`, which works wherever the plugin does, up to {@link FS_READ_LIMIT}; past that it
 * has no title to offer.
 */
async function scanTranscript(host: Host, reader: TitleReader, start: number, size: number) {
  if (reader.ranged) {
    try {
      await readFrom(host, reader.path, start, (text) => reader.scanner.push(text))
      reader.offset = size
      return
    } catch (error) {
      reader.ranged = false
      await host.ui.log(`Couldn't read the transcript from an offset (${String(error)}); reading it whole from now on.`, { to: 'debug' })
    }
  }
  if (size > FS_READ_LIMIT) throw new Error(`the transcript is ${size} bytes, more than it can be read whole`)
  const scanner = new TitleScanner()
  scanner.push(await host.fs.read(reader.path))
  reader.scanner = scanner
  reader.offset = size
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
