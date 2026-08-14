import { execFile } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { sanitizeDiagnostic } from '../packages/compat/bin/diagnostics.mjs'
import { resolveCorepackCommand } from '../packages/core/src/corepack.ts'

const execFileAsync = promisify(execFile)
const args = process.argv.slice(2)
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index < 0 ? fallback : args[index + 1]
}
const root = resolve(import.meta.dirname, '..')
const require = createRequire(join(root, 'packages/core/package.json'))
const { load: loadYaml } = require('js-yaml')
const output = resolve(valueAfter('--output', join(root, 'compat/reports/install-size.json')))
const corepackExecutable = valueAfter('--package-manager', 'corepack')
const packageManager = 'corepack pnpm@10.15.0'
const lock = JSON.parse(await readFile(join(root, 'compat/upstream-lock.json'), 'utf8'))
const liteInventory = JSON.parse(await readFile(join(root, 'packages/core/compat/0.1.0-rc.6/closures.json'), 'utf8'))
  .variants.find((entry) => entry.id === `${process.platform}-chat-only`)?.dependencies
const timestamp = new Date().toISOString()

async function executePackageManager(managerArgs, options) {
  if (corepackExecutable !== 'corepack') return execFileAsync(corepackExecutable, managerArgs, options)
  const corepack = await resolveCorepackCommand(managerArgs)
  return execFileAsync(corepack.file, corepack.args, options)
}

async function treeMetrics(path) {
  let bytes = 0
  let files = 0
  const managerState = new Set(['.modules.yaml', '.pnpm-workspace-state-v1.json', '.pnpm/lock.yaml'])
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name)
      if (managerState.has(relative(path, child))) continue
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile()) {
        bytes += (await stat(child)).size
        files++
      }
    }
  }
  await visit(path)
  return { bytes, files }
}

async function installedPackageCount(nodeModules) {
  const packages = new Set()
  const store = join(nodeModules, '.pnpm')
  for (const entry of await readdir(store, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const modules = join(store, entry.name, 'node_modules')
    for (const child of await readdir(modules, { withFileTypes: true }).catch(() => [])) {
      const manifests = child.name.startsWith('@')
        ? (await readdir(join(modules, child.name), { withFileTypes: true }).catch(() => []))
          .filter((item) => item.isDirectory())
          .map((item) => join(modules, child.name, item.name, 'package.json'))
        : child.isDirectory() ? [join(modules, child.name, 'package.json')] : []
      for (const manifest of manifests) {
        const metadata = JSON.parse(await readFile(manifest, 'utf8'))
        if (typeof metadata.name === 'string' && typeof metadata.version === 'string') packages.add(`${metadata.name}@${metadata.version}`)
      }
    }
  }
  return packages.size
}

async function install(directory, dependencies, storeDirectory, cacheDirectory) {
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`)
  const managerArgs = ['pnpm@10.15.0', 'install', '--ignore-workspace', '--ignore-scripts', '--ignore-pnpmfile', '--config.confirmModulesPurge=false', '--store-dir', storeDirectory]
  await executePackageManager(managerArgs, {
    cwd: directory,
    env: { ...process.env, COREPACK_ENABLE_PROJECT_SPEC: '0', NPM_CONFIG_CACHE: cacheDirectory },
    maxBuffer: 64 * 1024 * 1024,
  })
  const nodeModules = join(directory, 'node_modules')
  const [metrics, packageCount] = await Promise.all([treeMetrics(nodeModules), installedPackageCount(nodeModules)])
  return { ...metrics, installedPackageCount: packageCount }
}

async function installCheckout(directory, storeDirectory, cacheDirectory) {
  const excluded = new Set(['.git', '.worktrees', '.superpowers', 'node_modules', 'dist', 'coverage'])
  await cp(root, directory, {
    recursive: true,
    filter(source) {
      const path = relative(root, source)
      return path === '' || !path.split('/').some(segment => excluded.has(segment) || segment.endsWith('.tsbuildinfo'))
    },
  })
  await executePackageManager([
    'pnpm@10.15.0', 'install', '--frozen-lockfile', '--ignore-scripts', '--config.confirmModulesPurge=false', '--store-dir', storeDirectory,
  ], {
    cwd: directory,
    env: { ...process.env, COREPACK_ENABLE_PROJECT_SPEC: '0', NPM_CONFIG_CACHE: cacheDirectory },
    maxBuffer: 64 * 1024 * 1024,
  })
  const parsedLock = loadYaml(await readFile(join(directory, 'pnpm-lock.yaml'), 'utf8'))
  const directDependencies = new Set()
  for (const importer of Object.values(parsedLock?.importers ?? {})) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(importer?.[field] ?? {})) directDependencies.add(name)
    }
  }
  const nodeModules = join(directory, 'node_modules')
  const [metrics, packageCount] = await Promise.all([treeMetrics(nodeModules), installedPackageCount(nodeModules)])
  return {
    ...metrics,
    installedPackageCount: packageCount,
    directDependencyCount: directDependencies.size,
    workspacePackageCount: Object.keys(parsedLock?.importers ?? {}).length,
  }
}

const temporary = await mkdtemp(join(tmpdir(), 'dsh-lite-install-measure-'))
let report
try {
  if (!liteInventory) throw new Error(`no committed chat-only profile for ${process.platform}`)
  const liteDirectory = join(temporary, 'lite')
  const aggregateDirectory = join(temporary, 'aggregate')
  const checkoutDirectory = join(temporary, 'checkout')
  const storeDirectory = join(temporary, 'store')
  const cacheDirectory = join(temporary, 'cache')
  const { stdout: registryOutput } = await executePackageManager(['pnpm@10.15.0', 'config', 'get', 'registry'], { cwd: root })
  const registry = registryOutput.trim()
  await mkdir(liteDirectory)
  await mkdir(aggregateDirectory)
  const checkout = await installCheckout(checkoutDirectory, storeDirectory, cacheDirectory)
  const lite = await install(liteDirectory, liteInventory, storeDirectory, cacheDirectory)
  const aggregate = await install(aggregateDirectory, { '@deepseek-ai/dsh': lock.harnessVersion }, storeDirectory, cacheDirectory)
  report = {
    schemaVersion: 1,
    result: 'passed',
    measured: true,
    timestamp,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    packageManager,
    registry,
    profiles: {
      checkout: { id: 'repository-checkout', ...checkout },
      coreChatClosure: { id: `${process.platform}-chat-only`, directDependencyCount: Object.keys(liteInventory).length, ...lite },
      aggregate: { package: '@deepseek-ai/dsh', version: lock.harnessVersion, directDependencyCount: 1, ...aggregate },
    },
  }
} catch (error) {
  const registry = process.env.NPM_CONFIG_REGISTRY ?? 'unresolved'
  report = {
    schemaVersion: 1,
    result: 'unavailable',
    measured: false,
    timestamp,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    packageManager,
    registry,
    diagnostic: sanitizeDiagnostic(error instanceof Error ? error.message : error),
  }
  process.exitCode = 1
} finally {
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
  await rm(temporary, { recursive: true, force: true })
}
if (report.result === 'passed') process.stdout.write(`install measurement written to ${output}\n`)
else process.stderr.write(`install measurement unavailable; report written to ${output}\n`)
