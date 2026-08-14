export interface UpstreamLock {
  schemaVersion?: 1
  channel: 'stable'
  harnessVersion: string
  packages: Record<string, string>
}

export interface RegistryPackageMetadata {
  name: string
  version: string
}

export interface RegistryReleaseMetadata {
  aggregate: RegistryPackageMetadata & { dependencies: Record<string, string> }
  packages: Record<string, RegistryPackageMetadata>
}

export interface RegistryDistTags {
  [packageName: string]: Partial<Record<'latest' | 'next', string>>
}

export interface TagSkew {
  tag: 'latest' | 'next'
  aggregateVersion: string
  package: string
  packageVersion: string | null
}

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function incoherent(detail: string): never {
  throw new Error(`upstream package set is not coherent: ${detail}`)
}

export function verifyUpstreamLock(lock: UpstreamLock, metadata: RegistryReleaseMetadata): Record<string, string> {
  if (lock.channel !== 'stable' || !exactVersion.test(lock.harnessVersion)) incoherent('invalid stable release')
  if (metadata.aggregate.name !== '@deepseek-ai/dsh' || metadata.aggregate.version !== lock.harnessVersion) {
    incoherent('aggregate release does not match the lock')
  }

  const lockedNames = Object.keys(lock.packages).sort()
  const aggregateNames = Object.keys(metadata.aggregate.dependencies).sort()
  const metadataNames = Object.keys(metadata.packages).sort()
  if (JSON.stringify(lockedNames) !== JSON.stringify(aggregateNames) || JSON.stringify(lockedNames) !== JSON.stringify(metadataNames)) {
    incoherent('package inventory differs from the aggregate release')
  }

  for (const name of lockedNames) {
    const lockedVersion = lock.packages[name]
    const declaredVersion = metadata.aggregate.dependencies[name]
    const published = metadata.packages[name]
    if (!lockedVersion || !exactVersion.test(lockedVersion) || declaredVersion !== lockedVersion || published?.name !== name || published.version !== lockedVersion) {
      incoherent(`${name} does not resolve to ${lockedVersion ?? 'a pinned version'}`)
    }
  }
  return Object.fromEntries(lockedNames.map((name) => [name, lock.packages[name]!]))
}

export function detectTagSkew(tags: RegistryDistTags, packageNames: string[]): TagSkew[] {
  const aggregate = tags['@deepseek-ai/dsh'] ?? {}
  const skew: TagSkew[] = []
  for (const tag of ['latest', 'next'] as const) {
    const aggregateVersion = aggregate[tag]
    if (!aggregateVersion) continue
    for (const name of [...packageNames].sort()) {
      const packageVersion = tags[name]?.[tag] ?? null
      if (packageVersion !== aggregateVersion) skew.push({ tag, aggregateVersion, package: name, packageVersion })
    }
  }
  return skew
}
