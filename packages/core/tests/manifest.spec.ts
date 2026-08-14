import { execFile } from 'node:child_process'
import { access, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import {
  loadPackManifest,
  loadPackPackage,
  materializeProfile,
  probeExecutable,
  readCompatibilityProfile,
  resolveForPlatform,
  validateInstalledProfile,
  type PackManifest,
} from '../src/manifest.js'
import { resolveCurrentTree } from '../src/transaction.js'
import { validateGeneratedProfile } from '../src/manifest.js'

const packPath = (id: string): string => resolve(`packages/packs/${id}/pack.json`)
const upstreamLockPath = resolve('compat/upstream-lock.json')
const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const nativePlatform = process.platform as 'darwin' | 'linux' | 'win32'
const nativeShellRows = nativePlatform === 'win32'
  ? ['subprocess', 'sandbox', 'sandbox-policy', 'shell-env', 'pwsh-sandbox', 'tool-pwsh']
  : ['subprocess', 'sandbox', 'sandbox-policy', 'shell-env', 'bash-sandbox', 'tool-bash']
const coreClosure = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-code-runtime',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-persistence',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-timeout',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-user-approval',
  '@deepseek-ai/schemastery',
]

const loadBundled = async (): Promise<Record<string, PackManifest>> => {
  const entries = await Promise.all(['workspace', 'shell', 'research'].map(async (id) => [id, await loadPackManifest(packPath(id))] as const))
  return Object.fromEntries(entries)
}

