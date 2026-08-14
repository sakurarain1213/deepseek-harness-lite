import { execFile } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('compatibility asset generation', () => {
  it('checks the full committed matrix without mutating it and detects stale files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-compat-check-'))
    const fixture = join(root, 'compat')
    await cp(resolve('packages/core/compat/0.1.0-rc.6'), fixture, { recursive: true })
    const before = await readFile(join(fixture, 'closures.json'), 'utf8')
    await expect(execFileAsync(process.execPath, ['scripts/generate-compatibility-assets.mjs', '--check', '--output', fixture], { cwd: resolve('.') })).resolves.toBeDefined()
    expect(await readFile(join(fixture, 'closures.json'), 'utf8')).toBe(before)

    await writeFile(join(fixture, 'locks', 'stale.yaml'), 'stale\n')
    await expect(execFileAsync(process.execPath, ['scripts/generate-compatibility-assets.mjs', '--check', '--output', fixture], { cwd: resolve('.') })).rejects.toThrow()
  }, 30_000)

  it('regenerates missing output from integrity-pinned canonical seeds and rejects altered output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-compat-bootstrap-'))
    const fixture = join(root, 'compat')
    await expect(execFileAsync(process.execPath, ['scripts/generate-compatibility-assets.mjs', '--output', fixture], { cwd: resolve('.') })).resolves.toBeDefined()
    await expect(execFileAsync(process.execPath, ['scripts/generate-compatibility-assets.mjs', '--check', '--output', fixture], { cwd: resolve('.') })).resolves.toBeDefined()

    const lock = join(fixture, 'locks', 'linux-chat-only.yaml')
    await writeFile(lock, (await readFile(lock, 'utf8')).replace('integrity: sha512-', 'integrity: sha512-altered'))
    await expect(execFileAsync(process.execPath, ['scripts/generate-compatibility-assets.mjs', '--check', '--output', fixture], { cwd: resolve('.') })).rejects.toThrow()

    await rm(fixture, { recursive: true })
    await expect(execFileAsync(process.execPath, ['scripts/generate-compatibility-assets.mjs', '--check', '--output', fixture], { cwd: resolve('.') })).rejects.toThrow()

    const seeds = join(root, 'seeds')
    await cp(resolve('compat/lock-seeds/0.1.0-rc.6'), seeds, { recursive: true })
    const seedLock = join(seeds, 'locks', 'linux.yaml')
    await writeFile(seedLock, (await readFile(seedLock, 'utf8')).replace('integrity: sha512-', 'integrity: sha512-altered'))
    await expect(execFileAsync(process.execPath, ['scripts/generate-compatibility-assets.mjs', '--output', fixture, '--seed-root', seeds], { cwd: resolve('.') })).rejects.toThrow()
  }, 30_000)
})
