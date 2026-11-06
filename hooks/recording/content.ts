import type { ApiMessage } from 'claude-code'
import { bashMarkdown } from './bash'
import { isJsonObject, type JsonObject, jsonText } from '../core/json'

type RecordValue = Record<string, unknown>
export type Update = RecordValue & { sessionUpdate: string }

/** Capture authored rows and tool results, not the engine's model-only framing. */
export function capturedMessage(message: {
  type: string
  role?: ApiMessage['role']
  isMeta?: true
  content: Readonly<ApiMessage['content']>
}, door: string): ApiMessage | undefined {
  if (door === 'command') {
    if (message.type !== 'user' || message.role !== 'user') return
    // Bash-mode rows enter through the command door but also belong to Claude's model context.
    const content = message.content.flatMap((block) => {
      if (block.type !== 'text' || typeof block.text !== 'string') return []
      const text = bashMarkdown(block.text)
      return text !== block.text ? [{ ...block, text }] : []
    })
    return content.length ? { role: 'user', content } : undefined
  }
  if (['attachment', 'hook-context', 'notice', 'compaction', 'note'].includes(door)) return
  if (message.type === 'assistant' && message.role === 'assistant')
    return { role: 'assistant', content: [...message.content] }
  if (message.type !== 'user' || message.role !== 'user') return
  if (door === 'tool-result' || door === 'tool-message') {
    const content = message.content.filter((block) => block.type === 'tool_result')
    return content.length ? { role: 'user', content } : undefined
  }
  if (message.isMeta || !['prompt', 'delivery'].includes(door)) return
  return { role: 'user', content: message.content.map((block) =>
    block.type === 'text' && typeof block.text === 'string'
      ? { ...block, text: bashMarkdown(block.text) } : block) }
}

function object(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}

function base64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  if (value.endsWith('==')) return (alphabet.indexOf(value.charAt(value.length - 3)) & 15) === 0
  if (value.endsWith('=')) return (alphabet.indexOf(value.charAt(value.length - 2)) & 3) === 0
  return true
}

function blocks(value: unknown): RecordValue[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (!Array.isArray(value)) return value == null ? [] : blocks([value])
  return value.map((item) => {
    const block = object(item)
    if (!block) return { type: 'text', text: jsonText(item) }
    if (!validOptionalFields(block)) return { type: 'text', text: jsonText(block) }
    if (block.type === 'text' && typeof block.text === 'string')
      return { type: 'text', text: block.text, ...contentFields(block) }
    if (block.type === 'image') {
      const source = object(block.source)
      if (source?.type === 'base64' && base64(source.data) && typeof source.media_type === 'string')
        return { type: 'image', data: source.data, mimeType: source.media_type, ...contentFields(block) }
      if (base64(block.data) && typeof block.mimeType === 'string')
        return { type: 'image', data: block.data, mimeType: block.mimeType, ...contentFields(block) }
      if (source?.type === 'url' && typeof source.url === 'string')
        return { type: 'resource_link', uri: source.url, name: source.url, ...contentFields(block) }
    }
    if (block.type === 'resource_link' && typeof block.uri === 'string')
      return {
        type: 'resource_link', uri: block.uri, name: jsonText(block.name ?? block.uri),
        ...optionalFields(block, ['title', 'description', 'icons', 'mimeType', 'size', 'annotations', '_meta']),
      }
    if (block.type === 'audio' && base64(block.data) && typeof block.mimeType === 'string')
      return { type: 'audio', data: block.data, mimeType: block.mimeType, ...contentFields(block) }
    if (block.type === 'resource') {
      const resource = object(block.resource)
      if (resource && validOptionalFields(resource) && typeof resource.uri === 'string' &&
          (typeof resource.text === 'string' || base64(resource.blob)))
        return {
          type: 'resource',
          resource: {
            uri: resource.uri,
            ...(typeof resource.text === 'string' ? { text: resource.text } : { blob: resource.blob }),
            ...optionalFields(resource, ['mimeType', '_meta']),
          },
          ...contentFields(block),
        }
    }
    if (block.type === 'document') {
      const source = object(block.source)
      const name = typeof block.title === 'string' ? block.title : 'document'
      if (source?.type === 'url' && typeof source.url === 'string')
        return { type: 'resource_link', uri: source.url, name, ...contentFields(block) }
      if (source && typeof source.media_type === 'string' &&
          ((source.type === 'base64' && base64(source.data)) ||
           (source.type === 'text' && typeof source.data === 'string')))
        return {
          type: 'resource',
          resource: {
            uri: `urn:claude-code:document:${encodeURIComponent(name)}`,
            mimeType: source.media_type,
            ...(source.type === 'base64' ? { blob: source.data } : { text: source.data }),
          },
          ...contentFields(block),
        }
    }
    // Unknown content remains visible and recoverable rather than silently disappearing.
    return { type: 'text', text: jsonText(block) }
  })
}

