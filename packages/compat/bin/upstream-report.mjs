import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { sanitizeDiagnostic } from './diagnostics.mjs'

const execFileAsync = promisify(execFile)
const args = process.argv.slice(2)
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index < 0 ? fallback : args[index + 1]
}
const root = resolve(import.meta.dirname, '../../..')
const channel = valueAfter('--channel', process.env.DSH_COMPAT_CHANNEL ?? 'stable')
if (!['stable', 'latest', 'next'].includes(channel)) throw new Error(`unsupported compatibility channel: ${channel}`)
const output = resolve(valueAfter('--output', join(root, `compat/reports/${channel}.json`)))
const lock = JSON.parse(await readFile(join(root, 'compat/upstream-lock.json'), 'utf8'))
const timestamp = new Date().toISOString()
const commands = []
const registryCache = await mkdtemp(join(tmpdir(), 'dsh-lite-registry-cache-'))
const liteCommit = process.env.GITHUB_SHA ?? (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
const limitations = [
  'Registry metadata was resolved, but the candidate dependency graph was not installed or executed.',
  'This observation is not runtime, CLI, pack, plugin, or native-platform compatibility evidence.',
]

async function view(specifier, field) {
  const command = ['pnpm', 'view', specifier, field, '--json'].filter(Boolean)
  commands.push(`corepack ${command.join(' ')}`)
  const { stdout } = await execFileAsync('corepack', command, {
    cwd: root,
    env: { ...process.env, NPM_CONFIG_CACHE: registryCache },
    maxBuffer: 16 * 1024 * 1024,
  })
  return JSON.parse(stdout)
}

let report
try {
  const tag = channel === 'stable' ? lock.harnessVersion : channel
  const aggregateVersion = channel === 'stable' ? lock.harnessVersion : await view(`@deepseek-ai/dsh@${tag}`, 'version')
  if (typeof aggregateVersion !== 'string') throw new Error('aggregate release did not resolve to one exact version')
  const inventory = {}
  const skew = []
  for (const name of Object.keys(lock.packages).sort()) {
    const expected = name.startsWith('@deepseek-ai/dsh-') ? aggregateVersion : lock.packages[name]
    const metadata = await view(`${name}@${expected}`, '')
    if (!metadata || metadata.name !== name || metadata.version !== expected) throw new Error(`${name}@${expected} is not published coherently`)
    inventory[name] = expected
    if (channel !== 'stable') {
      const taggedVersion = await view(name, `dist-tags.${channel}`)
      if (taggedVersion !== aggregateVersion) skew.push({ package: name, aggregateVersion, packageVersion: taggedVersion ?? null })
    }
  }
  report = {
    schemaVersion: 1,
    channel,
    evidenceKind: 'registry-metadata-observation',
    liteCommit,
    upstreamVersion: aggregateVersion,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    packageManager: 'pnpm@10.15.0',
    selection: { packs: [], plugins: [] },
    packageInventory: inventory,
    commands,
    result: 'planned',
    measured: false,
    timestamp,
    tagSkew: skew,
    limitations,
  }
} catch (error) {
  report = {
    schemaVersion: 1,
    channel,
    evidenceKind: 'registry-metadata-observation',
    liteCommit,
    upstreamVersion: 'unresolved',
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    packageManager: 'pnpm@10.15.0',
    selection: { packs: [], plugins: [] },
    packageInventory: {},
    commands,
    result: 'unavailable',
    measured: false,
    timestamp,
    diagnostics: [sanitizeDiagnostic(error instanceof Error ? error.message : error)],
    limitations,
  }
  process.exitCode = 1
}
try {
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
} finally {
  await rm(registryCache, { recursive: true, force: true })
}
process.stdout.write(`upstream metadata observation written to ${output}\n`)
