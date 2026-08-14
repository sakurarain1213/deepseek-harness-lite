import { describe, expect, it } from 'vitest'
import { parseLiteConfig } from '../src/config.js'
import { resolveProfile, type Registry } from '../src/packs.js'
import type { PackManifest } from '../src/manifest.js'

const EMPTY_REGISTRY: Registry = { packs: {}, plugins: {} }
const config = (packs: string[], plugins: string[] = []) => parseLiteConfig({
  schemaVersion: 1,
  upstream: { channel: 'stable', version: '0.1.0-rc.6' },
  profile: 'custom',
  packs,
  plugins,
})

describe('resolveProfile', () => {
  it('rejects unknown packs before writing generated state', () => {
    expect(() => resolveProfile(config(['missing']), EMPTY_REGISTRY)).toThrow('unknown pack "missing"')
  })

  it('expands dependencies in deterministic order and includes contributed plugins', () => {
    const workspace = { id: 'workspace', defaultEnabled: false } as PackManifest
    const shell = { id: 'shell', defaultEnabled: false } as PackManifest
    const registry: Registry = {
      packs: {
        shell: { id: 'shell', dependencies: ['workspace'], conflicts: [], platforms: ['linux'], plugins: ['command'], manifest: shell },
        workspace: { id: 'workspace', dependencies: [], conflicts: [], platforms: ['darwin', 'linux', 'win32'], plugins: ['notes'], manifest: workspace },
      },
      plugins: { command: { id: 'command' }, notes: { id: 'notes' } },
    }
    expect(resolveProfile(config(['shell']), registry, 'linux')).toMatchObject({
      packIds: ['workspace', 'shell'],
      pluginIds: ['command', 'notes'],
    })
  })

  it('rejects duplicate, conflicting, and unsupported packs', () => {
    const registry: Registry = {
      packs: {
        a: { id: 'a', dependencies: [], conflicts: ['b'], platforms: ['darwin'], plugins: [] },
        b: { id: 'b', dependencies: [], conflicts: [], platforms: ['darwin'], plugins: [] },
      },
      plugins: {},
    }
    expect(() => resolveProfile(config(['a', 'a']), registry, 'darwin')).toThrow('duplicate pack "a"')
    expect(() => resolveProfile(config(['a', 'b']), registry, 'darwin')).toThrow('pack "a" conflicts with "b"')
    expect(() => resolveProfile(config(['a']), registry, 'linux')).toThrow('pack "a" does not support platform "linux"')
  })

  it('rejects duplicate plugin contributions', () => {
    const registry: Registry = {
      packs: {
        a: { id: 'a', dependencies: [], conflicts: [], platforms: ['linux'], plugins: ['shared'] },
        b: { id: 'b', dependencies: [], conflicts: [], platforms: ['linux'], plugins: ['shared'] },
      },
      plugins: { shared: { id: 'shared' } },
    }
    expect(() => resolveProfile(config(['a', 'b']), registry, 'linux')).toThrow('duplicate plugin "shared"')
  })

  it('rejects dependency cycles', () => {
    const registry: Registry = {
      packs: {
        a: { id: 'a', dependencies: ['b'], conflicts: [], platforms: ['linux'], plugins: [] },
        b: { id: 'b', dependencies: ['a'], conflicts: [], platforms: ['linux'], plugins: [] },
      },
      plugins: {},
    }
    expect(() => resolveProfile(config(['a']), registry, 'linux')).toThrow('pack dependency cycle at "a"')
  })

  it('rejects unknown plugins', () => {
    expect(() => resolveProfile(config([], ['missing']), EMPTY_REGISTRY, 'linux')).toThrow('unknown plugin "missing"')
  })

  it('preserves resolved manifests for materialization in dependency order', () => {
    const workspace = { id: 'workspace' } as PackManifest
    const shell = { id: 'shell' } as PackManifest
    const registry: Registry = {
      packs: {
        shell: { id: 'shell', dependencies: ['workspace'], conflicts: [], platforms: ['linux'], plugins: [], manifest: shell },
        workspace: { id: 'workspace', dependencies: [], conflicts: [], platforms: ['linux'], plugins: [], manifest: workspace },
      },
      plugins: {},
    }

    expect(resolveProfile(config(['shell']), registry, 'linux').manifests).toEqual([workspace, shell])
  })

  it('canonicalizes independent requested packs regardless of input order', () => {
    const workspace = { id: 'workspace' } as PackManifest
    const shell = { id: 'shell' } as PackManifest
    const registry: Registry = {
      packs: {
        shell: { id: 'shell', dependencies: [], conflicts: [], platforms: ['linux'], plugins: [], manifest: shell },
        workspace: { id: 'workspace', dependencies: [], conflicts: [], platforms: ['linux'], plugins: [], manifest: workspace },
      },
      plugins: {},
    }

    const canonical = resolveProfile(config(['workspace', 'shell']), registry, 'linux')
    const reversed = resolveProfile(config(['shell', 'workspace']), registry, 'linux')
    expect(reversed.packIds).toEqual(canonical.packIds)
    expect(reversed.manifests).toEqual(canonical.manifests)
  })

  it('fails when a selected pack has no materializable manifest', () => {
    const registry: Registry = {
      packs: { workspace: { id: 'workspace', dependencies: [], conflicts: [], platforms: ['linux'], plugins: [] } },
      plugins: {},
    }
    expect(() => resolveProfile(config(['workspace']), registry, 'linux')).toThrow('missing manifest')
  })

  it('applies developer defaults while chat-only stays empty', () => {
    const manifest = { id: 'workspace', defaultEnabled: true } as PackManifest
    const registry: Registry = {
      packs: { workspace: { id: 'workspace', dependencies: [], conflicts: [], platforms: ['linux'], plugins: [], manifest } },
      plugins: {},
      presets: { 'chat-only': [], developer: ['workspace'] },
    }
    const developer = parseLiteConfig({ ...config([]), profile: 'developer' })
    const chatOnly = parseLiteConfig({ ...config([]), profile: 'chat-only' })
    expect(resolveProfile(developer, registry, 'linux').packIds).toEqual(['workspace'])
    expect(resolveProfile(chatOnly, registry, 'linux').packIds).toEqual([])
  })
})
