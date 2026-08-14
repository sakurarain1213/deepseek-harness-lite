import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const readJson = async (path: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>

describe('public repository integration', () => {
  it('includes every bundled plugin in the workspace and root verification gates', async () => {
    const workspace = await readFile('pnpm-workspace.yaml', 'utf8')
    const root = await readJson('package.json') as { scripts?: Record<string, string> }
    expect(workspace).toContain('plugins/*')
    expect(root.scripts).toMatchObject({
      lint: expect.any(String),
      'test:plugins': expect.stringContaining('plugins/vitest.config.ts'),
      'verify:repo': 'node scripts/verify-repo.mjs',
      'check:secrets': 'node scripts/check-secrets.mjs',
      'check:licenses': 'node scripts/check-licenses.mjs',
      'measure:install': 'node scripts/measure-install.mjs',
      'smoke:api': 'node scripts/real-api-smoke.mjs',
    })
    expect(root.scripts?.test).toContain('test:plugins')
  })

  it('declares five bundled plugins in the CLI and evidence catalog', async () => {
    const cli = await readJson('apps/cli/catalog.json') as { plugins?: Array<{ id: string; package: string }> }
    const catalog = await readJson('catalog/plugins.json') as { plugins?: Array<{ id: string }> }
    const expected = ['command-allowlist', 'health', 'safe-fetch', 'session-export', 'workspace-notes']
    expect(cli.plugins?.map(({ id }) => id).sort()).toEqual(expected)
    expect(catalog.plugins?.map(({ id }) => id).sort()).toEqual(expected)
  })
})
