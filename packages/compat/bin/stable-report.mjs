import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCorepackCommand } from '../../core/src/corepack.ts'
import { sanitizeDiagnostic } from './diagnostics.mjs'

const packageManager = 'pnpm@10.15.0'

export const releaseCommands = Object.freeze([
  { id: 'install', command: `CI=1 corepack ${packageManager} install --frozen-lockfile`, file: 'corepack', args: [packageManager, 'install', '--frozen-lockfile'], env: { CI: '1' } },
  { id: 'test', command: `corepack ${packageManager} test`, file: 'corepack', args: [packageManager, 'test'] },
  { id: 'typecheck', command: `corepack ${packageManager} typecheck`, file: 'corepack', args: [packageManager, 'typecheck'] },
  { id: 'lint', command: `corepack ${packageManager} lint`, file: 'corepack', args: [packageManager, 'lint'] },
  { id: 'build', command: `corepack ${packageManager} build`, file: 'corepack', args: [packageManager, 'build'] },
  { id: 'repository', command: `corepack ${packageManager} verify:repo`, file: 'corepack', args: [packageManager, 'verify:repo'] },
  { id: 'secrets', command: `corepack ${packageManager} check:secrets`, file: 'corepack', args: [packageManager, 'check:secrets'] },
  { id: 'licenses', command: `corepack ${packageManager} check:licenses`, file: 'corepack', args: [packageManager, 'check:licenses'] },
  { id: 'compatibility', command: `corepack ${packageManager} compat:check`, file: 'corepack', args: [packageManager, 'compat:check'] },
  { id: 'install-size', command: `corepack ${packageManager} measure:install`, file: 'corepack', args: [packageManager, 'measure:install'] },
])

export function releaseEvidenceErrors({ stable, plugins, commitExists }) {
  const errors = []
  const assert = (condition, message) => { if (!condition) errors.push(message) }
  const bundledPlugins = plugins.filter((plugin) => plugin.status === 'bundled')
  const sourceCommits = [...new Set(plugins.map((plugin) => plugin.sourceCommit))]
  const expectedCommands = releaseCommands.map((command) => command.command)
  const commandResults = Array.isArray(stable.commandResults) ? stable.commandResults : []
  const sorted = (value) => Array.isArray(value) ? [...value].sort() : []

  assert(stable.result === 'passed' && stable.measured === true && stable.evidenceKind === 'release-gate', 'release verification requires a passed stable release gate')
  assert(plugins.length > 0 && bundledPlugins.length === plugins.length, 'release verification requires every repository plugin to be bundled')
  assert(sourceCommits.length === 1 && stable.liteCommit === sourceCommits[0] && /^[0-9a-f]{40}$/.test(stable.liteCommit ?? '') && commitExists(stable.liteCommit), 'stable release gate must bind every bundled plugin to one real source commit')
  assert(typeof stable.platform === 'string' && typeof stable.arch === 'string' && !['unmeasured', 'unavailable'].includes(stable.platform) && !['unmeasured', 'unavailable'].includes(stable.arch), 'stable release gate must identify a measured platform and architecture')
  assert(/^\d+\.\d+\.\d+/.test(stable.nodeVersion ?? '') && stable.packageManager === packageManager, 'stable release gate must identify Node and the pinned package manager')
  assert(JSON.stringify(sorted(stable.selection?.packs)) === JSON.stringify(['research', 'shell', 'workspace']), 'stable release gate must cover every pack')
  assert(JSON.stringify(sorted(stable.selection?.plugins)) === JSON.stringify(plugins.map((plugin) => plugin.id).sort()), 'stable release gate must cover every repository plugin')
  assert(JSON.stringify(stable.commands) === JSON.stringify(expectedCommands), 'stable release gate must contain the exact ordered release command list')
  assert(commandResults.length === releaseCommands.length, 'stable release gate must contain one result for every release command')

  if (commandResults.length === releaseCommands.length) {
    for (const [index, expected] of releaseCommands.entries()) {
      const result = commandResults[index]
      const started = typeof result?.startedAt === 'string' ? Date.parse(result.startedAt) : Number.NaN
      const finished = typeof result?.finishedAt === 'string' ? Date.parse(result.finishedAt) : Number.NaN
      assert(result?.id === expected.id && result?.command === expected.command, `stable release gate command result ${index + 1} has the wrong identity`)
      assert(result?.result === 'passed' && result?.exitCode === 0, `${expected.id}: stable release command did not pass`)
      assert(Number.isFinite(started) && Number.isFinite(finished) && finished >= started, `${expected.id}: stable release command lacks valid execution timestamps`)
      assert(Number.isInteger(result?.durationMs) && result.durationMs === finished - started, `${expected.id}: stable release command duration is inconsistent`)
    }

    const finalFinishedAt = typeof commandResults.at(-1)?.finishedAt === 'string' ? Date.parse(commandResults.at(-1).finishedAt) : Number.NaN
    const reportTimestamp = typeof stable.timestamp === 'string' ? Date.parse(stable.timestamp) : Number.NaN
    assert(Number.isFinite(reportTimestamp) && Number.isFinite(finalFinishedAt) && reportTimestamp >= finalFinishedAt, 'stable release report timestamp must follow the final command')
  }
  return errors
}

