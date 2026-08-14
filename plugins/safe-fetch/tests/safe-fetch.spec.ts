import { describe, expect, it, vi } from 'vitest'
import { executeTool, withPlugin } from '@dsh-lite/plugin-test-support'
import plugin, { assertPublicHttpUrl, boundedFetch, createSafeFetchTool } from '../src/index.js'

describe('safe fetch plugin', () => {
  it('rejects every resolved private address before fetching', async () => {
    await expect(assertPublicHttpUrl('https://example.test', async () => ['169.254.169.254']))
      .rejects.toThrow('private or link-local address')
  })

  it('rejects an IPv6 loopback literal without DNS lookup', async () => {
    const lookup = vi.fn(async () => ['93.184.216.34'])
    await expect(assertPublicHttpUrl('http://[::1]/', lookup)).rejects.toThrow('private or link-local address')
    expect(lookup).not.toHaveBeenCalled()
  })

  it.each([
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a00:1',
    '::ffff:a9fe:a9fe',
  ])('rejects private IPv4-mapped IPv6 literal %s', async (address) => {
    await expect(assertPublicHttpUrl(`http://[${address}]/`)).rejects.toThrow('private or link-local address')
  })

  it('allows a public IPv4-mapped IPv6 literal', async () => {
    await expect(assertPublicHttpUrl('http://[::ffff:5db8:d822]/')).resolves.toMatchObject({ hostname: '[::ffff:5db8:d822]' })
  })

  it('revalidates DNS before following each redirect', async () => {
    const lookup = vi.fn(async (hostname: string) => hostname === 'public.test' ? ['93.184.216.34'] : ['127.0.0.1'])
    const request = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://internal.test/metadata' },
    }))

    await expect(boundedFetch('https://public.test/start', { lookup, request }))
      .rejects.toThrow('private or link-local address')
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenCalledWith(expect.any(URL), '93.184.216.34', expect.any(AbortSignal))
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('limits response bytes', async () => {
    await expect(boundedFetch('https://public.test', {
      lookup: async () => ['93.184.216.34'],
      request: async () => new Response('too large'),
      maxBytes: 3,
    })).rejects.toThrow('response exceeds 3 bytes')
  })

  it('applies the absolute timeout while DNS resolution is pending', async () => {
    const started = Date.now()
    await expect(boundedFetch('https://never-resolves.test', {
      lookup: () => new Promise(() => undefined),
      timeoutMs: 20,
    })).rejects.toThrow(/timeout/)
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('cancels a stalled response body when the absolute timeout expires', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start() {},
      cancel() { cancelled = true },
    })

    await expect(boundedFetch('https://public.test', {
      lookup: async () => ['93.184.216.34'],
      request: async () => new Response(body),
      timeoutMs: 20,
    })).rejects.toThrow(/timeout/)
    expect(cancelled).toBe(true)
  })

  it('publishes an official registry-ready tool definition', () => {
    expect(createSafeFetchTool({ lookup: async () => ['93.184.216.34'], request: async () => new Response('ok') }).name)
      .toBe('lite_safe_fetch')
  })

  it('activates and disposes in a real Cordis context', async () => {
    await withPlugin(plugin, { maxRedirects: 1, maxBytes: 64, timeoutMs: 100 }, async (context, fiber) => {
      expect(context.tools.get('lite_safe_fetch')?.name).toBe('lite_safe_fetch')
      await fiber.dispose()
      expect(context.tools.get('lite_safe_fetch')).toBeUndefined()
    })
  })

  it('executes its official schema and handler through the real tool registry', async () => {
    await withPlugin(plugin, { maxRedirects: 1, maxBytes: 64, timeoutMs: 100 }, async (context, fiber) => {
      await fiber.dispose()
      const dispose = context.tools.register(createSafeFetchTool({
        lookup: async () => ['93.184.216.34'],
        request: async (_url, address) => new Response(`connected:${address}`, { status: 200 }),
      }))
      const result = await executeTool(context, 'lite_safe_fetch', { url: 'https://public.test/path' })
      expect(result.isError).toBe(false)
      expect(result.content).toEqual([{ type: 'text', text: 'connected:93.184.216.34' }])
      await dispose()
    })
  })
})