describe('pack manifests', () => {
  it('discovers manifests through package dshLite metadata and validates their ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-package-'))
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@dsh-lite/pack-example', dshLite: './metadata/custom.json' }))
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(root, 'metadata')))
    const manifest = { id: 'example', schemaVersion: 1, defaultEnabled: false, platforms: ['linux'], dependencies: {}, plugins: ['example-plugin'], conflicts: [], probes: [] }
    await writeFile(join(root, 'metadata/custom.json'), JSON.stringify(manifest))
    await writeFile(join(root, 'metadata/cordis.patch.yml'), 'rows: []\n')

    await expect(loadPackPackage(join(root, 'package.json'))).resolves.toMatchObject({ id: 'example', plugins: ['example-plugin'] })
    await writeFile(join(root, 'metadata/custom.json'), JSON.stringify({ ...manifest, id: 'other' }))
    await expect(loadPackPackage(join(root, 'package.json'))).rejects.toThrow('manifest id')
  })

  it('rejects dshLite metadata that escapes through a symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-package-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-lite-package-outside-'))
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@dsh-lite/pack-example', dshLite: './manifest.json' }))
    await writeFile(join(outside, 'manifest.json'), JSON.stringify({ id: 'example' }))
    await import('node:fs/promises').then(({ symlink }) => symlink(join(outside, 'manifest.json'), join(root, 'manifest.json')))
    await expect(loadPackPackage(join(root, 'package.json'))).rejects.toThrow('contained')
  })

  it('uses injected Windows PATH, PATHEXT, and access semantics for executable probes', async () => {
    const attempted: string[] = []
    await expect(probeExecutable(['pwsh'], 'win32', {
      path: 'C:\\Tools;D:\\Bin',
      pathExt: '.EXE;.CMD',
      access: async (path) => {
        attempted.push(String(path))
        if (String(path) === 'D:\\Bin\\pwsh.CMD') return
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
    })).resolves.toBe(true)
    expect(attempted).toContain('D:\\Bin\\pwsh.CMD')
  })

  it('loads declarative manifests with exact upstream-lock versions and defaults', async () => {
    const manifests = await loadBundled()
    const upstreamLock = JSON.parse(await readFile(upstreamLockPath, 'utf8')) as { packages: Record<string, string> }

    expect(manifests.workspace?.defaultEnabled).toBe(true)
    expect(manifests.shell?.defaultEnabled).toBe(false)
    expect(manifests.research?.defaultEnabled).toBe(false)
    for (const manifest of Object.values(manifests)) {
      expect(manifest.dependencies).toEqual(expect.objectContaining(
        Object.fromEntries(Object.keys(manifest.dependencies).map((name) => [name, upstreamLock.packages[name]])),
      ))
      expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh')
    }
  })

  it('keeps Windows metadata while refusing an unsupported platform', async () => {
    const manifests = await loadBundled()

    expect(() => resolveForPlatform(manifests.shell!, 'win32')).not.toThrow()
    expect(() => resolveForPlatform(manifests.research!, 'freebsd')).toThrow('unsupported platform')
    expect(manifests.shell?.probes).toContainEqual({ kind: 'executable', id: 'shell', platforms: ['win32'], alternatives: ['pwsh'] })
  })

  it.each([
    ['workspace', 'linux', []],
    ['shell', nativePlatform, nativeShellRows],
    ['research', 'linux', []],
  ] as const)('materializes the operational %s closure for %s', async (id, platform, expectedRows) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-packs-'))
    const manifest = await loadPackManifest(packPath(id))
    const result = await materializeProfile([manifest], join(root, 'generated'), platform, {
      probeExecutable: async () => true,
      activate: false,
    })
    expect(result.rows.map((row) => row.id)).toEqual(expectedRows)
    await expect(validateGeneratedProfile(await resolveCurrentTree(join(root, 'generated')), platform, {
      probeExecutable: async () => true,
      activate: false,
    })).resolves.toBeUndefined()
  }, 30_000)

  it('runs structured probes and refuses publication when one fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-packs-'))
    const manifest = await loadPackManifest(packPath('shell'))
    const target = join(root, 'generated')
    await expect(materializeProfile([manifest], target, 'win32', {
      probeExecutable: async (alternatives) => alternatives.includes('pwsh') ? false : true,
      activate: false,
    })).rejects.toThrow('probe')
    await expect(access(join(target, 'current.json'))).rejects.toThrow()
  })

  it.each(['workspace', 'shell', 'research'] as const)('activates the generated %s profile through official Loader and Include', async (id) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-packs-'))
    const manifest = await loadPackManifest(packPath(id))
    const target = join(root, 'generated')
    await expect(materializeProfile([manifest], target, nativePlatform, {
      probeExecutable: async () => true,
    })).resolves.toMatchObject({ rows: expect.any(Array) })
    const current = await resolveCurrentTree(target)
    expect(JSON.parse(await readFile(join(current, 'profile-state.json'), 'utf8'))).toMatchObject({
      state: 'ready', frozenInstall: true, activated: true, platform: nativePlatform, arch: process.arch,
    })
    await expect(access(join(current, 'pnpm-lock.yaml'))).resolves.toBeUndefined()
    await expect(access(join(current, 'node_modules'))).resolves.toBeUndefined()
    expect((await readdir(current)).some((name) => name.startsWith('.activation-'))).toBe(false)
  }, 30_000)

  it('derives exact peer closure from installed package metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-packs-'))
    const workspace = await loadPackManifest(packPath('workspace'))
    const target = join(root, 'generated')
    const result = await materializeProfile([workspace], target, 'darwin', {
      activate: false,
      install: async (candidate) => writeFile(join(candidate, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n'),
    })
    expect(result.packageNames).toEqual(coreClosure)
  })

  it('selects a committed closure containing every declared dependency without ambient package resolution', async () => {
    const workspace = await loadPackManifest(packPath('workspace'))
    const compatibility = await readCompatibilityProfile('darwin', ['workspace'])

    expect(compatibility.dependencies).toMatchObject(workspace.dependencies)
    expect(compatibility.dependencies).toHaveProperty('@deepseek-ai/dsh-agent-loop')
    expect(compatibility.lockSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('copies an integrity-pinned committed lock and runs only a frozen install', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-packs-'))
    const workspace = await loadPackManifest(packPath('workspace'))
    const invocations: string[][] = []

    await materializeProfile([workspace], join(root, 'generated'), 'darwin', {
      activate: false,
      install: async (candidate, args) => {
        invocations.push(args)
        await mkdir(join(candidate, 'node_modules'), { recursive: true })
      },
      resolveInstalledPackage: (_profile, name) => require.resolve(name),
    })

    expect(invocations).toEqual([['install', '--ignore-workspace', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile', '--config.confirmModulesPurge=false']])
  })

  it('rejects modified locks and ancestor package fallback in installed profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-installed-'))
    const workspace = await loadPackManifest(packPath('workspace'))
    const target = join(root, 'generated')
    await materializeProfile([workspace], target, 'darwin')
    const profile = await resolveCurrentTree(target)

    await writeFile(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    await expect(validateInstalledProfile(profile, { expected: { platform: 'darwin', packIds: ['workspace'] } })).rejects.toThrow('lock')

    const valid = await materializeProfile([workspace], join(root, 'valid'), 'darwin')
    expect(valid.packageNames).toEqual(coreClosure)
    const validProfile = await resolveCurrentTree(join(root, 'valid'))
    await rm(join(validProfile, 'node_modules', '@deepseek-ai', 'dsh-tools'), { recursive: true, force: true })
    await expect(validateInstalledProfile(validProfile, { expected: { platform: 'darwin', packIds: ['workspace'] } })).rejects.toThrow('profile-local')
  })

  it('binds installed closure identity and exact Cordis rows to the resolved profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-binding-'))
    const workspace = await loadPackManifest(packPath('workspace'))
    await materializeProfile([workspace], join(root, 'workspace'), 'darwin')
    const profile = await resolveCurrentTree(join(root, 'workspace'))

    await expect(validateInstalledProfile(profile, { expected: { platform: 'darwin', packIds: [] } })).rejects.toThrow('closure')
    await expect(validateInstalledProfile(profile, { expected: { platform: 'linux', packIds: ['workspace'] } })).rejects.toThrow('closure')
    await expect(validateInstalledProfile(profile, { expected: { platform: 'darwin', arch: 'not-this-arch', packIds: ['workspace'] } }))
      .rejects.toThrow('architecture')
    await writeFile(join(profile, 'cordis.yml'), '- id: injected\n  name: "@deepseek-ai/dsh-tools"\n')
    await expect(validateInstalledProfile(profile, { expected: { platform: 'darwin', packIds: ['workspace'] } })).rejects.toThrow('Cordis')
  })

  it('rejects transitive node-pty resolution outside profile node_modules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-node-pty-containment-'))
    const shell = await loadPackManifest(packPath('shell'))
    await materializeProfile([shell], join(root, 'shell'), nativePlatform)
    const profile = await resolveCurrentTree(join(root, 'shell'))
    const ancestorNodePty = createRequire(resolve('packages/core/package.json')).resolve('node-pty')
    await expect(validateInstalledProfile(profile, {
      expected: { platform: nativePlatform, packIds: ['shell'] },
      resolveTransitivePackage: () => ancestorNodePty,
    })).rejects.toThrow('node-pty')
  }, 30_000)

  it('uses platform-minimal shell closures', async () => {
    const darwin = await readCompatibilityProfile('darwin', ['shell'])
    const linux = await readCompatibilityProfile('linux', ['shell'])
    const windows = await readCompatibilityProfile('win32', ['shell'])
    for (const unix of [darwin, linux]) {
      expect(Object.keys(unix.dependencies).some((name) => /pwsh/.test(name))).toBe(false)
      expect(Object.keys(unix.dependencies)).toEqual(expect.arrayContaining(['@deepseek-ai/dsh-bash-sandbox', '@deepseek-ai/dsh-tool-bash']))
    }
    expect(Object.keys(windows.dependencies).some((name) => /bash/.test(name))).toBe(false)
    expect(Object.keys(windows.dependencies)).toEqual(expect.arrayContaining(['@deepseek-ai/dsh-pwsh-sandbox', '@deepseek-ai/dsh-tool-pwsh']))
    expect(new Set([darwin.lockSha256, linux.lockSha256, windows.lockSha256]).size).toBeGreaterThan(1)
  })

  it('materializes equivalent pack sets in canonical order regardless of input order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-pack-order-'))
    const manifests = await loadBundled()
    const canonicalProbes: string[][] = []
    const reversedProbes: string[][] = []
    const canonical = await materializeProfile([manifests.workspace!, manifests.shell!], join(root, 'canonical'), nativePlatform, {
      probeExecutable: async (alternatives) => { canonicalProbes.push(alternatives); return true },
    })
    const reversed = await materializeProfile([manifests.shell!, manifests.workspace!], join(root, 'reversed'), nativePlatform, {
      probeExecutable: async (alternatives) => { reversedProbes.push(alternatives); return true },
    })
    const canonicalProfile = await resolveCurrentTree(join(root, 'canonical'))
    const reversedProfile = await resolveCurrentTree(join(root, 'reversed'))

    expect(reversed.rows).toEqual(canonical.rows)
    expect(reversedProbes).toEqual(canonicalProbes)
    expect(await readFile(join(reversedProfile, 'cordis.yml'), 'utf8')).toBe(await readFile(join(canonicalProfile, 'cordis.yml'), 'utf8'))
    await expect(validateInstalledProfile(reversedProfile, {
      expected: { platform: nativePlatform, packIds: ['workspace', 'shell'] },
    })).resolves.toMatchObject({ closureId: `${nativePlatform}-workspace+shell` })
  }, 45_000)

  it('runs only the audited node-pty build on Linux before validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-linux-build-'))
    const shell = await loadPackManifest(packPath('shell'))
    const commands: { file: string; args: string[]; cwd?: string }[] = []
    await materializeProfile([shell], join(root, 'shell'), 'linux', {
      activate: false,
      probeExecutable: async () => true,
      runAuditedCommand: async (file, args, cwd) => {
        commands.push({ file, args, cwd })
        if (file === 'corepack') {
          const subprocessEntry = createRequire(join(cwd, 'package.json')).resolve('@deepseek-ai/dsh-subprocess-local')
          const nodePtyRoot = dirname(dirname(createRequire(subprocessEntry).resolve('node-pty')))
          await mkdir(join(nodePtyRoot, 'build', 'Release'), { recursive: true })
          await writeFile(join(nodePtyRoot, 'build', 'Release', 'pty.node'), '')
        }
      },
    })
    expect(commands).toHaveLength(2)
    expect(commands[0]).toMatchObject({ file: 'corepack', args: ['pnpm@10.15.0', '--ignore-workspace', 'rebuild', 'node-pty', '--dir', expect.any(String)] })
    expect(commands[1]?.file).toBe(process.execPath)
    expect(commands[1]?.args[0]).toMatch(/dsh-subprocess-local\/scripts\/ensure-spawn-helper\.mjs$/)
    expect(commands.every(({ cwd }) => cwd?.includes('.stage-'))).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('builds the audited node-pty package when a cold profile has no native binary', async () => {
    const root = await mkdtemp(join(resolve('.'), '.dsh-lite-node-pty-cold-'))
    const shell = await loadPackManifest(packPath('shell'))
    const platform = 'linux'
    let nodePtyRoot = ''
    try {
      await materializeProfile([shell], join(root, 'shell'), platform, {
        activate: false,
        install: async (candidate, args) => {
          await execFileAsync('corepack', ['pnpm@10.15.0', ...args], {
            cwd: candidate,
            env: { ...process.env, COREPACK_ENABLE_PROJECT_SPEC: '0' },
          })
          const subprocessEntry = createRequire(join(candidate, 'package.json')).resolve('@deepseek-ai/dsh-subprocess-local')
          nodePtyRoot = dirname(dirname(createRequire(subprocessEntry).resolve('node-pty')))
          while (JSON.parse(await readFile(join(nodePtyRoot, 'package.json'), 'utf8')).name !== 'node-pty') {
            nodePtyRoot = dirname(nodePtyRoot)
          }
          await rm(join(nodePtyRoot, 'prebuilds', `${process.platform}-${process.arch}`), { recursive: true, force: true })
          await rm(join(nodePtyRoot, 'build'), { recursive: true, force: true })
        },
        runAuditedCommand: async (file, args, cwd) => {
          await execFileAsync(file, args, { cwd, env: { ...process.env, COREPACK_ENABLE_PROJECT_SPEC: '0' } })
        },
      })
      const profile = await resolveCurrentTree(join(root, 'shell'))
      const installedSubprocess = createRequire(join(profile, 'package.json')).resolve('@deepseek-ai/dsh-subprocess-local')
      const installedNodePtyRoot = dirname(dirname(createRequire(installedSubprocess).resolve('node-pty')))
      await expect(access(join(installedNodePtyRoot, 'build', 'Release', 'pty.node'))).resolves.toBeUndefined()
      const generatedPackage = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as { pnpm?: { onlyBuiltDependencies?: string[] } }
      expect(generatedPackage.pnpm?.onlyBuiltDependencies).toEqual(['node-pty'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('grants native build permission only when the runner platform requires it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-node-pty-prebuilt-'))
    try {
      const shell = await loadPackManifest(packPath('shell'))
      await materializeProfile([shell], join(root, 'shell'), nativePlatform, { activate: false })
      const profile = await resolveCurrentTree(join(root, 'shell'))
      const generatedPackage = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as { pnpm?: { onlyBuiltDependencies?: string[] } }
      expect(generatedPackage.pnpm?.onlyBuiltDependencies).toEqual(nativePlatform === 'linux' ? ['node-pty'] : undefined)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('repairs only the audited node-pty helper and proves a real staged subprocess before ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-subprocess-'))
    const shell = await loadPackManifest(packPath('shell'))
    const target = join(root, 'generated')
    await materializeProfile([shell], target, nativePlatform)
    const profile = await resolveCurrentTree(target)
    const subprocessEntry = createRequire(join(profile, 'package.json')).resolve('@deepseek-ai/dsh-subprocess-local')
    let nodePtyRoot = dirname(createRequire(subprocessEntry).resolve('node-pty'))
    while (true) {
      try {
        if (JSON.parse(await readFile(join(nodePtyRoot, 'package.json'), 'utf8')).name === 'node-pty') break
      } catch {}
      nodePtyRoot = dirname(nodePtyRoot)
    }
    const helperCandidates = (await readdir(join(nodePtyRoot, 'prebuilds'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(nodePtyRoot, 'prebuilds', entry.name, 'spawn-helper'))
    const helpers: string[] = []
    for (const helper of helperCandidates) {
      try {
        await access(helper)
        helpers.push(helper)
      } catch {}
    }
    expect(helpers.length).toBeGreaterThan(0)
    for (const helper of helpers) await expect(access(helper, 1)).resolves.toBeUndefined()
    await expect(validateInstalledProfile(profile)).resolves.toMatchObject({ subprocessVerified: true })
  }, 30_000)

  it('removing shell restores the previous dependency and Cordis row set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-packs-'))
    const target = join(root, 'generated')
    const manifests = await loadBundled()

    const withShell = await materializeProfile([manifests.workspace!, manifests.shell!], target, nativePlatform, { activate: false, probeExecutable: async () => true })
    const withoutShell = await materializeProfile([manifests.workspace!], target, nativePlatform, { activate: false })

    const nativeTool = nativePlatform === 'win32' ? 'tool-pwsh' : 'tool-bash'
    expect(withShell.rows.map((row) => row.id)).toContain(nativeTool)
    expect(withoutShell.rows.map((row) => row.id)).not.toContain(nativeTool)
    expect(withoutShell.packageNames).toEqual(coreClosure)
    expect(withoutShell.packageNames).not.toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-bash-local',
      '@deepseek-ai/dsh-bash-sandbox',
      '@deepseek-ai/dsh-shell',
      '@deepseek-ai/dsh-shell-env',
      '@deepseek-ai/dsh-tool-bash',
      '@deepseek-ai/dsh-pwsh-local',
      '@deepseek-ai/dsh-pwsh-sandbox',
      '@deepseek-ai/dsh-tool-pwsh',
    ]))
    const current = await resolveCurrentTree(target)
    expect(JSON.parse(await readFile(join(current, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: { '@deepseek-ai/dsh-tools': '0.1.0-rc.6' },
    })
    expect(load(await readFile(join(current, 'cordis.yml'), 'utf8'))).toEqual(withoutShell.rows)
  }, 30_000)

  it('keeps the last valid target when candidate validation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-packs-'))
    const target = join(root, 'generated')
    const workspace = await loadPackManifest(packPath('workspace'))
    await materializeProfile([workspace], target, 'linux', { activate: false })
    const beforeTree = await resolveCurrentTree(target)
    const before = await readFile(join(beforeTree, 'cordis.yml'), 'utf8')
    const invalid = { ...workspace, id: 'invalid', cordisPatch: join(root, 'invalid.yml') }
    await writeFile(invalid.cordisPatch, 'rows:\n  - id: leaked\n    name: x\n    config:\n      apiKey: do-not-persist\n')

    await expect(materializeProfile([invalid], target, 'linux')).rejects.toThrow('credential')
    expect(await readFile(join(await resolveCurrentTree(target), 'cordis.yml'), 'utf8')).toBe(before)
  })

  it('rejects a selected upstream version that differs from the compatibility lock', async () => {
    const workspace = await loadPackManifest(packPath('workspace'))
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-packs-'))

    await expect(materializeProfile({
      upstream: { channel: 'stable', version: '0.1.0-rc.5' },
      manifests: [workspace],
    }, join(root, 'generated'), 'linux')).rejects.toThrow('upstream version')
  })

  it('rejects malformed manifests without echoing their contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-packs-'))
    const path = join(root, 'pack.json')
    const sentinel = 'SENTINEL_MANIFEST_SECRET'
    await writeFile(path, JSON.stringify({ id: sentinel }))

    await expect(loadPackManifest(path)).rejects.toThrow('invalid pack manifest')
    await expect(loadPackManifest(path)).rejects.not.toThrow(sentinel)
  })
})
