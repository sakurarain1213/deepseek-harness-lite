import { constants } from 'node:fs'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve, win32 } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  loadPackPackage,
  materializeProfile,
  parseLiteConfig,
  redact,
  readUpstreamLock,
  resolveProfile,
  publishTree,
  resolveCurrentTree,
  validateInstalledProfile,
  type Platform,
  type Registry,
  type ResolvedProfile,
  type ValidatedInstalledProfile,
} from '@dsh-lite/core'
import { BUNDLED_PLUGIN_PACKAGES, bootRuntime, runTask } from '@dsh-lite/runtime'
import { parseArgs } from './args.js'

export interface CliIo {
  cwd: string
  platform: Platform
  out(line: string): void
  err(line: string): void
}

const require = createRequire(import.meta.url)
const NODE_ENGINE = '^22.19.0 || >=24'
const CREDENTIAL_KEY = /^(?:api[-_]?key|authorization|credential|password|secret|token|access[-_]?token|refresh[-_]?token)$/i

class CliDiagnostic extends Error {}

export function isSupportedNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major >= 24 || (major === 22 && minor >= 19)
}

function containsCredentialField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCredentialField)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) => CREDENTIAL_KEY.test(key) || containsCredentialField(child))
}

export function resolveCliPath(cwd: string, path: string, platform: Platform): string {
  return platform === 'win32' ? win32.resolve(cwd, path) : resolve(cwd, path)
}

async function readText(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    throw new CliDiagnostic(`unable to read ${label}`)
  }
}

function parseJson(source: string, label: string): unknown {
  try {
    return JSON.parse(source) as unknown
  } catch {
    throw new CliDiagnostic(`invalid JSON in ${label}`)
  }
}

function parseConfig(source: string): ReturnType<typeof parseLiteConfig> {
  const value = parseJson(source, 'Lite configuration')
  if (containsCredentialField(value)) throw new CliDiagnostic('Lite configuration must not contain plaintext credentials')
  try {
    return parseLiteConfig(value)
  } catch {
    throw new CliDiagnostic('invalid Lite configuration')
  }
}

interface CatalogData {
  packs: string[]
  plugins: { id: string; package: string }[]
  presets: Record<string, string[]>
}

function catalogPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  return resolve(moduleDir, moduleDir.endsWith(`${join('dist', 'src')}`) ? '../../catalog.json' : '../catalog.json')
}

export async function loadRegistry(path = catalogPath()): Promise<Registry> {
  const catalog = parseJson(await readText(path, 'Lite catalog'), 'Lite catalog') as Partial<CatalogData>
  if (!Array.isArray(catalog.packs) || !Array.isArray(catalog.plugins) || !catalog.presets || typeof catalog.presets !== 'object') {
    throw new CliDiagnostic('invalid Lite catalog')
  }
  const manifests = await Promise.all(catalog.packs.map(async (specifier) => {
    const manifest = await loadPackPackage(require.resolve(`${specifier}/package.json`))
    return [manifest.id, manifest] as const
  }))
  const plugins = await Promise.all(catalog.plugins.map(async ({ id, package: specifier }) => {
    if (typeof id !== 'string' || typeof specifier !== 'string') throw new CliDiagnostic('invalid Lite catalog')
    if (BUNDLED_PLUGIN_PACKAGES[id as keyof typeof BUNDLED_PLUGIN_PACKAGES] !== specifier) {
      throw new CliDiagnostic('invalid Lite catalog plugin mapping')
    }
    await validateCatalogPlugin(specifier)
    return [id, { id, package: specifier }] as const
  }))
  return {
    packs: Object.fromEntries(manifests.map(([id, manifest]) => [id, {
      id,
      dependencies: [],
      conflicts: manifest.conflicts,
      platforms: manifest.platforms,
      plugins: manifest.plugins,
      manifest,
    }])),
    plugins: Object.fromEntries(plugins),
    presets: Object.fromEntries(Object.entries(catalog.presets).map(([id, packs]) => [id, [...packs]])),
  }
}

interface CordisContext {
  registry: { resolve(plugin: unknown): Function | undefined }
  plugin(plugin: unknown, config?: unknown): { dispose(): void | Promise<void> } & PromiseLike<unknown>
  fiber: { dispose(): void | Promise<void> }
  tools?: unknown
  systemPrompt?: unknown
}

