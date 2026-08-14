import { EventSourceParserStream } from 'eventsource-parser/stream'
import {
  attributionHeaders,
  CallId,
  contentHasImage,
  LlmAdapter,
  LlmError,
  type ContentBlock,
  type FinishReason,
  type GenerateOptions,
  type Message,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'

const DEFAULT_MODEL = 'deepseek-v4-flash'
const DEFAULT_TIMEOUT_MS = 30_000
export const MAX_OUTPUT_TOKENS = 1024

interface ProviderOptions {
  fetch?: typeof fetch
  timeoutMs?: number
}

interface AdapterState {
  environment: NodeJS.ProcessEnv
  fetch: typeof fetch
  timeoutMs: number
}

const states = new WeakMap<DeepSeekChatAdapter, AdapterState>()

interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface WireToolCallDelta {
  index: number
  id?: string
  function?: { name?: string; arguments?: string }
}

interface WireChunk {
  choices?: Array<{
    delta?: { content?: string; reasoning_content?: string; tool_calls?: WireToolCallDelta[] }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
  }
}

interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId?: string
  name?: string
}

function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('')
}

function serializeAssistant(message: Message): Record<string, unknown> {
  const toolCalls: WireToolCall[] = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } }))
  const reasoning = message.content.filter(block => block.type === 'reasoning').map(block => block.text).join('')
  return {
    role: 'assistant',
    content: flattenText(message.content),
    ...(toolCalls.length > 0 && reasoning ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
}

function serializeMessages(messages: readonly Message[]): Record<string, unknown>[] {
  const wire: Record<string, unknown>[] = []
  for (const message of messages) {
    if (contentHasImage(message.content)) throw new LlmError('DeepSeek chat completions do not support image content', 'UNSUPPORTED_CONTENT')
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    const results = message.content.filter(block => block.type === 'tool-result')
    const text = flattenText(message.content)
    if (text || results.length === 0) wire.push({ role: 'user', content: text })
    for (const result of results) {
      wire.push({ role: 'tool', tool_call_id: result.toolCallId, content: flattenText(result.content) || '(no output)' })
    }
  }
  return wire
}

function requestBody(options: GenerateOptions, model: string, maxTokens: number): Record<string, unknown> {
  const tools = options.tools?.map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
  return {
    model,
    messages: [
      ...(options.system === undefined ? [] : [{ role: 'system', content: options.system }]),
      ...serializeMessages(options.messages),
    ],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxTokens,
    ...(tools?.length ? { tools } : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
  }
}

export function normalizeCompletionEndpoint(input: string): string {
  const url = new URL(input)
  const path = url.pathname.replace(/\/+$/, '')
  if (path.endsWith('/chat/completions')) url.pathname = path
  else if (path.endsWith('/v1')) url.pathname = `${path}/chat/completions`
  else url.pathname = `${path}/v1/chat/completions`.replace(/^\/\//, '/')
  return url.toString()
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const fail = (): void => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    if (signal.aborted) {
      fail()
      return
    }
    signal.addEventListener('abort', fail, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', fail)).catch(() => undefined)
  })
}

async function* parseSse(stream: ReadableStream<BufferSource>, signal: AbortSignal): AsyncGenerator<string> {
  const events = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream())
  const reader = events.getReader()
  try {
    while (true) {
      const result = await raceAbort(reader.read(), signal)
      if (result.done) break
      yield result.value.data
      if (result.value.data === '[DONE]') return
    }
  } finally {
    try {
      await reader.cancel()
    } catch (_cleanupFailure) {
      // The stream outcome is already known; cleanup must not replace it.
    } finally {
      reader.releaseLock()
    }
  }
  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
}

function finishReason(reason: string): FinishReason {
  if (reason === 'stop') return { kind: 'stop' }
  if (reason === 'tool_calls') return { kind: 'tool-calls' }
  if (reason === 'length') return { kind: 'max-tokens' }
  return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } }
}

function closeBlock(block: OpenBlock): ContentBlock {
  if (block.kind === 'text') return { type: 'text', text: block.text }
  if (block.kind === 'reasoning') return { type: 'reasoning', text: block.text }
  return { type: 'tool-call', id: CallId(block.callId ?? ''), name: block.name ?? '', arguments: block.text }
}

