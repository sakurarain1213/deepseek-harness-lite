import { describe, expect, it } from 'vitest'
import { buildCompatibilityReport } from '../src/report.js'
import { detectTagSkew, verifyUpstreamLock } from '../src/upstream.js'

const lock = {
  schemaVersion: 1 as const,
  channel: 'stable' as const,
  harnessVersion: '0.1.0-rc.6',
  packages: {
    '@deepseek-ai/dsh-agent': '0.1.0-rc.6',
    '@deepseek-ai/dsh-tools': '0.1.0-rc.6',
  },
}

describe('upstream compatibility', () => {
  it('accepts only the exact package inventory and versions from one aggregate release', () => {
    expect(verifyUpstreamLock(lock, {
      aggregate: {
        name: '@deepseek-ai/dsh',
        version: '0.1.0-rc.6',
        dependencies: lock.packages,
      },
      packages: Object.fromEntries(Object.entries(lock.packages).map(([name, version]) => [name, { name, version }])),
    })).toEqual(lock.packages)
  })

  it('rejects a lock assembled by independently following skewed latest tags', () => {
    expect(() => verifyUpstreamLock(lock, {
      aggregate: {
        name: '@deepseek-ai/dsh',
        version: '0.1.0-rc.6',
        dependencies: lock.packages,
      },
      packages: {
        '@deepseek-ai/dsh-agent': { name: '@deepseek-ai/dsh-agent', version: '0.1.0-rc.6' },
        '@deepseek-ai/dsh-tools': { name: '@deepseek-ai/dsh-tools', version: '0.1.0-rc.1' },
      },
    })).toThrow('upstream package set is not coherent')
  })

  it('rejects missing and unexpected packages even when all versions share a release line', () => {
    expect(() => verifyUpstreamLock(lock, {
      aggregate: {
        name: '@deepseek-ai/dsh',
        version: '0.1.0-rc.6',
        dependencies: { ...lock.packages, '@deepseek-ai/dsh-extra': '0.1.0-rc.6' },
      },
      packages: {
        ...Object.fromEntries(Object.entries(lock.packages).map(([name, version]) => [name, { name, version }])),
        '@deepseek-ai/dsh-extra': { name: '@deepseek-ai/dsh-extra', version: '0.1.0-rc.6' },
      },
    })).toThrow('upstream package set is not coherent')
  })

  it('reports latest and next tag skew against their aggregate package inventory', () => {
    expect(detectTagSkew({
      '@deepseek-ai/dsh': { latest: '0.1.0-rc.6', next: '0.1.0-rc.7' },
      '@deepseek-ai/dsh-agent': { latest: '0.1.0-rc.6', next: '0.1.0-rc.7' },
      '@deepseek-ai/dsh-tools': { latest: '0.1.0-rc.1', next: '0.1.0-rc.8' },
    }, ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-tools'])).toEqual([
      { tag: 'latest', aggregateVersion: '0.1.0-rc.6', package: '@deepseek-ai/dsh-tools', packageVersion: '0.1.0-rc.1' },
      { tag: 'next', aggregateVersion: '0.1.0-rc.7', package: '@deepseek-ai/dsh-tools', packageVersion: '0.1.0-rc.8' },
    ])
  })

  it('builds byte-stable reports from explicit evidence without inventing measurements', () => {
    const input = {
      schemaVersion: 1 as const,
      channel: 'stable' as const,
      evidenceKind: 'release-gate' as const,
      liteCommit: '0123456789abcdef0123456789abcdef01234567',
      upstreamVersion: '0.1.0-rc.6',
      platform: 'linux',
      arch: 'x64',
      nodeVersion: '22.19.0',
      packageManager: 'pnpm@10.15.0',
      selection: { packs: ['workspace'], plugins: ['health'] },
      packageInventory: lock.packages,
      commands: ['pnpm test', 'pnpm build'],
      result: 'passed' as const,
      timestamp: '2026-08-14T00:00:00.000Z',
    }
    expect(buildCompatibilityReport(input)).toBe(buildCompatibilityReport({
      ...input,
      packageInventory: Object.fromEntries(Object.entries(lock.packages).reverse()),
    }))
    expect(buildCompatibilityReport(input)).toContain('"measured": true')
    expect(buildCompatibilityReport(input)).toContain('"liteCommit": "0123456789abcdef0123456789abcdef01234567"')
    expect(buildCompatibilityReport(input)).toContain('"arch": "x64"')
  })
})
