import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const processes: ReturnType<typeof spawn>[] = []
const builtCli = join(process.cwd(), 'apps/cli/dist/src/bin.js')

afterEach(() => {
  for (const child of processes) child.kill()
  processes.length = 0
})

function runCli(args: string[], env: NodeJS.ProcessEnv = {}, cwd = process.cwd()): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [builtCli, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  processes.push(child)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  return new Promise(resolve => child.on('close', code => resolve({ code, stdout, stderr })))
}

it('runs one built CLI turn through an OpenAI-compatible chat completions endpoint', async () => {
  let requestBody: Record<string, unknown> | undefined
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      requestBody = JSON.parse(body) as Record<string, unknown>
      response.setHeader('content-type', 'text/event-stream')
      response.end('data: {"choices":[{"delta":{"content":"hello built"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock server did not bind')

  const root = await mkdtemp(join(tmpdir(), 'dsh-lite-run-'))
  const config = join(root, 'lite.json')
  const home = join(root, 'home')
  await writeFile(config, JSON.stringify({ schemaVersion: 1, upstream: { channel: 'stable', version: '0.1.0-rc.6' }, profile: 'chat-only', packs: [], plugins: [] }))
  expect((await runCli(['init', '--config', config, '--home', home])).code).toBe(0)

  const secret = 'SENTINEL_RUNTIME_API_KEY'
  const result = await runCli(['run', 'ping', '--home', home], {
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    DEEPSEEK_API_KEY: secret,
    DEEPSEEK_MODEL: '',
  })
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))

  expect(result).toEqual({ code: 0, stdout: 'hello built\n', stderr: '' })
  expect(requestBody).toMatchObject({ model: 'deepseek-v4-flash', stream: true })
  expect(Number(requestBody?.max_tokens)).toBeGreaterThan(0)
  expect(Number(requestBody?.max_tokens)).toBeLessThanOrEqual(1024)
  expect(JSON.stringify(requestBody)).not.toContain(secret)
})

it('initializes from an unrelated cwd using the packaged compatibility asset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lite-external-cwd-'))
  const elsewhere = await mkdtemp(join(tmpdir(), 'dsh-lite-cwd-'))
  const config = join(root, 'lite.json')
  const home = join(root, 'home')
  await writeFile(config, JSON.stringify({ schemaVersion: 1, upstream: { channel: 'stable', version: '0.1.0-rc.6' }, profile: 'chat-only', packs: [], plugins: [] }))
  const result = await runCli(['init', '--config', config, '--home', home], {}, elsewhere)
  expect(result).toEqual({ code: 0, stdout: `initialized ${home}\n`, stderr: '' })
})

it('fails without credentials and never prints an inherited secret', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lite-run-'))
  const config = join(root, 'lite.json')
  const home = join(root, 'home')
  await writeFile(config, JSON.stringify({ schemaVersion: 1, upstream: { channel: 'stable', version: '0.1.0-rc.6' }, profile: 'chat-only', packs: [], plugins: [] }))
  expect((await runCli(['init', '--config', config, '--home', home])).code).toBe(0)

  const sentinel = 'SENTINEL_UNRELATED_SECRET'
  const result = await runCli(['run', 'ping', '--home', home], {
    DEEPSEEK_API_KEY: '',
    DSH_LITE_TEST_SECRET: sentinel,
  })

  expect(result.code).not.toBe(0)
  expect(`${result.stdout}\n${result.stderr}`).not.toContain(sentinel)
})
