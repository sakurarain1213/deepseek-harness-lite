import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const require = createRequire(join(root, 'packages/core/package.json'))
const { load } = require('js-yaml')
const upstream = JSON.parse(await readFile(join(root, 'compat/upstream-lock.json'), 'utf8'))
const packageManager = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).packageManager
const [packageManagerName, packageManagerVersion] = packageManager.split('@')
if (packageManagerName !== 'pnpm' || !/^\d+\.\d+\.\d+$/.test(packageManagerVersion)) throw new Error('packageManager must pin an exact pnpm version')

const args = process.argv.slice(2)
const check = args.includes('--check')
const outputIndex = args.indexOf('--output')
if (outputIndex >= 0 && !args[outputIndex + 1]) throw new Error('--output requires a directory')
const output = resolve(outputIndex >= 0 ? args[outputIndex + 1] : join(root, 'packages/core/compat/0.1.0-rc.6'))
const seedIndex = args.indexOf('--seed-root')
if (seedIndex >= 0 && !args[seedIndex + 1]) throw new Error('--seed-root requires a directory')
const seedRoot = resolve(seedIndex >= 0 ? args[seedIndex + 1] : join(root, 'compat/lock-seeds/0.1.0-rc.6'))
const packIds = ['workspace', 'shell', 'research']
const platforms = ['darwin', 'linux', 'win32']
const hosts = [
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
]

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const canonicalDependencies = (value) => `${JSON.stringify(Object.fromEntries(Object.entries(value).sort()), null, 2)}\n`
const canonicalRows = (value) => `${JSON.stringify(value)}\n`

const seedManifest = JSON.parse(await readFile(join(seedRoot, 'seeds.json'), 'utf8'))
if (seedManifest.schemaVersion !== 1 || seedManifest.upstream !== upstream.harnessVersion || seedManifest.pnpm !== packageManagerVersion) {
  throw new Error('canonical lock seed manifest does not match generator inputs')
}
if (JSON.stringify(seedManifest.packs) !== JSON.stringify(packIds) || JSON.stringify(Object.keys(seedManifest.locks).sort()) !== JSON.stringify([...platforms].sort())) {
  throw new Error('canonical lock seed manifest is incomplete')
}

async function canonicalSeed(platform) {
  const seed = seedManifest.locks[platform]
  if (!seed || typeof seed.file !== 'string' || !/^[0-9a-f]{64}$/.test(seed.sha256)) throw new Error(`canonical lock seed metadata is invalid: ${platform}`)
  const source = await readFile(join(seedRoot, seed.file))
  if (sha256(source) !== seed.sha256) throw new Error(`canonical lock seed failed integrity validation: ${platform}`)
  return source
}

function packageMetadata(name) {
  let directory = dirname(require.resolve(name))
  while (true) {
    try {
      const value = require(join(directory, 'package.json'))
      if (value.name === name) return value
    } catch {}
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`unable to inspect ${name}`)
    directory = parent
  }
}

function closure(seeds) {
  const dependencies = {}
  const pending = [...seeds]
  while (pending.length) {
    const name = pending.pop()
    if (dependencies[name]) continue
    const version = upstream.packages[name]
    if (!version) throw new Error(`missing compatibility version for ${name}`)
    dependencies[name] = version
    for (const peer of Object.keys(packageMetadata(name).peerDependencies ?? {})) {
      if (upstream.packages[peer] && !dependencies[peer]) pending.push(peer)
    }
  }
  return Object.fromEntries(Object.entries(dependencies).sort())
}

async function treeFiles(directory) {
  const files = []
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files.push(relative(directory, path))
      else throw new Error(`compatibility tree contains unsupported entry ${path}`)
    }
  }
  await visit(directory)
  return files.sort()
}

async function assertTreesEqual(expected, actual) {
  const expectedFiles = await treeFiles(expected)
  const actualFiles = await treeFiles(actual)
  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) throw new Error('compatibility assets are stale')
  for (const file of expectedFiles) {
    if (!await readFile(join(expected, file)).then((value) => value.equals(require('node:fs').readFileSync(join(actual, file))))) {
      throw new Error(`compatibility asset differs: ${file}`)
    }
  }
}

