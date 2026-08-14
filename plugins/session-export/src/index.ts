import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export type ExportFormat = 'json' | 'markdown'

export interface SessionEventLike {
  type: string
  seq?: number
  time?: number
  data?: unknown
}

export interface Config {
  events?: SessionEventLike[]
}

export const name = 'lite-session-export'
export const inject = ['tools']
export const Config = z.object({})

type ProjectedEvent = {
  type: 'user' | 'assistant' | 'tool' | 'turn'
  text?: string
  name?: string
  content?: string
  isError?: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' ? value : undefined
}

function textBlocks(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.flatMap((block) => {
    const item = record(block)
    return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []
  }).join('\n')
}

function projectEvent(event: SessionEventLike, toolNames: ReadonlyMap<string, string>): ProjectedEvent | undefined {
  const data = record(event.data)
  if (data === undefined) return undefined
  if (event.type === 'user/message') {
    const text = textBlocks(data.content)
    return text === '' ? undefined : { type: 'user', text }
  }
  if (event.type === 'assistant/message') {
    const message = record(data.message)
    const text = textBlocks(message?.content)
    return text === '' ? undefined : { type: 'assistant', text }
  }
  if (event.type === 'tool/result') {
    const message = record(data.message)
    const block = Array.isArray(message?.content) ? record(message.content[0]) : undefined
    if (block?.type !== 'tool-result') return undefined
    const content = textBlocks(block.content)
    const callId = stringField(block, 'toolCallId') ?? 'result'
    const isError = typeof block.isError === 'boolean' ? block.isError : undefined
    return { type: 'tool', name: toolNames.get(callId) ?? callId, content, ...(isError === undefined ? {} : { isError }) }
  }
  if (event.type === 'turn/end') {
    const text = stringField(data, 'text')
    return { type: 'turn', ...(text === undefined ? {} : { text }) }
  }
  return undefined
}

function markdown(events: readonly ProjectedEvent[]): string {
  return events.map((event) => {
    if (event.type === 'user') return `## User\n\n${event.text ?? ''}`
    if (event.type === 'assistant') return `## Assistant\n\n${event.text ?? ''}`
    if (event.type === 'tool') return `## Tool: ${event.name ?? ''}\n\n${event.content ?? ''}${event.isError ? '\n\nError: true' : ''}`
    return `## Turn\n\n${event.text ?? ''}`
  }).join('\n\n')
}

export function projectSession(events: readonly SessionEventLike[], format: ExportFormat): string {
  const toolNames = new Map<string, string>()
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const data = record(event.data)
    const callId = data === undefined ? undefined : stringField(data, 'callId')
    const toolName = data === undefined ? undefined : stringField(data, 'name')
    if (callId !== undefined && toolName !== undefined) toolNames.set(callId, toolName)
  }
  const projected = events.map((event) => projectEvent(event, toolNames))
    .filter((event): event is ProjectedEvent => event !== undefined)
  return format === 'json' ? JSON.stringify(projected, null, 2) : markdown(projected)
}

export function createSessionExportTool(events: () => readonly SessionEventLike[]) {
  return defineTool({
    name: 'lite_session_export',
    description: 'Export supported session events as sanitized JSON or Markdown.',
    parameters: { format: { type: 'string', required: true, enum: ['json', 'markdown'] } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) { return projectSession(exec.agent?.session.events ?? events(), args.format) },
    isConcurrencySafe: () => true,
  })
}

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(createSessionExportTool(() => config.events ?? []))
}

const plugin = { name, inject, Config, apply }
export default plugin
