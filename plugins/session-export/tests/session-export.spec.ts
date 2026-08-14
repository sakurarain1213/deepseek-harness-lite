import { describe, expect, it } from 'vitest'
import { executeTool, withPlugin } from '@dsh-lite/plugin-test-support'
import plugin, { createSessionExportTool, projectSession } from '../src/index.js'

describe('session export plugin', () => {
  it('exports only explicitly supported session fields', () => {
    const output = projectSession([
      { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'hi' }], credential: 'secret' } },
      { type: 'internal/debug', seq: 1, time: 2, data: { text: 'hidden', token: 'secret' } },
    ], 'json')
    expect(output).toContain('hi')
    expect(output).not.toContain('secret')
    expect(output).not.toContain('internal/debug')
  })

  it('projects supported Markdown without unknown fields', () => {
    const output = projectSession([
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] }, authorization: 'secret' } },
      { type: 'tool/call', data: { callId: 'call-1', name: 'read_file', arguments: '{"path":"secret"}' } },
      { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'ok' }] }] }, headers: { authorization: 'secret' } } },
    ], 'markdown')
    expect(output).toContain('## Assistant')
    expect(output).toContain('## Tool: read_file')
    expect(output).not.toContain('secret')
  })

  it('publishes an official registry-ready tool definition', () => {
    expect(createSessionExportTool(() => []).name).toBe('lite_session_export')
  })

  it('prefers the current executing agent session over fallback events', async () => {
    const tool = createSessionExportTool(() => [{ type: 'user/message', data: { content: [{ type: 'text', text: 'stale' }] } }])
    const value = await tool.execute({ format: 'json' }, {
      agent: { session: { events: [{ type: 'user/message', data: { content: [{ type: 'text', text: 'current' }] } }] } },
    } as never)
    expect(value).toContain('current')
    expect(value).not.toContain('stale')
  })

  it('executes and disposes through a real Cordis context', async () => {
    const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }] } }]
    await withPlugin(plugin, { events }, async (context, fiber) => {
      const result = await executeTool(context, 'lite_session_export', { format: 'json' })
      expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('hello') }])
      await fiber.dispose()
      expect(context.tools.get('lite_session_export')).toBeUndefined()
    })
  })
})