const defaultExecute = async (step, root) => {
  const command = step.file === 'corepack' ? await resolveCorepackCommand(step.args) : step
  return new Promise((resolveExecution) => {
    const child = spawn(command.file, command.args, {
      cwd: root,
      env: { ...process.env, ...step.env },
      stdio: 'inherit',
    })
    child.once('error', (error) => resolveExecution({ exitCode: null, diagnostic: error.message }))
    child.once('exit', (code, signal) => resolveExecution({
      exitCode: code,
      ...(signal ? { diagnostic: `terminated by signal ${signal}` } : {}),
    }))
  })
}

const writeAtomic = async (path, value) => {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function runStableReport({
  commit,
  output,
  root = resolve(import.meta.dirname, '../../..'),
  execute = defaultExecute,
  now = () => new Date(),
}) {
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) throw new Error('--commit must be a full Git commit')
  const resolvedRoot = resolve(root)
  const resolvedOutput = resolve(output ?? join(resolvedRoot, 'compat/reports/stable.json'))
  const commitCheck = await defaultExecute({ file: 'git', args: ['cat-file', '-e', `${commit}^{commit}`] }, resolvedRoot)
  if (commitCheck.exitCode !== 0) throw new Error('--commit must identify a Git commit in this repository')
  const lock = JSON.parse(await readFile(join(resolvedRoot, 'compat/upstream-lock.json'), 'utf8'))
  const commandResults = []

  for (const step of releaseCommands) {
    const started = now()
    let execution
    try {
      execution = await execute(step, resolvedRoot)
    } catch (error) {
      execution = { exitCode: null, diagnostic: error instanceof Error ? error.message : String(error) }
    }
    const finished = now()
    const exitCode = Number.isInteger(execution?.exitCode) ? execution.exitCode : null
    const passed = exitCode === 0
    commandResults.push({
      id: step.id,
      command: step.command,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: Math.max(0, finished.getTime() - started.getTime()),
      exitCode,
      result: passed ? 'passed' : 'failed',
      ...(execution?.diagnostic ? { diagnostic: sanitizeDiagnostic(execution.diagnostic) } : {}),
    })
    if (!passed) break
  }

  const passed = commandResults.length === releaseCommands.length && commandResults.every((result) => result.result === 'passed')
  const report = {
    schemaVersion: 1,
    channel: 'stable',
    evidenceKind: 'release-gate',
    liteCommit: commit,
    upstreamVersion: lock.harnessVersion,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    packageManager,
    selection: {
      packs: ['workspace', 'shell', 'research'],
      plugins: ['command-allowlist', 'health', 'safe-fetch', 'session-export', 'workspace-notes'],
    },
    packageInventory: lock.packages,
    commands: commandResults.map((result) => result.command),
    commandResults,
    result: passed ? 'passed' : 'failed',
    measured: true,
    timestamp: now().toISOString(),
    ...(!passed ? { diagnostics: [`Release command failed: ${commandResults.at(-1)?.id ?? 'unknown'}`] } : {}),
    limitations: [
      'This release gate records one native platform and architecture; it is not a universal compatibility claim.',
      'Windows remains planned/experimental until its native CI lane is blocking and passes.',
      'The real API smoke is a separate bounded maintainer check and is not run by public CI without credentials.',
    ],
  }

  await writeAtomic(resolvedOutput, report)
  if (!passed) throw new Error(`stable release gate failed at ${commandResults.at(-1)?.id ?? 'unknown'}`)
  return report
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = process.argv.slice(2)
  const valueAfter = (flag) => {
    const index = args.indexOf(flag)
    return index < 0 ? undefined : args[index + 1]
  }
  const root = resolve(import.meta.dirname, '../../..')
  const output = resolve(valueAfter('--output') ?? join(root, 'compat/reports/stable.json'))
  await runStableReport({ commit: valueAfter('--commit'), output, root })
  process.stdout.write(`stable release evidence written to ${output}\n`)
}