function optionalFields(value: RecordValue, fields: string[]): RecordValue {
  return Object.fromEntries(fields.filter((field) => value[field] !== undefined)
    .map((field) => [field, value[field]]))
}

function contentFields(value: RecordValue): RecordValue {
  return optionalFields(value, ['annotations', '_meta'])
}

/** Malformed optional data must remain opaque rather than poison an immutable outbox record. */
function validOptionalFields(value: RecordValue): boolean {
  for (const name of ['title', 'description', 'mimeType', 'lastModified']) {
    if (value[name] != null && typeof value[name] !== 'string') return false
  }
  if (value._meta != null && !object(value._meta)) return false
  if (value.size != null && (!Number.isSafeInteger(value.size) || (value.size as number) < 0)) return false
  if (value.icons != null) {
    if (!Array.isArray(value.icons) || !value.icons.every((item) => {
      const icon = object(item)
      return icon && Object.keys(icon).every((key) => ['src', 'mimeType', 'sizes', 'theme'].includes(key)) &&
        typeof icon.src === 'string' && (icon.mimeType == null || typeof icon.mimeType === 'string') &&
        (icon.sizes == null || (Array.isArray(icon.sizes) && icon.sizes.every((size) => typeof size === 'string'))) &&
        (icon.theme == null || icon.theme === 'light' || icon.theme === 'dark')
    })) return false
  }
  if (value.annotations != null) {
    const annotations = object(value.annotations)
    if (!annotations || !Object.keys(annotations).every((key) =>
      ['audience', 'priority', 'lastModified', '_meta'].includes(key))) return false
    if (!validOptionalFields({ _meta: annotations._meta, lastModified: annotations.lastModified })) return false
    if (annotations.audience != null && (!Array.isArray(annotations.audience) ||
        !annotations.audience.every((role) => role === 'user' || role === 'assistant'))) return false
    if (annotations.priority != null && (typeof annotations.priority !== 'number' ||
        !Number.isFinite(annotations.priority) || annotations.priority < 0 || annotations.priority > 1)) return false
  }
  return true
}

/** `path` relative to the directory `root`, or undefined when it lies outside it. */
function relativePath(path: string, root?: string): string | undefined {
  const base = root?.replace(/\/+$/, '')
  return base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : undefined
}

