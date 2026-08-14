import { chmod, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, resolve, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { load, dump } from 'js-yaml'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { resolveCorepackCommand } from './corepack.js'
import { isPathInside } from './path-containment.js'
import type { Platform } from './packs.js'
import { publishTree } from './transaction.js'

const DependencyVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'dependency versions must be exact')

export const PackManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  schemaVersion: z.literal(1),
  defaultEnabled: z.boolean(),
  platforms: z.array(z.enum(['darwin', 'linux', 'win32'])).min(1),
  dependencies: z.record(z.string(), DependencyVersionSchema),
  platformDependencies: z.record(z.enum(['darwin', 'linux', 'win32']), z.record(z.string(), DependencyVersionSchema)).optional(),
  plugins: z.array(z.string()),
  conflicts: z.array(z.string()),
  probes: z.array(z.discriminatedUnion('kind', [
    z.object({ id: z.string(), kind: z.literal('package'), target: z.string() }).strict(),
    z.object({
      id: z.string(),
      kind: z.literal('executable'),
      platforms: z.array(z.enum(['darwin', 'linux', 'win32'])).min(1),
      alternatives: z.array(z.string().min(1)).min(1),
    }).strict(),
  ])),
}).strict()

export type PackManifestData = z.infer<typeof PackManifestSchema>
export type PackManifest = PackManifestData & { cordisPatch: string }

const CordisRowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  disabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  platforms: z.array(z.enum(['darwin', 'linux', 'win32'])).optional(),
}).strict()

const CordisPatchSchema = z.object({ rows: z.array(CordisRowSchema) }).strict()
const GeneratedCordisSchema = z.array(CordisRowSchema)

export type CordisRow = z.infer<typeof CordisRowSchema>

export interface MaterializedProfile {
  packageNames: string[]
  rows: CordisRow[]
}

export interface CompatibilityProfile {
  id: string
  platform: Platform
  packs: string[]
  dependencies: Record<string, string>
  dependenciesSha256: string
  lock: string
  lockSha256: string
  rowsSha256: string
}

export interface ValidatedInstalledProfile {
  profileDir: string
  packageNames: string[]
  packageVersions: Record<string, string>
  rows: CordisRow[]
  platform: Platform
  arch: string
  closureId: string
  subprocessVerified: boolean
}

type MaterializableProfile = PackManifest[] | {
  manifests?: PackManifest[]
  upstream?: { channel: 'stable' | 'latest'; version: string }
}

export interface ValidationOptions {
  activate?: boolean
  prepareContext?(context: Context): Promise<void>
  probeExecutable?(alternatives: string[]): Promise<boolean>
  resolvePackage?(name: string): string
  resolveInstalledPackage?(profileDir: string, name: string): string
  install?(profileDir: string, args: string[]): Promise<void>
  runAuditedCommand?(file: string, args: string[], cwd: string): Promise<void>
  resolveTransitivePackage?(profileDir: string, parentName: string, childName: string): string
  expected?: { platform: Platform; arch?: string; packIds: string[] }
}

export const HOST_PACKAGES = [
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
] as const

const credentialKey = /(?:api[-_]?key|authorization|credential|password|secret|token)/i

function assertNoCredentials(value: unknown, path = 'config'): void {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (credentialKey.test(key)) throw new Error(`credential fields are not allowed in generated ${path}`)
    assertNoCredentials(child, `${path}.${key}`)
  }
}

export async function loadPackManifest(path: string): Promise<PackManifest> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    throw new Error('invalid pack manifest')
  }
  const result = PackManifestSchema.safeParse(parsed)
  if (!result.success) throw new Error('invalid pack manifest')
  return { ...result.data, cordisPatch: join(dirname(path), 'cordis.patch.yml') }
}

export async function loadPackPackage(packageJsonPath: string): Promise<PackManifest> {
  let metadata: unknown
  try {
    metadata = JSON.parse(await readFile(packageJsonPath, 'utf8')) as unknown
  } catch {
    throw new Error('invalid pack package metadata')
  }
  const result = z.object({
    name: z.string().regex(/^@dsh-lite\/pack-[a-z][a-z0-9-]*$/),
    dshLite: z.string().min(1),
  }).passthrough().safeParse(metadata)
  if (!result.success) throw new Error('invalid pack package metadata')
  const expectedId = result.data.name.slice('@dsh-lite/pack-'.length)
  const packageRoot = await realpath(dirname(packageJsonPath))
  const manifestPath = await realpath(resolve(packageRoot, result.data.dshLite))
  if (!isPathInside(packageRoot, manifestPath)) throw new Error('pack manifest is not contained in package')
  const manifest = await loadPackManifest(manifestPath)
  if (manifest.id !== expectedId) throw new Error('pack manifest id does not match package metadata')
  return manifest
}

