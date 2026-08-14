import type { LiteConfig } from './config.js'
import type { PackManifest } from './manifest.js'

export type Platform = 'darwin' | 'linux' | 'win32'

export interface PackDefinition {
  id: string
  dependencies: string[]
  conflicts: string[]
  platforms: Platform[]
  plugins: string[]
  manifest?: PackManifest
}

export interface PluginDefinition {
  id: string
  package?: string
}

export interface Registry {
  packs: Record<string, PackDefinition>
  plugins: Record<string, PluginDefinition>
  presets?: Record<string, string[]>
}

export interface ResolvedProfile {
  schemaVersion: 1
  upstream: LiteConfig['upstream']
  profile: string
  packIds: string[]
  pluginIds: string[]
  manifests?: PackManifest[]
}

const PACK_ORDER = ['workspace', 'shell', 'research']
const comparePacks = (a: string, b: string): number => {
  const aIndex = PACK_ORDER.indexOf(a)
  const bIndex = PACK_ORDER.indexOf(b)
  if (aIndex !== bIndex) return (aIndex < 0 ? PACK_ORDER.length : aIndex) - (bIndex < 0 ? PACK_ORDER.length : bIndex)
  return a.localeCompare(b)
}

const assertUnique = (values: string[], kind: 'pack' | 'plugin'): void => {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${kind} "${value}"`)
    seen.add(value)
  }
}

export function resolveProfile(
  config: LiteConfig,
  registry: Registry,
  platform: Platform = process.platform as Platform,
): ResolvedProfile {
  assertUnique(config.packs, 'pack')
  assertUnique(config.plugins, 'plugin')

  const orderedPacks: string[] = []
  const resolved = new Set<string>()
  const resolving = new Set<string>()

  const visit = (id: string): void => {
    const pack = registry.packs[id]
    if (!pack) throw new Error(`unknown pack "${id}"`)
    if (resolved.has(id)) return
    if (resolving.has(id)) throw new Error(`pack dependency cycle at "${id}"`)
    if (!pack.platforms.includes(platform)) throw new Error(`pack "${id}" does not support platform "${platform}"`)

    resolving.add(id)
    for (const dependency of [...pack.dependencies].sort(comparePacks)) visit(dependency)
    resolving.delete(id)
    resolved.add(id)
    orderedPacks.push(id)
  }

  const preset = registry.presets?.[config.profile] ?? (config.profile === 'custom' ? [] : undefined)
  if (!preset) throw new Error(`unknown profile "${config.profile}"`)
  const requestedPacks = [...new Set([...preset, ...config.packs])].sort(comparePacks)
  for (const id of requestedPacks) visit(id)

  for (const id of orderedPacks) {
    const pack = registry.packs[id]!
    for (const otherId of orderedPacks) {
      if (id !== otherId && (pack.conflicts.includes(otherId) || registry.packs[otherId]!.conflicts.includes(id))) {
        throw new Error(`pack "${id}" conflicts with "${otherId}"`)
      }
    }
  }

  const pluginIds = [...config.plugins]
  for (const id of orderedPacks) pluginIds.push(...registry.packs[id]!.plugins)
  assertUnique(pluginIds, 'plugin')
  pluginIds.sort()
  for (const id of pluginIds) {
    if (!registry.plugins[id]) throw new Error(`unknown plugin "${id}"`)
  }

  const manifests = orderedPacks.map((id) => {
    const manifest = registry.packs[id]!.manifest
    if (!manifest) throw new Error(`pack "${id}" is missing manifest`)
    return manifest
  })
  const profile: ResolvedProfile = {
    schemaVersion: config.schemaVersion,
    upstream: config.upstream,
    profile: config.profile,
    packIds: orderedPacks,
    pluginIds,
  }
  Object.defineProperty(profile, 'manifests', {
    value: manifests,
    enumerable: false,
  })
  return profile
}
