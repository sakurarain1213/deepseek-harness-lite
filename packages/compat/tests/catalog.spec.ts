import { describe, expect, it } from 'vitest'
import { classifyPlugin, validateCatalogEntry } from '../src/catalog.js'

const executableEvidence = {
  metadataReviewed: true,
  spdxLicense: 'MIT',
  sourceCommit: '0123456789abcdef0123456789abcdef01234567',
  installPassed: true,
  buildPassed: true,
  activationPassed: true,
  riskFlags: [],
}

describe('catalog classification', () => {
  it('classifies complete repository-owned executable evidence as bundled', () => {
    expect(classifyPlugin({ ...executableEvidence, bundled: true })).toBe('bundled')
  })

  it('classifies complete pinned external executable evidence as verified', () => {
    expect(classifyPlugin(executableEvidence)).toBe('verified')
  })

  it('never recommends a discovered plugin without executable evidence', () => {
    expect(classifyPlugin({ ...executableEvidence, activationPassed: false })).toBe('listed')
    expect(classifyPlugin({ ...executableEvidence, installPassed: false })).toBe('listed')
  })

  it('blocks license, secret, install, and safety risks', () => {
    expect(classifyPlugin({ ...executableEvidence, riskFlags: ['secret-detected'] })).toBe('blocked')
    expect(classifyPlugin({ ...executableEvidence, spdxLicense: '' })).toBe('blocked')
  })

  it('requires catalog source records to carry pinned, reviewable evidence fields', () => {
    expect(validateCatalogEntry({
      id: 'health',
      package: '@dsh-lite/plugin-health',
      repository: 'https://github.com/example/health',
      description: 'Sanitized health diagnostics.',
      declaredCompatibility: '0.1.0-rc.6',
      ...executableEvidence,
      bundled: true,
      checks: ['install', 'build', 'activation'],
      lastVerifiedAt: '2026-08-14T00:00:00.000Z',
    })).toMatchObject({ status: 'bundled', recommended: true })
  })

  it('rejects evidence flags that do not match the recorded checks', () => {
    const entry = {
      id: 'health',
      package: '@dsh-lite/plugin-health',
      repository: 'https://github.com/example/health',
      description: 'Sanitized health diagnostics.',
      declaredCompatibility: '0.1.0-rc.6',
      ...executableEvidence,
      bundled: true,
      checks: ['install', 'build'],
      lastVerifiedAt: '2026-08-14T00:00:00.000Z',
    }

    expect(() => validateCatalogEntry(entry)).toThrow('invalid catalog entry')
  })

  it('rejects calendar-invalid verification timestamps', () => {
    expect(() => validateCatalogEntry({
      id: 'health',
      package: '@dsh-lite/plugin-health',
      repository: 'https://github.com/example/health',
      description: 'Sanitized health diagnostics.',
      declaredCompatibility: '0.1.0-rc.6',
      ...executableEvidence,
      bundled: true,
      checks: ['install', 'build', 'activation'],
      lastVerifiedAt: '2026-99-99T00:00:00.000Z',
    })).toThrow('invalid catalog entry')
  })
})
