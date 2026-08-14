import { access, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { renderCatalog } from '../packages/compat/bin/catalog-readme.mjs'
import { releaseEvidenceErrors } from '../packages/compat/bin/stable-report.mjs'

const root = resolve(import.meta.dirname, '..')
const releaseMode = process.argv.slice(2).includes('--release') || process.env.DSH_LITE_RELEASE_VERIFY === '1'
const require = createRequire(join(root, 'packages/core/package.json'))
const { load: loadYaml } = require('js-yaml')
const readJson = async (path) => JSON.parse(await readFile(join(root, path), 'utf8'))
const errors = []
const assert = (condition, message) => { if (!condition) errors.push(message) }
const canonicalRecord = (value) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))
const commitExists = (commit) => {
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: root, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const lock = await readJson('compat/upstream-lock.json')
const packagedLock = await readJson('packages/core/compat/upstream-lock.json')
assert(lock.channel === 'stable' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(lock.harnessVersion), 'upstream lock must identify one exact stable release')
assert(JSON.stringify(lock) === JSON.stringify(packagedLock), 'packaged upstream lock must exactly match the repository lock')
for (const [name, version] of Object.entries(lock.packages ?? {})) {
  assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version), `${name} must have an exact version`)
  if (name.startsWith('@deepseek-ai/dsh-')) assert(version === lock.harnessVersion, `${name} must share the stable release line`)
}

const catalog = await readJson('catalog/plugins.json')
assert(catalog.schemaVersion === 1 && Array.isArray(catalog.plugins), 'catalog source must use schemaVersion 1 with a plugins array')
for (const plugin of catalog.plugins ?? []) {
  const status = plugin.status
  const expectedChecks = [
    ['install', plugin.installPassed],
    ['build', plugin.buildPassed],
    ['activation', plugin.activationPassed],
  ].filter(([, passed]) => passed).map(([check]) => check).sort()
  const recordedChecks = Array.isArray(plugin.checks) ? [...plugin.checks].sort() : []
  const executable = plugin.metadataReviewed === true
    && /^[A-Za-z0-9][A-Za-z0-9-.+]*$/.test(plugin.spdxLicense ?? '')
    && /^[0-9a-f]{40}$/.test(plugin.sourceCommit ?? '')
    && plugin.installPassed === true
    && plugin.buildPassed === true
    && plugin.activationPassed === true
    && Array.isArray(plugin.riskFlags)
    && plugin.riskFlags.length === 0
  const derivedStatus = !/^[A-Za-z0-9][A-Za-z0-9-.+]*$/.test(plugin.spdxLicense ?? '') || !Array.isArray(plugin.riskFlags) || plugin.riskFlags.length > 0
    ? 'blocked'
    : executable
      ? plugin.bundled === true ? 'bundled' : 'verified'
      : 'listed'
  assert(['bundled', 'verified', 'listed', 'blocked'].includes(status), `${plugin.id}: invalid catalog status`)
  assert(status === derivedStatus, `${plugin.id}: catalog status does not match executable evidence`)
  assert(JSON.stringify(recordedChecks) === JSON.stringify(expectedChecks), `${plugin.id}: checks do not match executable evidence`)
  assert(plugin.recommended === (status === 'bundled' || status === 'verified'), `${plugin.id}: recommendation must derive from status`)
  if (plugin.recommended) {
    assert(executable, `${plugin.id}: recommended plugin lacks executable evidence`)
    if (status === 'bundled') assert(commitExists(plugin.sourceCommit), `${plugin.id}: bundled source commit does not exist in this repository`)
  }
}
const generatedCatalog = await readFile(join(root, 'catalog/generated/README.md'), 'utf8')
assert(generatedCatalog === renderCatalog(catalog), 'generated plugin catalog is stale')
const cliCatalog = await readJson('apps/cli/catalog.json')
const cliPackage = await readJson('apps/cli/package.json')
const runtimePackage = await readJson('packages/runtime/package.json')
const publicPluginMap = Object.fromEntries((catalog.plugins ?? []).map((plugin) => [plugin.id, plugin.package]))
const cliPluginMap = Object.fromEntries((cliCatalog.plugins ?? []).map((plugin) => [plugin.id, plugin.package]))
assert(canonicalRecord(cliPluginMap) === canonicalRecord(publicPluginMap), 'CLI and public plugin catalogs must have the same id/package mapping')
for (const [id, packageName] of Object.entries(publicPluginMap)) {
  assert(cliPackage.dependencies?.[packageName] === 'workspace:*', `${id}: CLI manifest must own the repository plugin package`)
  assert(runtimePackage.dependencies?.[packageName] === 'workspace:*', `${id}: runtime manifest must own the repository plugin package`)
}
const contributedPlugins = new Set()
for (const pack of ['workspace', 'shell', 'research']) {
  const manifest = await readJson(`packages/packs/${pack}/pack.json`)
  for (const id of manifest.plugins ?? []) {
    contributedPlugins.add(id)
    assert(publicPluginMap[id], `${pack}: pack contributes an unknown repository plugin`)
  }
}
assert([...contributedPlugins].length > 0, 'capability packs must declare their plugin contributions')

