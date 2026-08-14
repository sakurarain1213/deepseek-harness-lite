import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

interface ProcessResult {
  code: number | null
  stdout: string
  stderr: string
}

function runSmoke(environment: NodeJS.ProcessEnv): Promise<ProcessResult> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(process.execPath, ['scripts/real-api-smoke.mjs'], {
      cwd: resolve('.'),
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => resolveProcess({ code, stdout, stderr }))
  })
}

async function treeContains(root: string, needle: Buffer): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (await treeContains(path, needle)) return true
    } else if (entry.isFile() && (await readFile(path)).includes(needle)) return true
  }
  return false
}

async function productSmokeHomes(root: string): Promise<string[]> {
  return (await readdir(root)).filter(entry => entry.startsWith('dsh-lite-product-smoke-'))
}

describe('real API product smoke script', () => {
  it('runs init and one turn through the built Lite CLI without persisting its credential', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-lite-smoke-test-'))
    const scriptTmpdir = join(temporaryRoot, 'tmp')
    await mkdir(scriptTmpdir)
    const secret = 'SMOKE_SENTINEL_SECRET'
    let credentialPersisted: boolean | undefined
    let request: { url?: string; authorization?: string; body?: Record<string, unknown> } = {}
    const server = createServer((incoming, response) => {
      let source = ''
      incoming.setEncoding('utf8')
      incoming.on('data', chunk => { source += chunk })
      incoming.on('end', async () => {
        request = {
          url: incoming.url,
          authorization: incoming.headers.authorization,
          body: JSON.parse(source) as Record<string, unknown>,
        }
        credentialPersisted = await treeContains(scriptTmpdir, Buffer.from(secret))
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end([
          `data: ${JSON.stringify({ choices: [{ delta: { content: `pong ${secret}` }, finish_reason: null }] })}`,
          '',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
          '',
          'data: [DONE]',
          '',
          '',
        ].join('\n'))
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test server did not bind')

    try {
      const result = await runSmoke({
        ...process.env,
        TMPDIR: scriptTmpdir,
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/v1/chat/completions`,
        DEEPSEEK_API_KEY: secret,
        DEEPSEEK_MODEL: 'deepseek-v4-flash',
      })
      expect(result).toEqual({ code: 0, stdout: 'pong [REDACTED]\n', stderr: '' })
      expect(`${result.stdout}${result.stderr}`).not.toContain(secret)
      expect(request).toMatchObject({
        url: '/v1/chat/completions',
        authorization: `Bearer ${secret}`,
        body: {
          model: 'deepseek-v4-flash',
          stream: true,
          stream_options: { include_usage: true },
        },
      })
      expect(request.body).not.toHaveProperty('tools')
      expect(Number(request.body?.max_tokens)).toBeGreaterThan(0)
      expect(Number(request.body?.max_tokens)).toBeLessThanOrEqual(1024)
      expect(credentialPersisted).toBe(false)
      expect(await productSmokeHomes(scriptTmpdir)).toEqual([])
    } finally {
      server.close()
      await once(server, 'close')
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  }, 60_000)

  it('cleans its generated home and fails without leaking a supplied credential', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-lite-smoke-failure-'))
    const scriptTmpdir = join(temporaryRoot, 'tmp')
    await mkdir(scriptTmpdir)
    const secret = 'SMOKE_SENTINEL_SECRET'
    try {
      const result = await runSmoke({
        ...process.env,
        TMPDIR: scriptTmpdir,
        DEEPSEEK_BASE_URL: 'http://127.0.0.1:1/v1/chat/completions',
        DEEPSEEK_API_KEY: secret,
        DEEPSEEK_MODEL: 'deepseek-v4-flash',
      })
      expect(result.code).toBe(1)
      expect(`${result.stdout}${result.stderr}`).not.toContain(secret)
      expect(await productSmokeHomes(scriptTmpdir)).toEqual([])
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  }, 60_000)
})
