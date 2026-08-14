import { execFile } from 'node:child_process'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const MAX_OUTPUT_BYTES = 64 * 1024
const PROCESS_TIMEOUT_MS = 60_000
const TASK = 'Reply with exactly: OK'
const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const builtCli = join(repositoryRoot, 'apps', 'cli', 'dist', 'src', 'bin.js')

function validateEnvironment() {
  const endpoint = process.env.DEEPSEEK_BASE_URL?.trim()
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
  if (!endpoint || !apiKey) throw new Error('smoke environment is incomplete')
  const url = new URL(endpoint)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported endpoint protocol')
  if (url.username || url.password) throw new Error('endpoint must not contain credentials')
  return { apiKey }
}

async function runCli(args, cwd) {
  return execFileAsync(process.execPath, [builtCli, ...args], {
    cwd,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: PROCESS_TIMEOUT_MS,
    windowsHide: true,
  })
}

async function main() {
  const { apiKey } = validateEnvironment()
  await access(builtCli)
  const root = await mkdtemp(join(tmpdir(), 'dsh-lite-product-smoke-'))
  const config = join(root, 'lite.config.json')
  const home = join(root, 'home')
  try {
    await writeFile(config, `${JSON.stringify({
      schemaVersion: 1,
      upstream: { channel: 'stable', version: '0.1.0-rc.6' },
      profile: 'chat-only',
      packs: [],
      plugins: [],
    }, null, 2)}\n`, { mode: 0o600 })
    await runCli(['init', '--config', config, '--home', home], root)
    const { stdout } = await runCli(['run', TASK, '--home', home], root)
    const answer = stdout.trim()
    if (!answer) throw new Error('product smoke returned no text')
    process.stdout.write(`${answer.split(apiKey).join('[REDACTED]')}\n`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch(() => {
  process.stderr.write('DeepSeek API product smoke failed\n')
  process.exitCode = 1
})