const reports = {}
for (const channel of ['stable', 'latest']) {
  const report = await readJson(`compat/reports/${channel}.json`)
  reports[channel] = report
  assert(report.schemaVersion === 1 && report.channel === channel, `${channel} report has the wrong identity`)
  assert(typeof report.liteCommit === 'string' && typeof report.platform === 'string' && typeof report.arch === 'string' && typeof report.nodeVersion === 'string', `${channel} report lacks commit, platform, architecture, or Node evidence`)
  assert(typeof report.packageManager === 'string' && Array.isArray(report.selection?.packs) && Array.isArray(report.selection?.plugins), `${channel} report lacks package-manager or selection evidence`)
  assert(report.packageInventory && typeof report.packageInventory === 'object' && Array.isArray(report.commands), `${channel} report lacks package inventory or commands`)
  assert(['passed', 'failed', 'planned', 'unavailable'].includes(report.result), `${channel} report has an invalid result`)
  assert(report.measured === (report.result === 'passed' || report.result === 'failed'), `${channel} report misstates whether it was measured`)
  assert(!report.measured || report.commands.length > 0, `${channel} measured report must identify executed commands`)
  assert(/^\d{4}-\d{2}-\d{2}T/.test(report.timestamp), `${channel} report lacks an ISO timestamp`)
  if (channel === 'stable') assert(canonicalRecord(report.packageInventory) === canonicalRecord(lock.packages), 'stable report inventory must exactly match the upstream lock')
}

if (releaseMode) {
  const plugins = catalog.plugins ?? []
  errors.push(...releaseEvidenceErrors({ stable: reports.stable, plugins, commitExists }))
}

const installSize = await readJson('compat/reports/install-size.json')
assert(installSize.schemaVersion === 1 && installSize.result === 'passed' && installSize.measured === true, 'install-size report must contain a successful clean measurement')
assert(typeof installSize.registry === 'string' && installSize.registry.length > 0, 'install-size report must identify the registry')
const checkoutSize = installSize.profiles?.checkout
const coreSize = installSize.profiles?.coreChatClosure
const aggregateSize = installSize.profiles?.aggregate
for (const [name, profile] of [['checkout', checkoutSize], ['coreChatClosure', coreSize], ['aggregate', aggregateSize]]) {
  assert(Number.isInteger(profile?.directDependencyCount) && profile.directDependencyCount > 0, `${name} install measurement lacks directDependencyCount`)
  assert(Number.isInteger(profile?.installedPackageCount) && profile.installedPackageCount > 0, `${name} install measurement lacks installedPackageCount`)
  assert(Number.isInteger(profile?.bytes) && profile.bytes > 0 && Number.isInteger(profile?.files) && profile.files > 0, `${name} install measurement lacks byte or file evidence`)
}
assert(checkoutSize?.workspacePackageCount === 14, 'checkout measurement must cover every release workspace')
for (const [name, profile] of [['checkout', checkoutSize], ['coreChatClosure', coreSize]]) {
  assert(profile?.bytes < aggregateSize?.bytes, `${name} measurement must install fewer bytes than the aggregate CLI`)
  assert(profile?.files < aggregateSize?.files, `${name} measurement must install fewer files than the aggregate CLI`)
  assert(profile?.installedPackageCount < aggregateSize?.installedPackageCount, `${name} measurement must install fewer packages than the aggregate CLI`)
}
const publicReadmes = await Promise.all(['README.md', 'README.zh.md'].map((path) => readFile(join(root, path), 'utf8')))
for (const profile of [checkoutSize, coreSize, aggregateSize]) {
  for (const value of [profile.bytes, profile.files, profile.installedPackageCount]) {
    const rendered = value.toLocaleString('en-US')
    for (const readme of publicReadmes) assert(readme.includes(rendered), `README install evidence is missing ${rendered}`)
  }
}

const ci = loadYaml(await readFile(join(root, '.github/workflows/ci.yml'), 'utf8'))
const upstream = loadYaml(await readFile(join(root, '.github/workflows/upstream-compat.yml'), 'utf8'))
const ciJob = ci?.jobs?.verify
const upstreamJob = upstream?.jobs?.observe
assert(JSON.stringify(ciJob?.strategy?.matrix?.os) === JSON.stringify(['ubuntu-latest', 'macos-latest', 'windows-latest']), 'CI must cover Linux, macOS, and Windows')
assert(ciJob?.['continue-on-error'] === "${{ matrix.os == 'windows-latest' }}", 'Windows CI must remain planned/non-blocking')
const ciCommands = (ciJob?.steps ?? []).map((step) => step.run).filter(Boolean).join('\n')
for (const command of ['install --frozen-lockfile', 'pnpm test', 'pnpm typecheck', 'pnpm build', 'cli.e2e.spec.ts', 'packs.spec.ts', 'packed-production.spec.ts']) {
  assert(ciCommands.includes(command), `CI is missing ${command}`)
}
assert(upstream?.on?.schedule || upstream?.true?.schedule, 'upstream compatibility workflow must be scheduled')
assert(JSON.stringify(upstreamJob?.strategy?.matrix?.channel) === JSON.stringify(['latest', 'next']), 'upstream observation workflow must check latest and next metadata')
const upstreamCommands = (upstreamJob?.steps ?? []).map((step) => step.run).filter(Boolean).join('\n')
assert(upstreamCommands.includes('packages/compat/bin/upstream-report.mjs'), 'upstream observation workflow must resolve and record registry metadata')
assert(!upstreamCommands.includes('vitest run packages/runtime/tests '), 'metadata observation must not imply candidate runtime execution')
for (const path of ['scripts/verify-repo.mjs', 'scripts/check-secrets.mjs', 'scripts/check-licenses.mjs', 'packages/compat/bin/upstream-report.mjs']) {
  try {
    await access(join(root, path))
  } catch {
    errors.push(`workflow command target does not exist: ${path}`)
  }
}

if (errors.length) {
  process.stderr.write(`repository verification failed:\n${errors.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('repository verification passed\n')
}