export async function validateCatalogPlugin(specifier: string, observeContext?: (context: CordisContext) => void): Promise<void> {
  let temporaryWorkspace: string | undefined
  let context: CordisContext | undefined
  try {
    const resolved = require.resolve(specifier)
    const cordisEntry = require.resolve('@deepseek-ai/cordis', { paths: [require.resolve('@dsh-lite/core')] })
    const toolsEntry = require.resolve('@deepseek-ai/dsh-tools', { paths: [require.resolve('@dsh-lite/runtime')] })
    const systemPromptEntry = require.resolve('@deepseek-ai/dsh-system-prompt', { paths: [require.resolve('@dsh-lite/runtime')] })
    const [{ Context }, { default: ToolRuntime }, { default: SystemPrompt }, module] = await Promise.all([
      import(pathToFileURL(cordisEntry).href) as Promise<{ Context: new () => CordisContext }>,
      import(pathToFileURL(toolsEntry).href) as Promise<{ default: unknown }>,
      import(pathToFileURL(systemPromptEntry).href) as Promise<{ default: unknown }>,
      import(pathToFileURL(resolved).href) as Promise<Record<string, unknown>>,
    ])
    const plugin = module.default ?? module
    context = new Context()
    observeContext?.(context)
    const callback = context.registry.resolve(plugin)
    const name = typeof plugin === 'function'
      ? plugin.name
      : typeof plugin === 'object' && plugin !== null && 'name' in plugin
        ? plugin.name
        : undefined
    const inject = typeof plugin === 'function' || (typeof plugin === 'object' && plugin !== null)
      ? Reflect.get(plugin, 'inject')
      : undefined
    if (!callback || typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(name)) {
      throw new Error('unsupported plugin export')
    }
    const services = Array.isArray(inject) ? inject : inject && typeof inject === 'object' ? Object.keys(inject) : []
    if (services.some((service) => service !== 'tools' && service !== 'systemPrompt')) throw new Error('plugin requires unsupported host services')
    if (services.includes('systemPrompt')) await context.plugin(SystemPrompt as never, { persona: '' } as never)
    if (services.includes('tools')) await context.plugin(ToolRuntime as never)
    const config = name === 'lite-workspace-notes'
      ? { workspace: temporaryWorkspace = await mkdtemp(join(tmpdir(), 'dsh-lite-plugin-validation-')) }
      : undefined
    const fiber = context.plugin(plugin, config)
    try {
      await fiber
    } finally {
      await fiber.dispose()
    }
  } catch {
    throw new CliDiagnostic('invalid Lite catalog plugin')
  } finally {
    await context?.fiber.dispose()
    if (temporaryWorkspace) await rm(temporaryWorkspace, { recursive: true, force: true })
  }
}

async function resolveConfig(config: ReturnType<typeof parseLiteConfig>, platform: Platform): Promise<ResolvedProfile> {
  try {
    const lock = await readUpstreamLock()
    if (config.upstream.channel !== lock.channel || config.upstream.version !== lock.harnessVersion) {
      throw new CliDiagnostic('unsupported upstream')
    }
    return resolveProfile(config, await loadRegistry(), platform)
  } catch (error) {
    if (error instanceof CliDiagnostic) throw error
    const message = error instanceof Error ? error.message : ''
    if (message.startsWith('unknown pack ')) throw new CliDiagnostic('Lite configuration references an unknown pack')
    if (message.startsWith('unknown plugin ')) throw new CliDiagnostic('Lite configuration references an unknown plugin')
    if (message.startsWith('duplicate pack ')) throw new CliDiagnostic('Lite configuration contains a duplicate pack')
    if (message.startsWith('duplicate plugin ')) throw new CliDiagnostic('Lite configuration contains a duplicate plugin')
    if (message.startsWith('pack dependency cycle ')) throw new CliDiagnostic('Lite configuration contains a pack dependency cycle')
    if (message.startsWith('pack ') && message.includes(' conflicts with ')) throw new CliDiagnostic('Lite configuration contains conflicting packs')
    if (message.startsWith('pack ') && message.includes(' does not support platform ')) {
      throw new CliDiagnostic('Lite configuration contains a pack unsupported on this platform')
    }
    throw new CliDiagnostic('invalid Lite configuration')
  }
}

function formatDiagnostic(error: unknown): string {
  return error instanceof CliDiagnostic ? error.message : 'Lite operation failed'
}

interface ValidatedHome {
  resolved: ResolvedProfile
  profileDir: string
  installed: ValidatedInstalledProfile
}

