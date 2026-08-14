import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const repository = resolve('.')

describe('repository gates', () => {
  it('publishes install evidence for the actual checkout and the minimal core closure', async () => {
    const report = JSON.parse(await readFile(join(repository, 'compat/reports/install-size.json'), 'utf8')) as {
      profiles?: Record<string, { bytes?: number }>
    }
    expect(report.profiles?.checkout?.bytes).toBeGreaterThan(0)
    expect(report.profiles?.coreChatClosure?.bytes).toBeGreaterThan(0)
  })

  it('scans both tracked and untracked worktree files without scanning ignored dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-secret-scan-'))
    await execFileAsync('git', ['init'], { cwd: root })
    await writeFile(join(root, '.gitignore'), 'node_modules/\n')
    await writeFile(join(root, 'tracked.txt'), 'safe\n')
    await execFileAsync('git', ['add', '.'], { cwd: root })
    const detectedSecret = ['sk', 'test', 'abcdefghijklmnopqrstuvwxyz123456'].join('-')
    await writeFile(join(root, 'untracked.txt'), `DEEPSEEK_API_KEY=${detectedSecret}\n`)
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'node_modules', 'ignored.txt'), `DEEPSEEK_API_KEY=${['sk', 'ignored', 'abcdefghijklmnopqrstuvwxyz'].join('-')}\n`)

    await expect(execFileAsync(process.execPath, [join(repository, 'scripts/check-secrets.mjs'), '--root', root, '--no-history']))
      .rejects.toMatchObject({ stderr: expect.stringContaining('untracked.txt') })
  })

  it('scans staged blobs for generic ah-prefixed 64-hex credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-staged-secret-'))
    await execFileAsync('git', ['init'], { cwd: root })
    const stagedSecret = `ah-${'a'.repeat(64)}`
    await writeFile(join(root, 'staged.txt'), `${stagedSecret}\n`)
    await execFileAsync('git', ['add', 'staged.txt'], { cwd: root })
    await writeFile(join(root, 'staged.txt'), 'safe worktree content\n')

    await expect(execFileAsync(process.execPath, [join(repository, 'scripts/check-secrets.mjs'), '--root', root, '--no-history']))
      .rejects.toMatchObject({ stderr: expect.stringContaining('index:staged.txt') })
  })

  it('does not let NUL bytes or oversized blobs bypass the secret gate', async () => {
    const binaryRoot = await mkdtemp(join(tmpdir(), 'dsh-lite-binary-secret-'))
    await execFileAsync('git', ['init'], { cwd: binaryRoot })
    await writeFile(join(binaryRoot, 'binary.dat'), Buffer.concat([
      Buffer.from('safe\0'),
      Buffer.from(`ah-${'b'.repeat(64)}\n`),
    ]))
    await execFileAsync('git', ['add', 'binary.dat'], { cwd: binaryRoot })
    await expect(execFileAsync(process.execPath, [join(repository, 'scripts/check-secrets.mjs'), '--root', binaryRoot, '--no-history']))
      .rejects.toMatchObject({ stderr: expect.stringContaining('index:binary.dat') })

    const largeRoot = await mkdtemp(join(tmpdir(), 'dsh-lite-large-secret-'))
    await execFileAsync('git', ['init'], { cwd: largeRoot })
    await writeFile(join(largeRoot, 'large.bin'), Buffer.alloc(5 * 1024 * 1024 + 1))
    await expect(execFileAsync(process.execPath, [join(repository, 'scripts/check-secrets.mjs'), '--root', largeRoot, '--no-history']))
      .rejects.toMatchObject({ stderr: expect.stringContaining('large.bin') })
  })

  it('audits SPDX license data and rejects missing licenses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-license-'))
    const licenses = join(root, 'licenses.json')
    await writeFile(licenses, JSON.stringify({ MIT: [{ name: 'good', version: '1.0.0' }], UNKNOWN: [{ name: 'bad', version: '1.0.0' }] }))
    await expect(execFileAsync(process.execPath, [join(repository, 'scripts/check-licenses.mjs'), '--input', licenses]))
      .rejects.toMatchObject({ stderr: expect.stringContaining('bad@1.0.0') })
  })

  it('parses parenthesized SPDX expressions without treating operators as licenses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-spdx-'))
    const licenses = join(root, 'licenses.json')
    await writeFile(licenses, JSON.stringify({ '(MIT OR Apache-2.0) AND BSD-3-Clause': [{ name: 'good', version: '1.0.0' }] }))
    await expect(execFileAsync(process.execPath, [join(repository, 'scripts/check-licenses.mjs'), '--input', licenses]))
      .resolves.toMatchObject({ stdout: expect.stringContaining('license audit passed') })
  })

  it('rejects malformed SPDX expressions instead of accepting allowed identifiers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-spdx-invalid-'))
    for (const expression of ['MIT OR', 'MIT WITH', '(MIT', 'MIT AND AND Apache-2.0']) {
      const licenses = join(root, `${expression.replaceAll(/[^A-Za-z0-9]/g, '_')}.json`)
      await writeFile(licenses, JSON.stringify({ [expression]: [{ name: 'bad', version: '1.0.0' }] }))
      await expect(execFileAsync(process.execPath, [join(repository, 'scripts/check-licenses.mjs'), '--input', licenses]))
        .rejects.toMatchObject({ stderr: expect.stringContaining('bad@1.0.0') })
    }
  })

  it('records unavailable rather than fabricated install measurements', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-measure-'))
    const output = join(root, 'report.json')
    await expect(execFileAsync(process.execPath, [
      join(repository, 'scripts/measure-install.mjs'),
      '--output', output,
      '--package-manager', join(root, 'missing-package-manager'),
    ])).rejects.toBeDefined()
    await expect(readFile(output, 'utf8')).resolves.toContain('"result": "unavailable"')
    await expect(readFile(output, 'utf8')).resolves.toContain('pnpm@10.15.0')
    await expect(readFile(output, 'utf8')).resolves.toContain('"registry"')
    await expect(readFile(output, 'utf8')).resolves.not.toMatch(/"bytes":\s*[1-9]/)
  })

  it('sanitizes and bounds diagnostics before reports persist them', async () => {
    const secret = `ah-${'c'.repeat(64)}`
    const source = `https://user:${secret}@registry.test/${'x'.repeat(800)}`
    const { stdout } = await execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      `import { sanitizeDiagnostic } from ${JSON.stringify(join(repository, 'packages/compat/bin/diagnostics.mjs'))}; process.stdout.write(sanitizeDiagnostic(process.env.SENTINEL))`,
    ], { env: { ...process.env, SENTINEL: source } })

    expect(stdout).toContain('https://[redacted]@registry.test/')
    expect(stdout).not.toContain(secret)
    expect(stdout.length).toBeLessThanOrEqual(512)
  })

  it('redacts registry credentials from unavailable upstream reports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-upstream-error-'))
    const output = join(root, 'report.json')
    const secret = `ah-${'d'.repeat(64)}`
    const registry = `http://user:${secret}@127.0.0.1:1/`

    await expect(execFileAsync(process.execPath, [
      join(repository, 'packages/compat/bin/upstream-report.mjs'), '--channel', 'latest', '--output', output,
    ], {
      env: {
        ...process.env,
        NPM_CONFIG_FETCH_RETRIES: '0',
        NPM_CONFIG_FETCH_TIMEOUT: '1000',
        NPM_CONFIG_REGISTRY: registry,
      },
    }))
      .rejects.toBeDefined()
    const report = await readFile(output, 'utf8')
    expect(report).toContain('"result": "unavailable"')
    expect(report).not.toContain(secret)
  })

  it('renders the public plugin catalog from canonical evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-catalog-'))
    const input = join(root, 'plugins.json')
    await writeFile(input, JSON.stringify({
      schemaVersion: 1,
      plugins: [{
        id: 'health', package: '@dsh-lite/plugin-health', description: 'Sanitized health diagnostics.',
        status: 'bundled', recommended: true, sourceCommit: 'a'.repeat(40), lastVerifiedAt: '2026-08-14T00:00:00.000Z',
      }],
    }))

    const { stdout } = await execFileAsync(process.execPath, [
      join(repository, 'packages/compat/bin/catalog-readme.mjs'), '--input', input, '--stdout',
    ])
    expect(stdout).toContain('| `health` | `@dsh-lite/plugin-health` | bundled | yes |')
    expect(stdout).toContain('aaaaaaaaaaaa')
  })

  it('writes stable release evidence only after executing every release gate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-stable-report-'))
    const output = join(root, 'stable.json')
    const { stdout: commit } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository })
    // @ts-expect-error The release gate is an executable ESM module rather than a published TypeScript API.
    const { releaseCommands, runStableReport } = await import('../bin/stable-report.mjs')
    const executed: string[] = []
    await runStableReport({
      commit: commit.trim(),
      output,
      root: repository,
      execute: async (command: { command: string }) => {
        executed.push(command.command)
        return { exitCode: 0 }
      },
    })
    const report = JSON.parse(await readFile(output, 'utf8')) as Record<string, any>
    expect(report).toMatchObject({ result: 'passed', measured: true, liteCommit: commit.trim(), arch: process.arch })
    expect(report.selection.plugins).toHaveLength(5)
    expect(executed).toEqual(releaseCommands.map((command: { command: string }) => command.command))
    expect(report.commands).toEqual(executed)
    expect(report.commandResults).toHaveLength(releaseCommands.length)
    expect(report.commandResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'secrets', command: 'corepack pnpm@10.15.0 check:secrets', exitCode: 0, result: 'passed' }),
    ]))
  })

  it('does not mark stable evidence passed when a release command fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-stable-failure-'))
    const output = join(root, 'stable.json')
    const { stdout: commit } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository })
    // @ts-expect-error The release gate is an executable ESM module rather than a published TypeScript API.
    const { runStableReport } = await import('../bin/stable-report.mjs')

    await expect(runStableReport({
      commit: commit.trim(),
      output,
      root: repository,
      execute: async (command: { id: string }) => ({ exitCode: command.id === 'typecheck' ? 2 : 0 }),
    })).rejects.toThrow('typecheck')

    const report = JSON.parse(await readFile(output, 'utf8')) as Record<string, any>
    expect(report).toMatchObject({ result: 'failed', measured: true })
    expect(report.commandResults.at(-1)).toMatchObject({ id: 'typecheck', exitCode: 2, result: 'failed' })
    expect(report.commandResults).toHaveLength(3)
  })

  it('verifies the committed JSON reports and GitHub workflow contracts', async () => {
    await expect(execFileAsync(process.execPath, [join(repository, 'scripts/verify-repo.mjs')], { cwd: repository }))
      .resolves.toMatchObject({ stdout: expect.stringContaining('repository verification passed') })
  })

  it('rejects command-name-only evidence in explicit release validation', async () => {
    // @ts-expect-error The release gate is an executable ESM module rather than a published TypeScript API.
    const { releaseEvidenceErrors } = await import('../bin/stable-report.mjs')
    const sourceCommit = 'a'.repeat(40)
    const plugins = ['command-allowlist', 'health', 'safe-fetch', 'session-export', 'workspace-notes'].map((id) => ({
      id,
      status: 'bundled',
      sourceCommit,
    }))
    const report = {
      schemaVersion: 1,
      channel: 'stable',
      evidenceKind: 'release-gate',
      liteCommit: sourceCommit,
      platform: 'linux',
      arch: 'x64',
      nodeVersion: '22.19.0',
      packageManager: 'pnpm@10.15.0',
      selection: { packs: ['workspace', 'shell', 'research'], plugins: plugins.map((plugin) => plugin.id) },
      commands: [
        'CI=1 corepack pnpm@10.15.0 install --frozen-lockfile',
        'corepack pnpm@10.15.0 test',
        'corepack pnpm@10.15.0 typecheck',
        'corepack pnpm@10.15.0 lint',
        'corepack pnpm@10.15.0 build',
        'corepack pnpm@10.15.0 verify:repo',
        'corepack pnpm@10.15.0 check:secrets',
        'corepack pnpm@10.15.0 check:licenses',
        'corepack pnpm@10.15.0 compat:check',
        'corepack pnpm@10.15.0 measure:install',
      ],
      commandResults: [],
      result: 'passed',
      measured: true,
      timestamp: '2026-08-14T00:00:00.000Z',
    }

    expect(releaseEvidenceErrors({ stable: report, plugins, commitExists: () => true }))
      .toContain('stable release gate must contain one result for every release command')
  })
})