async function* translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  const order: OpenBlock[] = []
  const calls = new Map<number, OpenBlock>()
  let text: OpenBlock | undefined
  let reasoning: OpenBlock | undefined
  let pendingFinish: FinishReason | undefined
  let usage: TokenUsage | undefined
  const open = (kind: OpenBlock['kind']): OpenBlock => {
    const block: OpenBlock = { index: order.length, kind, text: '' }
    order.push(block)
    return block
  }
  for await (const payload of payloads) {
    if (payload === '[DONE]') {
      for (const block of order) yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      if (usage) yield { type: 'usage', usage }
      yield { type: 'finish', reason: pendingFinish ?? (order.length ? { kind: 'stop' } : { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: 'model returned no content' } }) }
      return
    }
    let chunk: WireChunk
    try {
      chunk = JSON.parse(payload) as WireChunk
    } catch {
      throw new LlmError('provider returned malformed SSE JSON', 'MALFORMED_RESPONSE')
    }
    for (const choice of chunk.choices ?? []) {
      const reasoningDelta = choice.delta?.reasoning_content
      if (reasoningDelta) {
        reasoning ??= open('reasoning')
        if (reasoning.text === '') yield { type: 'block-start', index: reasoning.index, blockType: 'reasoning' }
        reasoning.text += reasoningDelta
        yield { type: 'reasoning-delta', index: reasoning.index, text: reasoningDelta }
      }
      const textDelta = choice.delta?.content
      if (textDelta) {
        text ??= open('text')
        if (text.text === '') yield { type: 'block-start', index: text.index, blockType: 'text' }
        text.text += textDelta
        yield { type: 'text-delta', index: text.index, text: textDelta }
      }
      for (const delta of choice.delta?.tool_calls ?? []) {
        let block = calls.get(delta.index)
        if (!block) {
          block = open('tool-call')
          calls.set(delta.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        if (delta.id !== undefined) block.callId = delta.id
        if (delta.function?.name !== undefined) block.name = delta.function.name
        const fragment = delta.function?.arguments ?? ''
        block.text += fragment
        yield { type: 'tool-call-delta', index: block.index, id: CallId(block.callId ?? ''), ...(block.name === undefined ? {} : { name: block.name }), argumentsDelta: fragment }
      }
      if (choice.finish_reason) pendingFinish = finishReason(choice.finish_reason)
    }
    if (chunk.usage) {
      const cacheRead = chunk.usage.prompt_tokens_details?.cached_tokens ?? chunk.usage.prompt_cache_hit_tokens
      usage = {
        inputTokens: (chunk.usage.prompt_tokens ?? 0) - (cacheRead ?? 0),
        outputTokens: chunk.usage.completion_tokens ?? 0,
        ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
        ...(chunk.usage.completion_tokens_details?.reasoning_tokens === undefined
          ? {}
          : { reasoningTokens: chunk.usage.completion_tokens_details.reasoning_tokens }),
      }
    }
  }
  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
}

export class DeepSeekChatAdapter extends LlmAdapter {
  constructor(environment: NodeJS.ProcessEnv = process.env, options: ProviderOptions = {}) {
    super()
    states.set(this, { environment, fetch: options.fetch ?? fetch, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS })
  }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string; defaultMaxTokens: number }> {
    return Promise.resolve({ provider, id: model, name: model, defaultMaxTokens: MAX_OUTPUT_TOKENS })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const state = states.get(this)
    if (!state) throw new LlmError('provider adapter is not initialized', 'INVALID_STATE')
    const apiKey = state.environment.DEEPSEEK_API_KEY?.trim()
    if (!apiKey) throw new LlmError('DeepSeek credentials are not configured', 'MISSING_CREDENTIAL')
    const baseUrl = state.environment.DEEPSEEK_BASE_URL?.trim()
    if (!baseUrl) throw new LlmError('DeepSeek endpoint is not configured', 'MISSING_ENDPOINT')
    const model = state.environment.DEEPSEEK_MODEL?.trim() || options.model || DEFAULT_MODEL
    const maxTokens = Math.min(options.maxTokens ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS)
    const timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController.abort('timeout'), state.timeoutMs)
    const signal = options.signal === undefined
      ? timeoutController.signal
      : AbortSignal.any([options.signal, timeoutController.signal])
    let response: Response | undefined
    try {
      response = await raceAbort(state.fetch(normalizeCompletionEndpoint(baseUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream', ...attributionHeaders() },
        body: JSON.stringify(requestBody(options, model, maxTokens)),
        signal,
      }), signal)
      if (!response.ok || response.body === null) throw new LlmError(`DeepSeek endpoint returned HTTP ${response.status}`, 'HTTP', { status: response.status })
      yield* translate(parseSse(response.body as ReadableStream<BufferSource>, signal))
    } catch (error) {
      if (error instanceof LlmError) throw error
      if (options.signal?.aborted) throw new LlmError('DeepSeek request aborted by caller', 'ABORTED', { cause: error })
      if (timeoutController.signal.aborted) throw new LlmError(`DeepSeek request timed out after ${state.timeoutMs}ms`, 'TIMEOUT', { cause: error })
      throw new LlmError('unable to reach the DeepSeek endpoint', 'TRANSPORT', { cause: error })
    } finally {
      clearTimeout(timer)
      try {
        await response?.body?.cancel()
      } catch (_cleanupFailure) {
        // The primary provider result/error remains authoritative.
      }
    }
  }
}

export function createDeepSeekAdapter(environment?: NodeJS.ProcessEnv): LlmAdapter {
  return new DeepSeekChatAdapter(environment)
}

export const DEFAULT_DEEPSEEK_MODEL = DEFAULT_MODEL
