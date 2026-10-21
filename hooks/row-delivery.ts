import { isThoughtItem } from './conversation'
import type { WatchItem } from './thread-commands'

type DrawResult = { deny?: string }
type DrawTimer = { cancel(): void }
export type PendingDraw = { session: string; id: string; settle(result: DrawResult): void }

/** Thinking is announced once on live completion and never becomes a model row. */
export function announceThought(before: WatchItem | undefined, item: WatchItem, snapshotDone: boolean): boolean {
  return isThoughtItem(item) && !item.open && snapshotDone && (!before || before.open)
}

/** A successful person-visible draw is remembered even if its model row must retry. */
export class DrawnRows {
  private items = new Set<string>()

  drawOnce(id: string, draw: () => Promise<DrawResult>): Promise<DrawResult> | undefined {
    if (this.items.has(id)) return
    return draw().then((result) => {
      if (result.deny === undefined) this.items.add(id)
      return result
    })
  }
}

/**
 * Queue rows until a hook can draw them, retaining order across held turns. A row is drawn once
 * the transcript stored the output row naming its item, which `confirm` reports; until then, and
 * past the wait, it is not.
 */
export class DrawQueue {
  private pending: PendingDraw[] = []
  private unsettled = new Set<PendingDraw>()
  get length() { return this.pending.length }
  shift() { return this.pending.shift() }

  /** The transcript stored the output row that draws `id`. */
  confirm(id: string) {
    for (const entry of this.unsettled) if (entry.id === id) entry.settle({})
  }

  wait(session: string, id: string, held: () => boolean,
    after: (milliseconds: number, action: () => void) => DrawTimer): Promise<DrawResult> {
    return new Promise((resolve) => {
      let added = false
      let timer: DrawTimer | undefined
      const entry: PendingDraw = { session, id, settle: (result) => {
        if (added) return
        added = true
        this.unsettled.delete(entry)
        timer?.cancel()
        resolve(result)
      } }
      this.unsettled.add(entry)
      const arm = () => {
        timer = after(2000, () => {
          if (held()) arm()
          else {
            this.pending = this.pending.filter((queued) => queued !== entry)
            entry.settle({ deny: 'the transcript drew no command output row' })
          }
        })
      }
      arm()
      this.pending.push(entry)
    })
  }

  drop() {
    const queued = this.pending
    this.pending = []
    for (const entry of queued) entry.settle({ deny: 'the Delta watcher stopped before the row was drawn' })
  }
}

/** The engine's words for a stored row left with no content, as the plugin's emptied echo is. */
export const EMPTY_ROW_TEXT = '(no content)'

/** What the stored output row of the plugin's own `show` run reads, for the model and a resumed session. */
export const SHOW_ANSWER = '.'
const SHOW_OUTPUT_ROW = `<local-command-stdout>${SHOW_ANSWER}</local-command-stdout>`

/**
 * The plugin's answer to its own `show <id>` run. The answer becomes the run's output row, which
 * is the one place a run's own data is documented to reach, so it names the item; the rewrite
 * below reads the item out and stores the row as {@link SHOW_ANSWER} alone.
 */
export function showAnswer(id: string): string {
  return `${SHOW_ANSWER} ${id}`
}

/** Identify the item in an internal command without interpreting its content. */
export function shownItemId(args: string): string | undefined {
  return /^show\s+(\S+)$/.exec(args.trim())?.[1]
}

/**
 * Rewrite only this plugin's hidden command echo and output, not unrelated command rows: the echo
 * is stored empty and marked `echo`, and the output as {@link SHOW_ANSWER}, with the item it draws
 * returned beside it. The plugin runs its own `/delta` only to draw, so an echo of that run is
 * hidden whatever arguments the transcript kept for it.
 */
export function shownCommandRewrite(plugin: string, row: {
  door: string
  origin?: unknown
  message: { type: string; name?: string; role?: string; content: readonly { type: string; text?: string }[] }
}): { content: { type: 'text'; text: string }[]; item?: string; echo?: true } | undefined {
  if (row.door !== 'command') return
  const text = row.message.content.flatMap((block) =>
    block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n')
  const origin = row.origin as { kind?: string; name?: string } | undefined
  if (row.message.role === 'user' && origin?.kind === 'plugin' && origin.name === plugin &&
      /<command-name>\/delta<\/command-name>/.test(text) && /<command-args>(?:show\s+\S+)?<\/command-args>/.test(text))
    return { content: [], echo: true }
  if (row.message.type !== 'system' || row.message.name !== 'local_command') return
  const output = /^<local-command-stdout>(?:(\S+): )?(.*)<\/local-command-stdout>$/s.exec(text)
  if (!output || (output[1] !== undefined && output[1] !== plugin)) return
  const answer = output[2]!
  if (answer === SHOW_ANSWER) return { content: [{ type: 'text', text: SHOW_OUTPUT_ROW }] }
  // The engine names the plugin that answered, so only this plugin's answer names an item.
  const item = output[1] === plugin ? new RegExp(`^\\${SHOW_ANSWER} (\\S+)$`).exec(answer)?.[1] : undefined
  if (item !== undefined) return { content: [{ type: 'text', text: SHOW_OUTPUT_ROW }], item }
}