function editDiff(name: string, result?: RecordValue, root?: string): RecordValue[] {
  if ((name !== 'Edit' && name !== 'Write') || !result) return []
  const path = result.filePath
  if (typeof path !== 'string' || !path.startsWith('/') || /[\r\n]/.test(path)) return []
  const hunks = result?.structuredPatch
  const structured = Array.isArray(hunks) && hunks.length > 0 && hunks.every((hunk) => {
    const value = object(hunk)
    return value && Number.isInteger(value.oldStart) && (value.oldStart as number) >= 0 &&
      Number.isInteger(value.newStart) && (value.newStart as number) >= 0 &&
      Number.isInteger(value.oldLines) && (value.oldLines as number) >= 0 &&
      Number.isInteger(value.newLines) && (value.newLines as number) >= 0 &&
      Array.isArray(value.lines) && value.lines.every((line) => typeof line === 'string')
  })
  const operation = result?.type === 'create' ? 'add' : 'modify'
  // ACP names changed files by absolute path; the patch headers stay relative to the checkout.
  const change = { operation, path }
  const shown = relativePath(path, root) ?? path.slice(1)
  if (!structured) return [{ type: 'diff', changes: [change] }]
  const patch = (hunks as RecordValue[]).map((hunk) =>
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${(hunk.lines as string[]).join('\n')}`).join('\n')
  return [{
    type: 'diff',
    changes: [change],
    patch: {
      format: 'git_patch',
      text: `diff --git a/${shown} b/${shown}\n${operation === 'add' ? 'new file mode 100644\n' : ''}--- ${operation === 'add' ? '/dev/null' : `a/${shown}`}\n+++ b/${shown}\n${patch}\n`,
    },
  }]
}

/**
 * The ACP title and kind of a Claude Code tool call, as Claude's ACP adapter reports them, so a
 * recorded call reads as it does when Delta runs Claude itself. Ported from `toolInfoFromToolUse`
 * in @agentclientprotocol/claude-agent-acp (Apache-2.0), keeping only the title and kind: the
 * call's content comes from its result. Paths inside `root` are shown relative to it.
 */
export function toolInfo(name: string, input: unknown, root?: string): { title: string; kind: string } {
  const value = object(input) ?? {}
  const field = (key: string) => typeof value[key] === 'string' && value[key] ? value[key] as string : undefined
  const path = (key: string) => {
    const full = field(key)
    return full && (relativePath(full, root) ?? full)
  }
  const info = (title: string, kind: string) => ({ title: title.replace(/\s+/g, ' ').trim(), kind })
  switch (name) {
    case 'Agent':
    case 'Task':
      return info(field('description') ?? 'Task', 'think')
    case 'Bash':
      return info(field('command') ?? 'Terminal', 'execute')
    case 'Read': {
      const offset = typeof value.offset === 'number' && value.offset ? value.offset : undefined
      const limit = typeof value.limit === 'number' && value.limit > 0 ? value.limit : undefined
      const lines = limit ? ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})`
        : offset ? ` (from line ${offset})` : ''
      return info(`Read ${path('file_path') ?? 'File'}${lines}`, 'read')
    }
    case 'Write':
    case 'Edit': {
      const file = path('file_path')
      return info(file ? `${name} ${file}` : name, 'edit')
    }
    case 'Glob':
      return info(['Find', ...[path('path'), field('pattern')].flatMap((part) => part ? [`\`${part}\``] : [])].join(' '), 'search')
    case 'Grep': {
      const parts = ['grep']
      if (value['-i']) parts.push('-i')
      if (value['-n']) parts.push('-n')
      for (const context of ['-A', '-B', '-C'])
        if (value[context] !== undefined) parts.push(`${context} ${value[context]}`)
      if (value.output_mode === 'files_with_matches') parts.push('-l')
      else if (value.output_mode === 'count') parts.push('-c')
      if (value.head_limit !== undefined) parts.push(`| head -${value.head_limit}`)
      if (field('glob')) parts.push(`--include="${field('glob')}"`)
      if (field('type')) parts.push(`--type=${field('type')}`)
      if (value.multiline) parts.push('-P')
      if (field('pattern')) parts.push(`"${field('pattern')}"`)
      if (path('path')) parts.push(path('path')!)
      return info(parts.join(' '), 'search')
    }
    case 'WebFetch': {
      const url = field('url')
      return info(url ? `Fetch ${url}` : 'Fetch', 'fetch')
    }
    case 'WebSearch': {
      const domains = (key: string, label: string) => {
        const list = value[key]
        return Array.isArray(list) && list.length ? ` (${label}: ${list.join(', ')})` : ''
      }
      return info(`"${field('query') ?? ''}"${domains('allowed_domains', 'allowed')}${domains('blocked_domains', 'blocked')}`, 'fetch')
    }
    case 'TodoWrite':
      return info(Array.isArray(value.todos)
        ? `Update TODOs: ${value.todos.map((todo) => jsonText(object(todo)?.content ?? todo)).join(', ')}`
        : 'Update TODOs', 'think')
    default:
      return info(name || 'Unknown Tool', 'other')
  }
}

/** Delta has no plan mode, so Claude's plan approvals stay out of its transcript. */
const OMITTED_TOOLS = new Set(['ExitPlanMode'])

/**
 * Whether calls to the tool `name` are left out of Delta's transcript. With `plans`, TodoWrite is
 * too: its todos are recorded as the turn's plan instead (see `planUpdate`).
 */
export function isOmittedTool(name: unknown, plans = false): boolean {
  return typeof name === 'string' && (OMITTED_TOOLS.has(name) || (plans && name === 'TodoWrite'))
}

const TODO_STATUSES = ['pending', 'in_progress', 'completed']

