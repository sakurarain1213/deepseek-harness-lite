import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'

export type Lookup = (hostname: string) => Promise<readonly string[]>
export type PinnedRequest = (url: URL, address: string, signal: AbortSignal) => Promise<Response>

export interface SafeFetchOptions {
  lookup?: Lookup
  request?: PinnedRequest
  maxRedirects?: number
  maxBytes?: number
  timeoutMs?: number
  signal?: AbortSignal
}

export interface Config {
  maxRedirects?: number
  maxBytes?: number
  timeoutMs?: number
}

export const name = 'lite-safe-fetch'
export const inject = ['tools']
export const Config = z.object({
  maxRedirects: z.number().default(3),
  maxBytes: z.number().default(262_144),
  timeoutMs: z.number().default(10_000),
})

const defaultLookup: Lookup = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true })
  return records.map(({ address }) => address)
}

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, part) => (value << 8) + Number(part), 0) >>> 0
}

function inV4Range(address: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffff_ffff << (32 - bits)) >>> 0
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask)
}

function ipv6Words(address: string): number[] | undefined {
  let normalized = address.toLowerCase()
  if (normalized.includes('.')) {
    const separator = normalized.lastIndexOf(':')
    const dotted = normalized.slice(separator + 1)
    if (isIP(dotted) !== 4) return undefined
    const value = ipv4Number(dotted)
    normalized = `${normalized.slice(0, separator)}:${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`
  }
  const halves = normalized.split('::')
  if (halves.length > 2) return undefined
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves[1] ? halves[1].split(':') : []
  const missing = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (missing < 0 || (halves.length === 1 && head.length !== 8)) return undefined
  const words = [...head, ...Array.from({ length: missing }, () => '0'), ...tail]
  if (words.length !== 8 || words.some(word => !/^[0-9a-f]{1,4}$/.test(word))) return undefined
  return words.map(word => Number.parseInt(word, 16))
}

function isBlockedAddress(address: string): boolean {
  if (isIP(address) === 4) {
    return [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(([base, bits]) => inV4Range(address, base as string, bits as number))
  }
  if (isIP(address) === 6) {
    const words = ipv6Words(address)
    if (words === undefined) return true
    if (words.slice(0, 7).every(word => word === 0) && (words[7] === 0 || words[7] === 1)) return true
    if ((words[0]! & 0xfe00) === 0xfc00 || (words[0]! & 0xffc0) === 0xfe80 || (words[0]! & 0xff00) === 0xff00) return true
    if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
      const mapped = `${words[6]! >>> 8}.${words[6]! & 0xff}.${words[7]! >>> 8}.${words[7]! & 0xff}`
      return isBlockedAddress(mapped)
    }
    return false
  }
  return true
}

async function resolvePublicHttpUrl(input: string | URL, lookup: Lookup): Promise<{ url: URL; addresses: string[] }> {
  const url = new URL(input)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only HTTP(S) URLs are allowed')
  if (url.username || url.password) throw new Error('URL credentials are not allowed')
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname
  const addresses = isIP(hostname) ? [hostname] : await lookup(hostname)
  if (addresses.length === 0) throw new Error('hostname did not resolve')
  if (addresses.some(isBlockedAddress)) throw new Error('private or link-local address is not allowed')
  return { url, addresses: [...addresses] }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('request timed out')
}

async function withinDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal)
  return new Promise<T>((resolveValue, reject) => {
    let settled = false
    const settle = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', aborted)
      callback()
    }
    const aborted = () => settle(() => reject(abortError(signal)))
    signal.addEventListener('abort', aborted, { once: true })
    operation.then(
      value => settle(() => resolveValue(value)),
      error => settle(() => reject(error)),
    )
  })
}

export async function assertPublicHttpUrl(input: string | URL, lookup: Lookup = defaultLookup): Promise<URL> {
  return (await resolvePublicHttpUrl(input, lookup)).url
}

function combinedSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([timeout, signal])
}

async function readBounded(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await withinDeadline(reader.read(), signal)
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel('response byte limit exceeded')
        throw new Error(`response exceeds ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
}

const pinnedRequest: PinnedRequest = (url, address, signal) => new Promise((resolveResponse, reject) => {
  const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)({
    protocol: url.protocol,
    hostname: address,
    port: url.port === '' ? undefined : Number(url.port),
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers: { host: url.host, accept: 'text/plain, text/html, application/json' },
    servername: url.hostname,
    signal,
  }, (incoming) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        incoming.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
        incoming.once('end', () => controller.close())
        incoming.once('error', (error) => controller.error(error))
      },
      cancel() { incoming.destroy() },
    })
    resolveResponse(new Response(body, {
      status: incoming.statusCode ?? 500,
      headers: incoming.headers as HeadersInit,
    }))
  })
  request.once('error', reject)
  request.end()
})

export async function boundedFetch(input: string | URL, options: SafeFetchOptions = {}) {
  const lookup = options.lookup ?? defaultLookup
  const request = options.request ?? pinnedRequest
  const maxRedirects = options.maxRedirects ?? 3
  const maxBytes = options.maxBytes ?? 262_144
  const timeoutMs = options.timeoutMs ?? 10_000
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) throw new Error('maxRedirects must be a non-negative integer')
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('maxBytes must be a positive integer')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('timeoutMs must be a positive integer')
  let url = new URL(input)
  const signal = combinedSignal(timeoutMs, options.signal)
  for (let redirect = 0; ; redirect++) {
    const resolved = await withinDeadline(resolvePublicHttpUrl(url, lookup), signal)
    url = resolved.url
    const response = await withinDeadline(request(url, resolved.addresses[0]!, signal), signal)
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel('redirect response not consumed')
      if (location === null) throw new Error('redirect is missing location')
      if (redirect >= maxRedirects) throw new Error(`redirect limit ${maxRedirects} exceeded`)
      url = new URL(location, url)
      continue
    }
    return {
      url: url.href,
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      text: await readBounded(response, maxBytes, signal),
    }
  }
}

export function createSafeFetchTool(options: SafeFetchOptions = {}) {
  return defineTool({
    name: 'lite_safe_fetch',
    description: 'Fetch a public HTTP(S) URL with DNS, redirect, size, and timeout limits.',
    parameters: { url: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          url: { type: 'string', required: true }, status: { type: 'integer', required: true },
          contentType: { type: 'string', required: true }, text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: options.timeoutMs ?? 10_000,
    async execute(args, exec) { return boundedFetch(args.url, { ...options, signal: exec.signal }) },
    isConcurrencySafe: () => true,
  })
}

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(createSafeFetchTool(config))
}

const plugin = { name, inject, Config, apply }
export default plugin
