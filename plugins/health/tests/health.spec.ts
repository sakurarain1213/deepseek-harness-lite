import { describe, expect, it } from 'vitest'
import { executeTool, withPlugin } from '@dsh-lite/plugin-test-support'
import plugin, { createHealthTool } from '../src/index.js'

describe('health plugin', () => {
  it('executes lite_health without exposing environment values', async () => {
    const secret = 'health-secret-must-not-escape'
    process.env.DSH_LITE_HEALTH_TEST_SECRET = secret
    try {
      await withPlugin(plugin, {
        runtime: 'node',
        upstreamVersion: '0.1.0-rc.6',
        profile: 'developer',
        packs: ['workspace'],
        plugins: ['health'],
      }, async (context, fiber) => {
        const result = await executeTool(context, 'lite_health', {})
        expect(result.isError).toBe(false)
        expect(JSON.stringify(result)).not.toContain(secret)
        await fiber.dispose()
        expect(context.tools.get('lite_health')).toBeUndefined()
      })
    } finally {
      delete process.env.DSH_LITE_HEALTH_TEST_SECRET
    }
  })

  it('publishes an official registry-ready tool definition', () => {
    expect(createHealthTool({ runtime: 'node', upstreamVersion: 'test', profile: 'chat-only', packs: [], plugins: [] }).name)
      .toBe('lite_health')
  })
})