/**
 * A TodoWrite call's todos as the turn's plan, as Claude's ACP adapter reports them (`planEntries`
 * in claude-agent-acp): an in-progress todo shows its `activeForm`, and every entry has medium
 * priority. Claude keeps one list per session, so each update replaces the plan `plan`. Undefined
 * for input without a todo list. A malformed todo is left out, since Delta rejects a record with an
 * entry it can't decode.
 */
export function planUpdate(input: unknown): Update | undefined {
  const todos = object(input)?.todos
  if (!Array.isArray(todos)) return
  const entries = todos.flatMap((todo) => {
    const value = object(todo)
    if (typeof value?.content !== 'string' || !TODO_STATUSES.includes(value.status as string)) return []
    const active = value.status === 'in_progress' && typeof value.activeForm === 'string' && value.activeForm
      ? value.activeForm : undefined
    return [{ content: active ?? value.content, priority: 'medium', status: value.status }]
  })
  return { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'plan', entries } }
}

/**
 * Convert normalized Messages API rows while retaining opaque provider thinking metadata.
 *
 * Paths in tool titles are shown relative to `root`, and results of the calls in `omitted` are
 * left out along with the omitted calls themselves. With `plans`, a TodoWrite call becomes a
 * `plan_update` rather than a tool call.
 */
export function messageUpdates(
  message: ApiMessage, id: string, structuredResults?: ReadonlyMap<string, Update>,
  { root, omitted, plans = false }: { root?: string; omitted?: ReadonlySet<string>; plans?: boolean } = {},
): Update[] {
  const updates: Update[] = []
  let content: RecordValue[] = []
  let firstIndex = 0
  const flush = () => {
    if (!content.length) return
    updates.push({
      sessionUpdate: message.role === 'user' ? 'user_message' : 'agent_message',
      messageId: `${id}:message:${firstIndex}`, content,
    })
    content = []
  }
  for (const [index, block] of message.content.entries()) {
    if (block.type === 'text' && typeof block.text === 'string' && !block.text.trim()) continue
    if (block.type === 'thinking' && typeof block.thinking === 'string' && !block.thinking.trim()) continue
    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      flush()
      updates.push({
        sessionUpdate: 'agent_thought',
        messageId: `${id}:thought:${index}`,
        content: blocks(block.type === 'thinking' ? block.thinking : '[redacted thinking]'),
        _meta: { claudeCode: { block } },
      })
    } else if (block.type === 'tool_use' && typeof block.id === 'string') {
      const plan = plans && block.name === 'TodoWrite' ? planUpdate(block.input) : undefined
      if (plan) {
        flush()
        updates.push(plan)
      }
      if (isOmittedTool(block.name, plans)) continue
      flush()
      const name = jsonText(block.name ?? 'Tool')
      updates.push({
        sessionUpdate: 'tool_call_update',
        toolCallId: block.id,
        name,
        ...toolInfo(name, block.input, root),
        // A call hook may have finished before this input-only row; its result row closes the call.
        status: 'in_progress',
        rawInput: block.input ?? {},
      })
    } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      if (omitted?.has(block.tool_use_id)) continue
      flush()
      const output = block.content ?? block
      const structured = structuredResults?.get(block.tool_use_id)
      updates.push({
        sessionUpdate: 'tool_call_update',
        toolCallId: block.tool_use_id,
        status: structured?.status ?? (block.is_error ? 'failed' : 'completed'),
        rawOutput: structured && 'rawOutput' in structured ? structured.rawOutput : output,
        content: [
          ...blocks(output).map((item) => ({ type: 'content', content: item })),
          ...(Array.isArray(structured?.content) ? structured.content : []),
        ],
      })
    } else {
      if (!content.length) firstIndex = index
      content.push(...blocks([block]))
    }
  }
  flush()
  return updates
}

export function resultDiff(name: string, result: unknown, root?: string): RecordValue[] {
  return editDiff(name, object(result), root)
}

/**
 * A tool's structured result as a `tool_call_update`. An edit's diff replaces its raw result,
 * which repeats the change and carries the entire original file.
 */
export function resultUpdate(toolCallId: string, name: string, result: unknown, isError: boolean, root?: string): Update {
  const diff = isError ? [] : resultDiff(name, result, root)
  return {
    sessionUpdate: 'tool_call_update', toolCallId,
    status: isError ? 'failed' : 'completed',
    rawOutput: diff.length ? null : result,
    ...(diff.length ? { content: diff } : {}),
  }
}
