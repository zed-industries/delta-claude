import { parseAppendReceipt } from './thread-commands'

/** Split a durable JSONL record without cutting a UTF-16 surrogate pair. */
export function outboxChunks(line: string, sequence: number): string[] {
  if (new TextEncoder().encode(line).length > 16 * 1024 * 1024)
    throw new Error(`record ${sequence} exceeds Delta's 16 MiB JSONL limit; sharing paused`)
  const chunks: string[] = []
  let offset = 0
  while (offset < line.length) {
    let end = Math.min(offset + 900_000, line.length)
    if (end < line.length && /[\uD800-\uDBFF]/.test(line.charAt(end - 1))) end--
    chunks.push(line.slice(offset, end))
    offset = end
  }
  return chunks
}

/**
 * Match only the acknowledged prefix, including each record's original turn association.
 * A `fenced` receipt names the turn it was refused for, so a caller can stop that turn's local
 * execution without waiting for a watch event.
 */
export function acknowledgedPrefix(
  stdout: string, thread: string,
  records: readonly { sequence: number; turnSequence?: number }[],
): { count: number; fenced: number[] } {
  let count = 0
  const fenced: number[] = []
  for (const answer of stdout.trim().split('\n')) {
    const expected = records[count]
    if (!expected) break
    try {
      const receipt = parseAppendReceipt(answer, thread, expected.sequence)
      if (receipt.turn_sequence !== (expected.turnSequence ?? null)) break
      if (receipt.disposition === 'fenced' && receipt.turn_sequence !== null) fenced.push(receipt.turn_sequence)
    } catch { break }
    count++
  }
  return { count, fenced }
}

/** Add a complete record unless it would overflow a nonempty append batch. */
export function appendBatch(
  batch: { input: string; bytes: number; count: number }, line: string,
): { input: string; bytes: number; count: number } | undefined {
  const bytes = new TextEncoder().encode(line).length
  if (batch.count && batch.bytes + bytes > 2_000_000) return
  return { input: batch.input + line, bytes: batch.bytes + bytes, count: batch.count + 1 }
}

/**
 * Check a pending outbox record before sending it, and read the turn it belongs to. Only a turn's
 * own start, a running state update, may name its own sequence.
 */
export function pendingRecordTurn(line: string, sequence: number): number | undefined {
  const record = JSON.parse(line)
  const invalid = () => new Error(`invalid pending record ${sequence}; sharing paused without changing its record`)
  // Every saved envelope was written with JSON.stringify plus a newline; requiring that
  // representation also rejects duplicate keys.
  if (!record || line !== JSON.stringify(record) + '\n' ||
      record.schemaVersion !== 1 || record.sequence !== sequence ||
      !Number.isSafeInteger(sequence) || sequence < 1) throw invalid()
  const keys = Object.keys(record).sort().join()
  if (!['schemaVersion,sequence,update', 'schemaVersion,sequence,turnSequence,update'].includes(keys) ||
      !record.update || Array.isArray(record.update) || typeof record.update.sessionUpdate !== 'string') throw invalid()
  const turnSequence = record.turnSequence
  if (turnSequence !== undefined &&
      (!Number.isSafeInteger(turnSequence) || turnSequence < 1 ||
        (turnSequence >= sequence && !(turnSequence === sequence &&
          record.update.sessionUpdate === 'state_update' && record.update.state === 'running')))) throw invalid()
  return turnSequence
}

/** The durable pending prefix is the authority for which record files can be removed. */
export function acknowledgedOutboxFiles(
  directory: string,
  next: number,
  pending: readonly { sequence: number; files: readonly string[] }[],
  entries: readonly { name: string; kind: string; isLink: boolean }[],
): string[] {
  if (!Number.isSafeInteger(next) || next < 1) throw new Error('Invalid outbox sequence frontier')
  let frontier = next
  const protectedFiles = new Set<string>()
  for (const entry of pending) {
    if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 1 || entry.sequence >= next)
      throw new Error('Invalid pending outbox sequence')
    frontier = Math.min(frontier, entry.sequence)
    for (const file of entry.files) protectedFiles.add(file)
  }
  return entries.flatMap((entry) => {
    const match = /^([1-9][0-9]*)-(0|[1-9][0-9]*)\.json$/.exec(entry.name)
    if (!match || entry.kind !== 'file' || entry.isLink) return []
    const sequence = Number(match[1])
    const path = `${directory}/${entry.name}`
    return Number.isSafeInteger(sequence) && sequence < frontier && !protectedFiles.has(path) ? [path] : []
  })
}

/** Delete only explicit files; neither platform follows a shell-expanded path or recurses. */
export function outboxRemoval(files: readonly string[], windows: boolean): { argv: string[]; stdin?: string } {
  if (!files.length) throw new Error('No acknowledged files selected')
  if (!windows) return { argv: ['rm', '-f', '--', ...files] }
  return {
    argv: ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '[Console]::InputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference = "Stop"; ' +
      '$paths = ConvertFrom-Json ([Console]::In.ReadToEnd()); foreach ($path in $paths) { [IO.File]::Delete($path) }'],
    stdin: JSON.stringify(files),
  }
}
