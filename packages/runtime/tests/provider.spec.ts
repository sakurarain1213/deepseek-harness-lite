import { inspect } from 'node:util'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeepSeekChatAdapter, normalizeCompletionEndpoint } from '../src/provider.js'

const baseOptions = (overrides: Partial<GenerateOptions> = {}): GenerateOptions => ({
  provider: 'deepseek-lite',
  model: 'deepseek-v4-flash',
  messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'ping' }] })],
  ...overrides,
})

async function collect(adapter: DeepSeekChatAdapter, options: GenerateOptions = baseOptions()): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

function sseResponse(records: string[], splitAt?: number): Response {
  const bytes = new TextEncoder().encode(records.join(''))
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (splitAt === undefined) controller.enqueue(bytes)
      else {
        controller.enqueue(bytes.slice(0, splitAt))
        controller.enqueue(bytes.slice(splitAt))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function adapter(fetchImpl: typeof fetch, timeoutMs = 1000): DeepSeekChatAdapter {
  return new DeepSeekChatAdapter({
    DEEPSEEK_BASE_URL: 'https://example.test/v1',
    DEEPSEEK_API_KEY: 'SENTINEL_SECRET',
  }, { fetch: fetchImpl, timeoutMs })
}

afterEach(() => vi.useRealTimers())

describe('DeepSeek chat adapter wire contract', () => {
  it('serializes official messages, tool results, and tool schemas without dropping content', async () => {
    let request: RequestInit | undefined
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      request = init
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n',
        'data: [DONE]\n\n',
      ])
    }) as unknown as typeof fetch
    const callId = CallId('call-1')
    await collect(adapter(fetchImpl), baseOptions({
      system: 'system prompt',
      messages: [
        createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'use echo' }] }),
        createAssistantMessage({ content: [
          { type: 'reasoning', text: 'because' },
          { type: 'tool-call', id: callId, name: 'echo', arguments: '{"text":"hi"}' },
        ], source: { provider: 'deepseek-lite', model: 'deepseek-v4-flash' } }),
        createToolResultMessage({ callId, content: [{ type: 'text', text: 'hi' }], isError: false }),
      ],
      tools: [{ name: 'echo', description: 'Echo text', parameters: { type: 'object', properties: { text: { type: 'string' } } } }],
    }))

    const body = JSON.parse(String(request?.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'use echo' },
        { role: 'assistant', content: '', reasoning_content: 'because', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'echo', arguments: '{"text":"hi"}' } }] },
        { role: 'tool', tool_call_id: 'call-1', content: 'hi' },
      ],
      tools: [{ type: 'function', function: { name: 'echo', description: 'Echo text' } }],
    })
  })

  it('translates streamed tool calls into official chunks and tool-calls finish', async () => {
    const chunks = await collect(adapter(async () => sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"echo","arguments":"{\\"text\\""}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"hi\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]) as unknown as Promise<Response>))

    expect(chunks).toContainEqual({ type: 'tool-call-delta', index: 0, id: CallId('c1'), name: 'echo', argumentsDelta: '{"text"' })
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('c1'), name: 'echo', arguments: '{"text":"hi"}' } })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it.each([
    ['https://host.test', 'https://host.test/v1/chat/completions'],
    ['https://host.test/', 'https://host.test/v1/chat/completions'],
    ['https://host.test/v1', 'https://host.test/v1/chat/completions'],
    ['https://host.test/v1/', 'https://host.test/v1/chat/completions'],
    ['https://host.test/v1/chat/completions', 'https://host.test/v1/chat/completions'],
  ])('normalizes endpoint %s', (input, expected) => {
    expect(normalizeCompletionEndpoint(input)).toBe(expected)
  })

  it('keeps the credential source non-enumerable and non-serializable', () => {
    const instance = adapter(vi.fn() as unknown as typeof fetch)
    const rendered = `${JSON.stringify(instance)}\n${String(instance)}\n${inspect(instance)}\n${JSON.stringify(Object.getOwnPropertyDescriptors(instance))}`
    expect(Object.keys(instance)).not.toContain('environment')
    expect(rendered).not.toContain('SENTINEL_SECRET')
  })

  it('sends official attribution without serializing the credential', async () => {
    let request: RequestInit | undefined
    await collect(adapter(async (_url, init) => {
      request = init
      return sseResponse(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n'])
    }))
    expect(new Headers(request?.headers).get('user-agent')).toContain('deepseek-harness/')
    expect(String(request?.body)).not.toContain('SENTINEL_SECRET')
  })

  it('cancels the transformed response body after DONE', async () => {
    let cancelled = false
    const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes) },
      cancel() { cancelled = true },
    })
    await collect(adapter(async () => new Response(body, { status: 200 })))
    expect(cancelled).toBe(true)
  })

  it('handles CRLF, multiline data, comments, and split UTF-8', async () => {
    const source = ': keepalive\r\ndata: {"choices":[{"delta":{"content":"你"},\r\ndata: "finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n'
    const utf8 = new TextEncoder().encode(source)
    const splitAt = utf8.findIndex((byte, index) => byte >= 0x80 && utf8[index - 1] < 0x80) + 1
    const chunks = await collect(adapter(async () => sseResponse([source], splitAt)))
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: '你' })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it.each([
    ['malformed JSON', 'data: {bad}\n\ndata: [DONE]\n\n', 'MALFORMED_RESPONSE'],
    ['missing DONE', 'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"stop"}]}\n\n', 'STREAM_CLOSED'],
    ['unterminated tail', 'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"stop"}]}', 'STREAM_CLOSED'],
  ])('rejects %s instead of reporting success', async (_label, body, code) => {
    await expect(collect(adapter(async () => sseResponse([body])))).rejects.toMatchObject({ code })
  })

  it('times out while waiting for response headers', async () => {
    vi.useFakeTimers()
    let aborted = false
    const result = collect(adapter(async (_url, init) => {
      init?.signal?.addEventListener('abort', () => { aborted = true }, { once: true })
      return new Promise<Response>(() => undefined)
    }, 25))
    const rejection = expect(result).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(30)
    await rejection
    expect(aborted).toBe(true)
  })

  it('times out while the response body is stalled', async () => {
    vi.useFakeTimers()
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ start() {}, cancel() { cancelled = true } })
    const result = collect(adapter(async () => new Response(body, { status: 200 }), 25))
    const rejection = expect(result).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(30)
    await rejection
    expect(cancelled).toBe(true)
  })

  it('maps cache and reasoning usage into disjoint official token counts', async () => {
    const chunks = await collect(adapter(async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":30,"prompt_cache_hit_tokens":60,"completion_tokens_details":{"reasoning_tokens":20}}}\n\n',
      'data: [DONE]\n\n',
    ])))
    expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 40, outputTokens: 30, cacheReadTokens: 60, reasoningTokens: 20 } })
  })

  it('prefers OpenAI-compatible cached token details when present', async () => {
    const chunks = await collect(adapter(async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":50,"completion_tokens":5,"prompt_cache_hit_tokens":40,"prompt_tokens_details":{"cached_tokens":12}}}\n\n',
      'data: [DONE]\n\n',
    ])))
    expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 38, outputTokens: 5, cacheReadTokens: 12 } })
  })

  it('distinguishes caller abort from timeout', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })) as unknown as typeof fetch
    const result = collect(adapter(fetchImpl), baseOptions({ signal: controller.signal }))
    controller.abort('caller stopped')
    await expect(result).rejects.toMatchObject({ code: 'ABORTED' })
  })
})