export function resolveForPlatform(manifest: PackManifest, platform: string): PackManifest {
  if (!manifest.platforms.includes(platform as Platform)) {
    throw new Error(`unsupported platform "${platform}" for pack "${manifest.id}"`)
  }
  return manifest
}

async function loadRows(manifest: PackManifest): Promise<CordisRow[]> {
  let parsed: unknown
  try {
    parsed = load(await readFile(manifest.cordisPatch, 'utf8'))
  } catch {
    throw new Error(`invalid Cordis patch for pack "${manifest.id}"`)
  }
  const result = CordisPatchSchema.safeParse(parsed)
  if (!result.success) throw new Error(`invalid Cordis patch for pack "${manifest.id}"`)
  return result.data.rows
}

const execFileAsync = promisify(execFile)
const FROZEN_INSTALL_ARGS = ['install', '--ignore-workspace', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile', '--config.confirmModulesPurge=false']

async function installProfile(profileDir: string, args: string[]): Promise<void> {
  const command = await resolveCorepackCommand(['pnpm@10.15.0', ...args])
  await execFileAsync(command.file, command.args, { cwd: profileDir, env: { ...process.env, COREPACK_ENABLE_PROJECT_SPEC: '0' } })
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const canonicalDependencies = (value: Record<string, string>): string => `${JSON.stringify(Object.fromEntries(Object.entries(value).sort()), null, 2)}\n`
const canonicalRows = (value: CordisRow[]): string => `${JSON.stringify(value)}\n`
const COMPATIBILITY_PACK_ORDER = ['workspace', 'shell', 'research'] as const
const compareCompatibilityPacks = (a: string, b: string): number => {
  const aIndex = COMPATIBILITY_PACK_ORDER.indexOf(a as typeof COMPATIBILITY_PACK_ORDER[number])
  const bIndex = COMPATIBILITY_PACK_ORDER.indexOf(b as typeof COMPATIBILITY_PACK_ORDER[number])
  if (aIndex !== bIndex) return (aIndex < 0 ? COMPATIBILITY_PACK_ORDER.length : aIndex) - (bIndex < 0 ? COMPATIBILITY_PACK_ORDER.length : bIndex)
  return a.localeCompare(b)
}

function compatibilityRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  return resolve(moduleDir, moduleDir.endsWith(join('dist', 'src')) ? '../../compat/0.1.0-rc.6' : '../compat/0.1.0-rc.6')
}

export async function readCompatibilityProfile(platform: Platform, packs: string[]): Promise<CompatibilityProfile> {
  const source = z.object({
    schemaVersion: z.literal(1),
    generator: z.object({
      pnpm: z.literal('10.15.0'),
      packOrder: z.tuple([z.literal('workspace'), z.literal('shell'), z.literal('research')]),
      platforms: z.tuple([z.literal('darwin'), z.literal('linux'), z.literal('win32')]),
    }).strict(),
    upstream: z.object({ channel: z.literal('stable'), version: z.literal('0.1.0-rc.6') }).strict(),
    variants: z.array(z.object({
    id: z.string(),
    platform: z.enum(['darwin', 'linux', 'win32']),
    packs: z.array(z.string()),
    dependencies: z.record(z.string(), DependencyVersionSchema),
    dependenciesSha256: z.string().regex(/^[0-9a-f]{64}$/),
    lock: z.string().regex(/^locks\/[a-z0-9+-]+\.yaml$/),
    lockSha256: z.string().regex(/^[0-9a-f]{64}$/),
    rowsSha256: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict()),
  }).strict().parse(JSON.parse(await readFile(join(compatibilityRoot(), 'closures.json'), 'utf8')))
  const variants = source.variants
  const normalized = [...packs].sort(compareCompatibilityPacks)
  const selected = variants.find((variant) => variant.platform === platform && JSON.stringify(variant.packs) === JSON.stringify(normalized))
  if (!selected) throw new Error('selected capability combination has no committed compatibility profile')
  if (sha256(canonicalDependencies(selected.dependencies)) !== selected.dependenciesSha256) throw new Error('compatibility dependency metadata failed integrity validation')
  const lockSource = await readFile(join(compatibilityRoot(), selected.lock), 'utf8')
  if (sha256(lockSource) !== selected.lockSha256) throw new Error('compatibility lock template failed integrity validation')
  return selected
}

export interface ProbeEnvironment {
  path?: string
  pathExt?: string
  access?: typeof access
}

export async function probeExecutable(alternatives: string[], platform: Platform, environment: ProbeEnvironment = {}): Promise<boolean> {
  const pathApi = platform === 'win32' ? win32 : await import('node:path')
  const separator = platform === 'win32' ? ';' : pathApi.delimiter
  const suffixes = platform === 'win32' ? (environment.pathExt ?? process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  const check = environment.access ?? access
  for (const directory of (environment.path ?? process.env.PATH ?? '').split(separator)) {
    for (const alternative of alternatives) {
      for (const suffix of suffixes) {
        try {
          await check(pathApi.join(directory, `${alternative}${suffix}`))
          return true
        } catch {}
      }
    }
  }
  return false
}

async function activateCordis(path: string, rows: CordisRow[], resolvedPackages: Map<string, string>, options: ValidationOptions): Promise<void> {
  const validationPath = join(dirname(path), `.activation-${crypto.randomUUID()}.yml`)
  const validationRows = rows.map((row) => ({
    ...row,
    name: pathToFileURL(resolvedPackages.get(row.name)!).href,
  }))
  const context = new Context()
  try {
    await writeFile(validationPath, dump(validationRows, { schema: entryListSchema, noRefs: true, sortKeys: false, lineWidth: -1 }))
    if (options.prepareContext) await options.prepareContext(context)
    else {
      for (const name of HOST_PACKAGES) {
        const module = await import(pathToFileURL(resolvedPackages.get(name)!).href)
        const plugin = module.default ?? module
        await context.plugin(plugin, name === '@deepseek-ai/dsh-system-prompt' ? { persona: '' } : undefined)
      }
    }
    await context.plugin(Loader, { baseUrl: import.meta.url })
    await context.plugin(Include, { path: pathToFileURL(validationPath).href })
    await context.loader.await()
  } finally {
    try {
      await context.fiber.dispose()
    } finally {
      await rm(validationPath, { force: true })
    }
  }
}

async function resolveProfilePackage(profileDir: string, name: string): Promise<{ entry: string; packageRoot: string; version: string }> {
  const nodeModules = await realpath(join(profileDir, 'node_modules'))
  const entry = await realpath(createRequire(join(profileDir, 'package.json')).resolve(name))
  if (!isPathInside(nodeModules, entry)) throw new Error(`dependency "${name}" did not resolve profile-local`)
  let directory = dirname(entry)
  while (true) {
    const manifestPath = join(directory, 'package.json')
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: unknown; version?: unknown }
      if (manifest.name === name && typeof manifest.version === 'string') {
        const packageRoot = await realpath(directory)
        if (!isPathInside(nodeModules, packageRoot)) throw new Error(`dependency "${name}" did not resolve profile-local`)
        return { entry, packageRoot, version: manifest.version }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(directory)
    if (parent === directory || directory === nodeModules) throw new Error(`unable to inspect installed dependency "${name}"`)
    directory = parent
  }
}

async function repairSpawnHelpers(profileDir: string): Promise<void> {
  const nodeModules = await realpath(join(profileDir, 'node_modules'))
  const subprocessEntry = (await resolveProfilePackage(profileDir, '@deepseek-ai/dsh-subprocess-local')).entry
  const entry = await realpath(createRequire(subprocessEntry).resolve('node-pty'))
  let packageRoot = dirname(entry)
  while (packageRoot !== nodeModules) {
    try {
      const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { name?: unknown }
      if (manifest.name === 'node-pty') break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    packageRoot = dirname(packageRoot)
  }
  if (packageRoot === nodeModules || !isPathInside(nodeModules, packageRoot)) {
    throw new Error('node-pty did not resolve profile-local')
  }
  const prebuilds = join(packageRoot, 'prebuilds')
  for (const entry of await readdir(prebuilds, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const helper = join(prebuilds, entry.name, 'spawn-helper')
    try {
      const mode = (await stat(helper)).mode
      await chmod(helper, mode | 0o111)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

async function resolveTransitivePackage(profileDir: string, parentName: string, childName: string, options: ValidationOptions = {}): Promise<{ entry: string; packageRoot: string }> {
  const nodeModules = await realpath(join(profileDir, 'node_modules'))
  const parentEntry = (await resolveProfilePackage(profileDir, parentName)).entry
  const entry = await realpath(options.resolveTransitivePackage?.(profileDir, parentName, childName) ?? createRequire(parentEntry).resolve(childName))
  if (!isPathInside(nodeModules, entry)) throw new Error(`transitive dependency "${childName}" did not resolve profile-local`)
  let packageRoot = dirname(entry)
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { name?: unknown }
      if (manifest.name === childName) break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(packageRoot)
    if (parent === packageRoot) throw new Error(`unable to inspect installed transitive dependency "${childName}"`)
    packageRoot = parent
  }
  if (!isPathInside(nodeModules, await realpath(packageRoot))) throw new Error(`transitive dependency "${childName}" did not resolve profile-local`)
  return { entry, packageRoot }
}

async function prepareNodePty(profileDir: string, platform: Platform, options: ValidationOptions): Promise<void> {
  const { packageRoot } = await resolveTransitivePackage(profileDir, '@deepseek-ai/dsh-subprocess-local', 'node-pty', options)
  const run = options.runAuditedCommand ?? (async (file: string, args: string[], cwd: string) => {
    const command = file === 'corepack' ? await resolveCorepackCommand(args) : { file, args }
    await execFileAsync(command.file, command.args, { cwd })
  })
  if (platform === 'linux' && (process.platform === 'linux' || options.runAuditedCommand)) {
    const prebuild = join(packageRoot, 'prebuilds', `${platform}-${process.arch}`, 'pty.node')
    const built = join(packageRoot, 'build', 'Release', 'pty.node')
    const hasNative = await access(prebuild).then(() => true, () => access(built).then(() => true, () => false))
    if (!hasNative) {
      await run('corepack', ['pnpm@10.15.0', '--ignore-workspace', 'rebuild', 'node-pty', '--dir', profileDir], profileDir)
      await access(built).catch(() => { throw new Error('audited node-pty build did not produce a native module') })
    }
  }
  const subprocess = await resolveProfilePackage(profileDir, '@deepseek-ai/dsh-subprocess-local')
  await run(process.execPath, [join(subprocess.packageRoot, 'scripts', 'ensure-spawn-helper.mjs')], profileDir)
  if (!options.runAuditedCommand) await repairSpawnHelpers(profileDir)
}

async function validateSpawnHelpers(profileDir: string, options: ValidationOptions): Promise<void> {
  const { packageRoot } = await resolveTransitivePackage(profileDir, '@deepseek-ai/dsh-subprocess-local', 'node-pty', options)
  let helpers = 0
  for (const entry of await readdir(join(packageRoot, 'prebuilds'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const helper = join(packageRoot, 'prebuilds', entry.name, 'spawn-helper')
    try {
      await access(helper, 1)
      helpers++
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('installed node-pty spawn-helper is not executable')
    }
  }
  if (!helpers) throw new Error('installed node-pty spawn-helper is unavailable')
}

async function verifySubprocess(profileDir: string, resolvedPackages: Map<string, string>): Promise<void> {
  const context = new Context()
  try {
    const module = await import(pathToFileURL(resolvedPackages.get('@deepseek-ai/dsh-subprocess-local')!).href)
    await context.plugin(module.default ?? module)
    const service = (context as Context & { subprocess: {
      spawn(spec: {
        argv: string[]
        cwd: string
        stdio: { stdin: 'ignore'; stdout: { maxBytes: number }; stderr: { maxBytes: number } }
        graceMs: number
      }): {
        done: Promise<{ exitCode: number | null }>
        collected: { stdout?: { readFrom(offset: number): { text: string } } }
      }
    } }).subprocess
    const handle = service.spawn({
      argv: [process.execPath, '-e', 'process.stdout.write("dsh-lite-ready")'],
      cwd: profileDir,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
      graceMs: 1000,
    })
    const outcome = await handle.done
    if (outcome.exitCode !== 0 || handle.collected.stdout?.readFrom(0).text !== 'dsh-lite-ready') {
      throw new Error('installed subprocess provider failed readiness probe')
    }
  } finally {
    await context.fiber.dispose()
  }
}

export async function validateInstalledProfile(profileDir: string, options: ValidationOptions = {}): Promise<ValidatedInstalledProfile> {
  const state = JSON.parse(await readFile(join(profileDir, 'profile-state.json'), 'utf8')) as unknown
  const parsedState = z.object({
    state: z.literal('ready'),
    frozenInstall: z.literal(true),
    activated: z.literal(true),
    platform: z.enum(['darwin', 'linux', 'win32']),
    arch: z.string().min(1),
    closureId: z.string(),
  }).strict().parse(state)
  if (parsedState.arch !== process.arch) throw new Error('installed profile architecture does not match runtime architecture')
  const compatibility = await readCompatibilityProfile(parsedState.platform, parsedState.closureId.split('-').slice(1).join('-') === 'chat-only'
    ? []
    : parsedState.closureId.slice(parsedState.platform.length + 1).split('+'))
  if (compatibility.id !== parsedState.closureId) throw new Error('installed profile closure identity is invalid')
  if (options.expected) {
    const expected = await readCompatibilityProfile(options.expected.platform, options.expected.packIds)
    if (expected.id !== compatibility.id) throw new Error('installed profile closure does not match resolved configuration')
    if (parsedState.arch !== (options.expected.arch ?? process.arch)) throw new Error('installed profile architecture does not match runtime architecture')
  }
  const packageJson = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as unknown
  const parsedPackage = z.object({
    name: z.literal('@dsh-lite/generated-profile'),
    private: z.literal(true),
    type: z.literal('module'),
    dependencies: z.record(z.string(), DependencyVersionSchema),
    pnpm: z.object({
      supportedArchitectures: z.object({ os: z.array(z.enum(['darwin', 'linux', 'win32'])).length(1), cpu: z.array(z.string()).length(1) }).strict(),
      onlyBuiltDependencies: z.tuple([z.literal('node-pty')]).optional(),
    }).strict(),
  }).strict().parse(packageJson)
  if (parsedPackage.pnpm.supportedArchitectures.os[0] !== compatibility.platform) throw new Error('installed package platform does not match compatibility closure')
  if (parsedPackage.pnpm.supportedArchitectures.cpu[0] !== parsedState.arch) throw new Error('installed package architecture does not match profile state')
  const expectsNodePtyBuild = compatibility.platform === 'linux' && compatibility.dependencies['@deepseek-ai/dsh-subprocess-local'] !== undefined
  if (expectsNodePtyBuild !== (parsedPackage.pnpm.onlyBuiltDependencies?.[0] === 'node-pty')) throw new Error('installed native build allowlist does not match compatibility closure')
  if (sha256(canonicalDependencies(parsedPackage.dependencies)) !== compatibility.dependenciesSha256) throw new Error('installed package manifest does not match compatibility closure')
  const installedLock = await readFile(join(profileDir, 'pnpm-lock.yaml'), 'utf8')
  if (sha256(installedLock) !== compatibility.lockSha256) throw new Error('installed lock does not match compatibility template')
  const resolvedPackages = new Map<string, string>()
  for (const [name, version] of Object.entries(compatibility.dependencies)) {
    const installed = await resolveProfilePackage(profileDir, name)
    if (installed.version !== version) throw new Error(`installed dependency "${name}" has an incompatible version`)
    resolvedPackages.set(name, installed.entry)
  }
  const rows = GeneratedCordisSchema.parse(load(await readFile(join(profileDir, 'cordis.yml'), 'utf8'), { schema: entryListSchema }))
  if (sha256(canonicalRows(rows)) !== compatibility.rowsSha256) throw new Error('installed Cordis rows do not match compatibility profile')
  for (const row of rows) if (!resolvedPackages.has(row.name)) throw new Error(`Cordis entry "${row.id}" references an undeclared dependency`)
  if (options.activate !== false) await activateCordis(join(profileDir, 'cordis.yml'), rows, resolvedPackages, options)
  const subprocessVerified = resolvedPackages.has('@deepseek-ai/dsh-subprocess-local')
  if (subprocessVerified) await validateSpawnHelpers(profileDir, options)
  if (subprocessVerified && options.activate !== false) await verifySubprocess(profileDir, resolvedPackages)
  return {
    profileDir,
    packageNames: Object.keys(compatibility.dependencies).sort(),
    packageVersions: compatibility.dependencies,
    rows,
    platform: parsedState.platform,
    arch: parsedState.arch,
    closureId: compatibility.id,
    subprocessVerified,
  }
}

export async function validateGeneratedProfile(
  profileDir: string,
  platform: Platform,
  options: ValidationOptions = {},
  probes: PackManifest['probes'] = [],
): Promise<void> {
  const packageJson = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  if (!packageJson.dependencies || typeof packageJson.dependencies !== 'object') throw new Error('invalid generated package manifest')
  const lock = await readUpstreamLock()
  const resolvePackage = options.resolvePackage ?? (options.resolveInstalledPackage
    ? (name) => options.resolveInstalledPackage!(profileDir, name)
    : (name) => createRequire(join(profileDir, 'package.json')).resolve(name))
  const resolvedPackages = new Map<string, string>()
  for (const [name, version] of Object.entries(packageJson.dependencies)) {
    if (lock.packages[name] !== version) throw new Error(`dependency "${name}" does not match the compatibility lock`)
    resolvedPackages.set(name, resolvePackage(name))
  }
  const source = await readFile(join(profileDir, 'cordis.yml'), 'utf8')
  const rows = load(source, { schema: entryListSchema })
  const generatedRows = GeneratedCordisSchema.parse(rows)
  for (const row of generatedRows) {
    if (!resolvedPackages.has(row.name)) throw new Error(`Cordis entry "${row.id}" references an undeclared dependency`)
  }
  for (const probe of probes) {
    if (probe.kind === 'package') resolvePackage(probe.target)
    else if (probe.platforms.includes(platform)) {
      const available = await (options.probeExecutable ?? ((alternatives) => probeExecutable(alternatives, platform)))(probe.alternatives)
      if (!available) throw new Error(`probe "${probe.id}" failed`)
    }
  }
  if (options.activate !== false) await activateCordis(join(profileDir, 'cordis.yml'), generatedRows, resolvedPackages, options)
}

export async function readUpstreamLock(): Promise<{ channel: string; harnessVersion: string; packages: Record<string, string> }> {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [resolve(moduleDir, '../compat/upstream-lock.json'), resolve(moduleDir, '../../compat/upstream-lock.json')]
  let source: string | undefined
  for (const candidate of candidates) {
    try {
      source = await readFile(candidate, 'utf8')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (!source) throw new Error('compatibility lock asset is unavailable')
  return JSON.parse(source) as {
    channel: string
    harnessVersion: string
    packages: Record<string, string>
  }
}

export async function materializeProfile(
  profile: MaterializableProfile,
  targetDir: string,
  platform: Platform = process.platform as Platform,
  options: ValidationOptions = {},
): Promise<MaterializedProfile> {
  const suppliedManifests = Array.isArray(profile) ? profile : profile.manifests
  if (!suppliedManifests) throw new Error('resolved profile does not include pack manifests')
  const manifests = [...suppliedManifests].sort((a, b) => compareCompatibilityPacks(a.id, b.id))
  if (new Set(manifests.map((manifest) => manifest.id)).size !== manifests.length) throw new Error('resolved profile includes duplicate pack manifests')
  const lock = await readUpstreamLock()
  const upstream = Array.isArray(profile) ? { channel: lock.channel, version: lock.harnessVersion } : profile.upstream
  if (!upstream || upstream.channel !== lock.channel || upstream.version !== lock.harnessVersion) {
    throw new Error('selected upstream version is not supported by the compatibility lock')
  }

  const declaredDependencies: Record<string, string> = {}
  const rows: CordisRow[] = []
  const probes: PackManifest['probes'] = []
  const rowIds = new Set<string>()
  for (const manifest of manifests) {
    resolveForPlatform(manifest, platform)
    probes.push(...manifest.probes)
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      if (name === '@deepseek-ai/dsh') throw new Error('aggregate DeepSeek Harness package is not allowed')
      if (lock.packages[name] !== version) throw new Error(`dependency "${name}" does not match the compatibility lock`)
      if (declaredDependencies[name] && declaredDependencies[name] !== version) throw new Error(`conflicting dependency version for "${name}"`)
      declaredDependencies[name] = version
    }
    for (const [name, version] of Object.entries(manifest.platformDependencies?.[platform] ?? {})) {
      if (name === '@deepseek-ai/dsh') throw new Error('aggregate DeepSeek Harness package is not allowed')
      if (lock.packages[name] !== version) throw new Error(`dependency "${name}" does not match the compatibility lock`)
      if (declaredDependencies[name] && declaredDependencies[name] !== version) throw new Error(`conflicting dependency version for "${name}"`)
      declaredDependencies[name] = version
    }
    for (const row of await loadRows(manifest)) {
      if (row.platforms && !row.platforms.includes(platform)) continue
      if (rowIds.has(row.id)) {
        const existing = rows.find((candidate) => candidate.id === row.id)
        const { platforms: _, ...officialRow } = row
        if (JSON.stringify(existing) === JSON.stringify(officialRow)) continue
        throw new Error(`duplicate Cordis row "${row.id}"`)
      }
      assertNoCredentials(row.config)
      rowIds.add(row.id)
      const { platforms: _, ...officialRow } = row
      rows.push(officialRow)
    }
  }

  const compatibility = await readCompatibilityProfile(platform, manifests.map((manifest) => manifest.id))
  const dependencies = compatibility.dependencies
  for (const [name, version] of Object.entries(declaredDependencies)) {
    if (dependencies[name] !== version) throw new Error(`declared dependency "${name}" is absent from the committed compatibility closure`)
  }
  for (const row of rows) if (!dependencies[row.name]) throw new Error(`Cordis dependency "${row.name}" is absent from the committed compatibility closure`)
  for (const probe of probes) if (probe.kind === 'package' && !dependencies[probe.target]) {
    throw new Error(`probe dependency "${probe.target}" is absent from the committed compatibility closure`)
  }
  const packageNames = Object.keys(dependencies).sort()
  const packageJson = {
    name: '@dsh-lite/generated-profile',
    private: true,
    type: 'module',
    dependencies: Object.fromEntries(packageNames.map((name) => [name, dependencies[name]])),
    pnpm: {
      supportedArchitectures: { os: [platform], cpu: [process.arch] },
      ...(platform === 'linux' && dependencies['@deepseek-ai/dsh-subprocess-local'] ? { onlyBuiltDependencies: ['node-pty'] } : {}),
    },
  }
  const cordis = GeneratedCordisSchema.parse(rows)
  const target = resolve(targetDir)
  await publishTree(target, async (candidate) => {
    await writeFile(join(candidate, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`)
    await writeFile(join(candidate, 'cordis.yml'), dump(cordis, { schema: entryListSchema, noRefs: true, sortKeys: false, lineWidth: -1 }))
    await writeFile(join(candidate, 'pnpm-lock.yaml'), await readFile(join(compatibilityRoot(), compatibility.lock), 'utf8'))
    GeneratedCordisSchema.parse(load(await readFile(join(candidate, 'cordis.yml'), 'utf8'), { schema: entryListSchema }))
    JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'))
    await (options.install ?? installProfile)(candidate, FROZEN_INSTALL_ARGS)
    await access(join(candidate, 'pnpm-lock.yaml')).catch(() => { throw new Error('generated profile install did not produce an exact lock') })
    if (dependencies['@deepseek-ai/dsh-subprocess-local'] && (!options.install || options.runAuditedCommand)) await prepareNodePty(candidate, platform, options)
    await validateGeneratedProfile(candidate, platform, options, probes)
    if (dependencies['@deepseek-ai/dsh-subprocess-local'] && options.activate !== false) {
      const resolved = new Map<string, string>()
      for (const name of packageNames) resolved.set(name, (await resolveProfilePackage(candidate, name)).entry)
      await verifySubprocess(candidate, resolved)
    }
    await writeFile(join(candidate, 'profile-state.json'), `${JSON.stringify({
      state: 'ready',
      frozenInstall: true,
      activated: options.activate !== false,
      platform,
      arch: process.arch,
      closureId: compatibility.id,
    })}\n`)
  })
  return { packageNames, rows }
}
