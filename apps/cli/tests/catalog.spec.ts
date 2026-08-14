import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadRegistry, validateCatalogPlugin } from '../src/main.js'

async function writeCatalog(root: string, packageSpecifier: string): Promise<string> {
  const path = join(root, 'catalog.json')
  await writeFile(path, JSON.stringify({
    packs: [],
    plugins: [{ id: 'fixture', package: packageSpecifier }],
    presets: { 'chat-only': [] },
  }))
  return path
}

describe('catalog plugin validation', () => {
  it('activates and disposes every bundled plugin from the default catalog', async () => {
    await expect(loadRegistry()).resolves.toMatchObject({
      plugins: {
        health: { package: '@dsh-lite/plugin-health' },
        'safe-fetch': { package: '@dsh-lite/plugin-safe-fetch' },
        'workspace-notes': { package: '@dsh-lite/plugin-workspace-notes' },
        'command-allowlist': { package: '@dsh-lite/plugin-command-allowlist' },
        'session-export': { package: '@dsh-lite/plugin-session-export' },
      },
    })
  })

  it('rejects an arbitrary resolvable package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-catalog-'))
    await expect(loadRegistry(await writeCatalog(root, '@dsh-lite/runtime'))).rejects.toThrow('invalid Lite catalog plugin')
  })

  it('rejects a module that exports plain data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-catalog-'))
    const modulePath = join(root, 'plain-data.mjs')
    await writeFile(modulePath, 'export default { name: "plain-data", value: 1 }\n')

    await expect(loadRegistry(await writeCatalog(root, modulePath))).rejects.toThrow('invalid Lite catalog plugin')
  })

  it('activates and disposes a named Cordis plugin through the validator', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-catalog-'))
    const eventsPath = join(root, 'events.txt')
    const modulePath = join(root, 'valid-plugin.mjs')
    await writeFile(modulePath, [
      'import { appendFileSync } from "node:fs"',
      `const eventsPath = ${JSON.stringify(eventsPath)}`,
      'const plugin = () => {',
      '  appendFileSync(eventsPath, "activated\\n")',
      '  return () => appendFileSync(eventsPath, "disposed\\n")',
      '}',
      'Object.defineProperty(plugin, "name", { value: "catalogFixture" })',
      'export default plugin',
      '',
    ].join('\n'))

    await expect(validateCatalogPlugin(modulePath)).resolves.toBeUndefined()
    await expect(readFile(eventsPath, 'utf8')).resolves.toBe('activated\ndisposed\n')
  })

  it('rejects a bundled id mapped to a different package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-catalog-'))
    await expect(loadRegistry(await writeCatalog(root, '@dsh-lite/plugin-health')))
      .rejects.toThrow('invalid Lite catalog plugin mapping')
  })

  it('disposes host services after catalog validation', async () => {
    let context: { tools?: unknown; systemPrompt?: unknown } | undefined
    await validateCatalogPlugin('@dsh-lite/plugin-health', (value) => { context = value })
    expect(context?.tools).toBeUndefined()
    expect(context?.systemPrompt).toBeUndefined()
  })
})
