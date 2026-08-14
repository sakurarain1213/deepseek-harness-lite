export type CatalogStatus = 'bundled' | 'verified' | 'listed' | 'blocked'

export interface PluginEvidence {
  bundled?: boolean
  metadataReviewed: boolean
  spdxLicense: string
  sourceCommit: string
  installPassed: boolean
  buildPassed: boolean
  activationPassed: boolean
  riskFlags: string[]
}

export interface CatalogEntry extends PluginEvidence {
  id: string
  package: string
  repository: string
  description: string
  declaredCompatibility: string
  checks: string[]
  lastVerifiedAt: string
}

export type ValidatedCatalogEntry = CatalogEntry & { status: CatalogStatus; recommended: boolean }

const spdxId = /^[A-Za-z0-9][A-Za-z0-9-.+]*(?: WITH [A-Za-z0-9][A-Za-z0-9-.+]*)?$/
const fullCommit = /^[0-9a-f]{40}$/
const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const evidenceChecks = ['install', 'build', 'activation'] as const

function isValidTimestamp(value: string): boolean {
  const timestamp = Date.parse(value)
  return isoTimestamp.test(value) && Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

export function classifyPlugin(evidence: PluginEvidence): CatalogStatus {
  if (!spdxId.test(evidence.spdxLicense) || evidence.riskFlags.length > 0) return 'blocked'
  const executableEvidence = evidence.metadataReviewed
    && fullCommit.test(evidence.sourceCommit)
    && evidence.installPassed
    && evidence.buildPassed
    && evidence.activationPassed
  if (!executableEvidence) return 'listed'
  return evidence.bundled ? 'bundled' : 'verified'
}

export function validateCatalogEntry(value: CatalogEntry): ValidatedCatalogEntry {
  const expectedChecks = evidenceChecks.filter((check) => ({
    install: value.installPassed,
    build: value.buildPassed,
    activation: value.activationPassed,
  })[check])
  if (!/^[a-z][a-z0-9-]*$/.test(value.id)
    || typeof value.package !== 'string' || value.package.length === 0
    || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(value.repository)
    || value.description.trim().length === 0
    || value.declaredCompatibility.trim().length === 0
    || !Array.isArray(value.checks)
    || value.checks.some((check) => !evidenceChecks.includes(check as typeof evidenceChecks[number]))
    || new Set(value.checks).size !== value.checks.length
    || JSON.stringify([...value.checks].sort()) !== JSON.stringify([...expectedChecks].sort())
    || !isValidTimestamp(value.lastVerifiedAt)) {
    throw new Error(`invalid catalog entry: ${value.id || '<unknown>'}`)
  }
  const status = classifyPlugin(value)
  return { ...value, status, recommended: status === 'bundled' || status === 'verified' }
}
