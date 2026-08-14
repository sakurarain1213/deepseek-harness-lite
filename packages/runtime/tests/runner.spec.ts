import { CallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import { bootRuntime, chatOnly, runTask } from '../src/index.js'

const scriptedAdapter = (answer: string): LlmAdapter => new class extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}()

it('runs one task and derives a completed answer from durable session events', async () => {
  const runtime = await bootRuntime({ profile: chatOnly, adapter: scriptedAdapter('hello') })

  await expect(runTask(runtime, 'ping')).resolves.toMatchObject({ text: 'hello', completed: true })
  const events = [...runtime.lastEvents!]
  expect([...events].reverse().find(event => event.type === 'assistant/message')).toMatchObject({
    data: { message: { content: [{ type: 'text', text: 'hello' }] } },
  })
  expect([...events].reverse().find(event => event.type === 'turn/end')).toMatchObject({
    data: { reason: { kind: 'completed' } },
  })
  await runtime.dispose()
})

it('rejects empty tasks before creating an agent', async () => {
  const runtime = await bootRuntime({ profile: chatOnly, adapter: scriptedAdapter('unused') })
  await expect(runTask(runtime, '   ')).rejects.toThrow('task must be non-empty')
  expect(runtime.lastEvents).toBeUndefined()
  await runtime.dispose()
})

it('executes a registered Cordis tool and projects final text from the completed turn', async () => {
  const requests: GenerateOptions[] = []
  let call = 0
  const adapter = new class extends LlmAdapter {
    async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(options)
      call += 1
      if (call === 1) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: CallId('c1'), name: 'echo', argumentsDelta: '{"text":"ping"}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('c1'), name: 'echo', arguments: '{"text":"ping"}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'final answer' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'final answer' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }()
  const runtime = await bootRuntime({ profile: chatOnly, adapter })
  runtime.context.tools.register(defineTool({
    name: 'echo',
    description: 'Echo text',
    parameters: { text: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async ({ text }) => `echo:${text}`,
  }))

  await expect(runTask(runtime, 'use echo')).resolves.toMatchObject({ text: 'final answer', completed: true })
  expect(requests).toHaveLength(2)
  expect(requests[0]?.tools?.map(tool => tool.name)).toContain('echo')
  expect(requests[1]?.messages.some(message => message.content.some(block => block.type === 'tool-result'))).toBe(true)
  expect(runtime.context.agents.list()).toHaveLength(0)
  await runtime.dispose()
})

it('executes a selected bundled plugin through the model tool round', async () => {
  const requests: GenerateOptions[] = []
  let call = 0
  const adapter = new class extends LlmAdapter {
    async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(options)
      call += 1
      if (call === 1) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: CallId('health-1'), name: 'lite_health', argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('health-1'), name: 'lite_health', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'healthy' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'healthy' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }()
  const profile = { ...chatOnly, pluginIds: ['health'] }
  const runtime = await bootRuntime({ profile, adapter })
  try {
    await expect(runTask(runtime, 'check health')).resolves.toMatchObject({ text: 'healthy', completed: true })
    expect(requests[0]?.tools?.map(tool => tool.name)).toContain('lite_health')
    expect(requests[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: expect.arrayContaining([
        expect.objectContaining({ type: 'tool-result', toolCallId: 'health-1', isError: false }),
      ]) }),
    ]))
  } finally {
    await runtime.dispose()
  }
})

it('disposes every owned handle across repeated runs', async () => {
  const runtime = await bootRuntime({ profile: chatOnly, adapter: scriptedAdapter('done') })
  await runTask(runtime, 'first')
  await runTask(runtime, 'second')
  expect(runtime.context.agents.list()).toHaveLength(0)
  await runtime.dispose()
})

it('does not expose a completed session through an agentless export call', async () => {
  const runtime = await bootRuntime({
    profile: { ...chatOnly, pluginIds: ['session-export'] },
    adapter: scriptedAdapter('exported answer'),
  })
  try {
    await runTask(runtime, 'export this prompt')
    const result = await runtime.context.tools.execute({
      callId: CallId('export-1'),
      name: 'lite_session_export',
      arguments: { format: 'json' },
      signal: new AbortController().signal,
    })
    const rendered = JSON.stringify(result.content)
    expect(result.isError).toBe(false)
    expect(rendered).not.toContain('export this prompt')
    expect(rendered).not.toContain('exported answer')
  } finally {
    await runtime.dispose()
  }
})

it('exports the current turn when the model invokes session export', async () => {
  let call = 0
  let exported = ''
  const adapter = new class extends LlmAdapter {
    async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      call += 1
      if (call === 1) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: CallId('export-current'), name: 'lite_session_export', argumentsDelta: '{"format":"json"}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('export-current'), name: 'lite_session_export', arguments: '{"format":"json"}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const result = options.messages.flatMap(message => message.content).find(block => block.type === 'tool-result')
      exported = result?.type === 'tool-result' ? result.content.filter(block => block.type === 'text').map(block => block.text).join('') : ''
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'export complete' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'export complete' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }()
  const runtime = await bootRuntime({ profile: { ...chatOnly, pluginIds: ['session-export'] }, adapter })
  try {
    await runTask(runtime, 'current prompt')
    expect(exported).toContain('current prompt')
  } finally {
    await runtime.dispose()
  }
})

it('returns the submitted task turn when a plugin queues a second followup', async () => {
  let call = 0
  const adapter = new class extends LlmAdapter {
    async * stream(): AsyncIterable<StreamChunk> {
      call += 1
      const text = call === 1 ? 'submitted answer' : 'queued answer'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }()
  const runtime = await bootRuntime({ profile: chatOnly, adapter })
  let queued = false
  runtime.context.on('agent/inbox/claimed', ({ agent, message }) => {
    if (queued || message.source.kind !== 'user') return
    queued = true
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'plugin followup' }] }))
  })

  await expect(runTask(runtime, 'original task')).resolves.toMatchObject({ text: 'submitted answer', completed: true })
  expect(call).toBe(2)
  await runtime.dispose()
})