const manifests = Object.fromEntries(await Promise.all(packIds.map(async (id) => [id, {
  manifest: JSON.parse(await readFile(join(root, `packages/packs/${id}/pack.json`), 'utf8')),
  rows: load(await readFile(join(root, `packages/packs/${id}/cordis.patch.yml`), 'utf8')).rows,
}])))

const generatedRoot = await mkdtemp(join(dirname(output), '.compat-generated-'))
try {
  const variants = []
  await mkdir(join(generatedRoot, 'locks'), { recursive: true })
  for (let mask = 0; mask < 2 ** packIds.length; mask++) {
    const selected = packIds.filter((_, index) => mask & (1 << index))
    for (const platform of platforms) {
      const seeds = new Set(hosts)
      const rows = []
      for (const id of selected) {
        const { manifest, rows: packRows } = manifests[id]
        for (const name of Object.keys(manifest.dependencies)) seeds.add(name)
        for (const name of Object.keys(manifest.platformDependencies?.[platform] ?? {})) seeds.add(name)
        for (const probe of manifest.probes) if (probe.kind === 'package') seeds.add(probe.target)
        for (const row of packRows) {
          if (row.platforms && !row.platforms.includes(platform)) continue
          const { platforms: _, ...officialRow } = row
          if (!rows.some((candidate) => candidate.id === officialRow.id)) rows.push(officialRow)
        }
      }
      const dependencies = closure(seeds)
      const profile = selected.length ? selected.join('+') : 'chat-only'
      const id = `${platform}-${profile}`
      const temporary = await mkdtemp(join(tmpdir(), 'dsh-lite-lock-'))
      try {
        await writeFile(join(temporary, 'pnpm-lock.yaml'), await canonicalSeed(platform))
        await writeFile(join(temporary, 'package.json'), `${JSON.stringify({
          name: '@dsh-lite/generated-profile',
          private: true,
          type: 'module',
          dependencies,
          pnpm: { supportedArchitectures: { os: [platform], cpu: [process.arch] } },
        }, null, 2)}\n`)
        await execFileAsync('corepack', [`pnpm@${packageManagerVersion}`, 'install', '--ignore-workspace', '--lockfile-only', '--prefer-offline', '--ignore-scripts', '--ignore-pnpmfile', '--config.confirmModulesPurge=false'], {
          cwd: temporary,
          env: { ...process.env, COREPACK_ENABLE_PROJECT_SPEC: '0' },
        })
        const lock = await readFile(join(temporary, 'pnpm-lock.yaml'), 'utf8')
        const parsedLock = load(lock)
        const importer = parsedLock?.importers?.['.']?.dependencies
        if (!parsedLock?.lockfileVersion || !importer || JSON.stringify(Object.keys(importer).sort()) !== JSON.stringify(Object.keys(dependencies))) {
          throw new Error(`generated lock ${id} has an invalid root importer`)
        }
        await writeFile(join(generatedRoot, 'locks', `${id}.yaml`), lock)
        variants.push({
          id,
          platform,
          packs: selected,
          dependencies,
          dependenciesSha256: sha256(canonicalDependencies(dependencies)),
          rowsSha256: sha256(canonicalRows(rows)),
          lock: `locks/${id}.yaml`,
          lockSha256: sha256(lock),
        })
      } finally {
        await rm(temporary, { recursive: true, force: true })
      }
    }
  }
  if (variants.length !== 24 || new Set(variants.map(({ id }) => id)).size !== 24) throw new Error('compatibility matrix is incomplete')
  await writeFile(join(generatedRoot, 'closures.json'), `${JSON.stringify({
    schemaVersion: 1,
    generator: { pnpm: packageManagerVersion, packOrder: packIds, platforms },
    upstream: { channel: upstream.channel, version: upstream.harnessVersion },
    variants,
  }, null, 2)}\n`)

  if (check) await assertTreesEqual(generatedRoot, output)
  else {
    const backup = `${output}.backup-${process.pid}`
    await rm(backup, { recursive: true, force: true })
    try {
      await rename(output, backup).catch((error) => { if (error.code !== 'ENOENT') throw error })
      await rename(generatedRoot, output)
      await rm(backup, { recursive: true, force: true })
    } catch (error) {
      await rename(backup, output).catch(() => undefined)
      throw error
    }
  }
} finally {
  await rm(generatedRoot, { recursive: true, force: true })
}
