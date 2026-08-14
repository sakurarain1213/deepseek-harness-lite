import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('packed Core production surface', () => {
  it('materializes from committed assets without Core dev dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-packed-core-'))
    const tarball = join(root, 'core.tgz')
    await execFileAsync('pnpm', ['pack', '--out', tarball], { cwd: resolve('packages/core') })
    await writeFile(join(root, 'package.json'), `${JSON.stringify({ private: true, type: 'module', dependencies: { '@dsh-lite/core': `file:${tarball}` } }, null, 2)}\n`)
    await execFileAsync('pnpm', ['install', '--ignore-workspace', '--prod', '--ignore-scripts'], { cwd: root })

    await expect(access(join(root, 'node_modules/@deepseek-ai/dsh-tool-fs'))).rejects.toThrow()
    await expect(readFile(join(root, 'node_modules/@dsh-lite/core/compat/0.1.0-rc.6/closures.json'), 'utf8')).resolves.toContain('darwin-chat-only')

    const script = `
      import { materializeProfile, resolveCurrentTree, validateInstalledProfile } from '@dsh-lite/core'
      const target = ${JSON.stringify(join(root, 'profile'))}
      const result = await materializeProfile([], target, ${JSON.stringify(process.platform)})
      const profile = await resolveCurrentTree(target)
      const validated = await validateInstalledProfile(profile, { expected: { platform: ${JSON.stringify(process.platform)}, packIds: [] } })
      process.stdout.write(JSON.stringify({ packages: result.packageNames.length, closureId: validated.closureId }))
    `
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], { cwd: root })
    expect(JSON.parse(stdout)).toEqual({ packages: 18, closureId: `${process.platform}-chat-only` })
  }, 30_000)
})
