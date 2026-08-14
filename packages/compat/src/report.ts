export interface CompatibilityReportInput {
  schemaVersion: 1
  channel: 'stable' | 'latest' | 'next'
  evidenceKind: 'release-gate' | 'registry-metadata-observation'
  liteCommit: string
  upstreamVersion: string
  platform: string
  arch: string
  nodeVersion: string
  packageManager: string
  selection: { packs: string[]; plugins: string[] }
  packageInventory: Record<string, string>
  commands: string[]
  result: 'passed' | 'failed' | 'planned' | 'unavailable'
  timestamp: string
  diagnostics?: string[]
  limitations?: string[]
}

export function buildCompatibilityReport(input: CompatibilityReportInput): string {
  const inventory = Object.fromEntries(Object.entries(input.packageInventory).sort(([a], [b]) => a.localeCompare(b)))
  const report = {
    schemaVersion: input.schemaVersion,
    channel: input.channel,
    evidenceKind: input.evidenceKind,
    liteCommit: input.liteCommit,
    upstreamVersion: input.upstreamVersion,
    platform: input.platform,
    arch: input.arch,
    nodeVersion: input.nodeVersion,
    packageManager: input.packageManager,
    selection: { packs: [...input.selection.packs].sort(), plugins: [...input.selection.plugins].sort() },
    packageInventory: inventory,
    commands: [...input.commands],
    result: input.result,
    measured: input.result === 'passed' || input.result === 'failed',
    timestamp: input.timestamp,
    ...(input.diagnostics?.length ? { diagnostics: [...input.diagnostics] } : {}),
    ...(input.limitations?.length ? { limitations: [...input.limitations] } : {}),
  }
  return `${JSON.stringify(report, null, 2)}\n`
}