async function readHome(home: string, platform: Platform): Promise<ValidatedHome> {
  const current = await resolveCurrentTree(home).catch(() => { throw new CliDiagnostic('unable to read generated Lite state') })
  const config = parseConfig(await readText(join(current, 'lite.config.json'), 'Lite configuration'))
  const resolved = await resolveConfig(config, platform)
  const stored = parseJson(await readText(join(current, 'resolved.json'), 'generated Lite state'), 'generated Lite state')
  if (JSON.stringify(stored) !== JSON.stringify(resolved)) {
    throw new CliDiagnostic('stored Lite state does not match configuration')
  }
  const profile = await resolveCurrentTree(join(current, 'profile')).catch(() => { throw new CliDiagnostic('generated profile is not ready') })
  const installed = await validateInstalledProfile(profile, { expected: { platform, packIds: resolved.packIds } })
    .catch(() => { throw new CliDiagnostic('generated profile is not ready') })
  return { resolved, profileDir: installed.profileDir, installed }
}

async function doctorReport(
  home: string,
  workspace: string,
  platform: Platform,
  resolved: ResolvedProfile,
  installed: ValidatedInstalledProfile,
): Promise<unknown> {
  const nodeVersion = process.versions.node
  if (!isSupportedNodeVersion(nodeVersion)) throw new CliDiagnostic(`Node ${NODE_ENGINE} is required`)
  await access(home, constants.W_OK).catch(() => { throw new CliDiagnostic('Lite home is not writable') })
  await validateRuntimeCandidate(resolved, installed.profileDir, workspace, platform)
  return {
    schemaVersion: 1,
    status: 'ok',
    checks: {
      node: { status: 'pass', version: nodeVersion, engine: NODE_ENGINE, satisfies: true },
      home: { status: 'pass', writable: true },
      current: { status: 'pass', validated: true },
      profile: { status: 'pass', validated: true, closureId: installed.closureId },
      runtime: { status: 'pass', activated: true },
      secretHygiene: { status: 'pass', plaintextCredentials: false },
    },
  }
}

function inspectionReport(resolved: ResolvedProfile, installed: ValidatedInstalledProfile): unknown {
  return {
    schemaVersion: 1,
    identity: {
      profile: resolved.profile,
      closureId: installed.closureId,
      upstream: resolved.upstream,
    },
    platform: installed.platform,
    arch: installed.arch,
    packageNames: installed.packageNames,
    packageVersions: installed.packageVersions,
    cordisRows: installed.rows,
    packIds: resolved.packIds,
    pluginIds: resolved.pluginIds,
  }
}

type ValidateRuntimeCandidate = (resolved: ResolvedProfile, profileDir: string, workspace: string, platform: Platform) => Promise<void>

const validateRuntimeCandidate: ValidateRuntimeCandidate = async (resolved, profileDir, workspace, platform) => {
  const runtime = await bootRuntime({ profile: resolved, profileDir, platform, workspace })
  await runtime.dispose()
}

export async function initialize(
  configPath: string,
  home: string,
  platform: Platform,
  validateCandidate: ValidateRuntimeCandidate = validateRuntimeCandidate,
): Promise<void> {
  const config = parseConfig(await readText(configPath, 'Lite configuration'))
  const resolved = await resolveConfig(config, platform)
  await publishTree(home, async (candidate) => {
    await writeFile(join(candidate, 'lite.config.json'), `${JSON.stringify(config, null, 2)}\n`)
    await writeFile(join(candidate, 'resolved.json'), `${JSON.stringify(resolved, null, 2)}\n`)
    await materializeProfile(resolved, join(candidate, 'profile'), platform)
    await validateCandidate(resolved, await resolveCurrentTree(join(candidate, 'profile')), candidate, platform)
  })
}

export async function main(argv: string[], io: CliIo): Promise<number> {
  try {
    const args = parseArgs(argv)
    const home = resolveCliPath(io.cwd, args.home, io.platform)
    if (args.command === 'init') {
      await initialize(resolveCliPath(io.cwd, args.config, io.platform), home, io.platform)
      io.out(`initialized ${home}`)
      return 0
    }

    const { resolved, profileDir, installed } = await readHome(home, io.platform)
    if (args.command === 'run') {
      const runtime = await bootRuntime({ profile: resolved, profileDir, platform: io.platform, workspace: io.cwd })
      try {
        const result = await runTask(runtime, args.task)
        if (!result.completed) throw new CliDiagnostic('task did not complete')
        io.out(result.text)
      } finally {
        await runtime.dispose()
      }
    } else if (args.command === 'doctor') {
      io.out(JSON.stringify(await doctorReport(home, io.cwd, io.platform, resolved, installed), null, 2))
    }
    else io.out(JSON.stringify(redact(inspectionReport(resolved, installed)), null, 2))
    return 0
  } catch (error) {
    io.err(formatDiagnostic(error))
    return 1
  }
}
