import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { initialize, isSupportedNodeVersion, loadRegistry, main, resolveCliPath, type CliIo } from '../src/main.js'
import { resolveCurrentTree } from '@dsh-lite/core'

const valid = { schemaVersion: 1, upstream: { channel: 'stable', version: '0.1.0-rc.6' }, profile: 'chat-only', packs: [], plugins: [] }

const io = (): CliIo & { stdout: string[]; stderr: string[] } => {
  const stdout: string[] = []
  const stderr: string[] = []
  return { cwd: process.cwd(), platform: 'linux', stdout, stderr, out: (line) => stdout.push(line), err: (line) => stderr.push(line) }
}

describe('diagnostic CLI', () => {
  it('enforces the repository Node engine boundaries', () => {
    expect(isSupportedNodeVersion('22.18.9')).toBe(false)
    expect(isSupportedNodeVersion('22.19.0')).toBe(true)
    expect(isSupportedNodeVersion('23.9.0')).toBe(false)
    expect(isSupportedNodeVersion('24.0.0')).toBe(true)
    expect(isSupportedNodeVersion('not-a-version')).toBe(false)
  })

  it('discovers catalog additions and rejects plugin claims without a public implementation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-catalog-'))
    const path = join(root, 'catalog.json')
    await writeFile(path, JSON.stringify({ packs: ['@dsh-lite/pack-research'], plugins: [], presets: { 'chat-only': [], developer: ['research'] } }))
    await expect(loadRegistry(path)).resolves.toMatchObject({ packs: { research: { id: 'research' } }, presets: { developer: ['research'] } })
    await writeFile(path, JSON.stringify({ packs: [], plugins: [{ id: 'claimed', package: '@dsh-lite/plugin-missing' }], presets: { 'chat-only': [] } }))
    await expect(loadRegistry(path)).rejects.toThrow()
  })

  it('resolves Windows drive paths at the production CLI boundary', () => {
    expect(resolveCliPath('D:\\current', 'C:\\work\\repo', 'win32')).toBe('C:\\work\\repo')
    expect(resolveCliPath('D:\\current', 'relative\\repo', 'win32')).toBe('D:\\current\\relative\\repo')
  })

  it('initializes, diagnoses, and inspects a valid home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-'))
    const config = join(root, 'lite.json')
    const home = join(root, 'home')
    await writeFile(config, JSON.stringify(valid))
    const output = io()

    await expect(main(['init', '--config', config, '--home', home], output)).resolves.toBe(0)
    await expect(main(['doctor', '--home', home], output)).resolves.toBe(0)
    await expect(main(['inspect', '--home', home], output)).resolves.toBe(0)
    const current = await resolveCurrentTree(home)
    const profile = await resolveCurrentTree(join(current, 'profile'))
    const packageJson = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    const doctor = JSON.parse(output.stdout[1]!) as unknown
    const inspection = JSON.parse(output.stdout[2]!) as unknown

    expect(JSON.parse(await readFile(join(current, 'resolved.json'), 'utf8'))).toMatchObject({ profile: 'chat-only', packIds: [] })
    expect(doctor).toEqual({
      schemaVersion: 1,
      status: 'ok',
      checks: {
        node: { status: 'pass', version: process.versions.node, engine: '^22.19.0 || >=24', satisfies: true },
        home: { status: 'pass', writable: true },
        current: { status: 'pass', validated: true },
        profile: { status: 'pass', validated: true, closureId: 'linux-chat-only' },
        runtime: { status: 'pass', activated: true },
        secretHygiene: { status: 'pass', plaintextCredentials: false },
      },
    })
    expect(inspection).toEqual({
      schemaVersion: 1,
      identity: {
        profile: 'chat-only',
        closureId: 'linux-chat-only',
        upstream: { channel: 'stable', version: '0.1.0-rc.6' },
      },
      platform: 'linux',
      arch: process.arch,
      packageNames: Object.keys(packageJson.dependencies).sort(),
      packageVersions: packageJson.dependencies,
      cordisRows: [],
      packIds: [],
      pluginIds: [],
    })
  })

  it('materializes enabled packs during init without enabling optional packs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-'))
    const config = join(root, 'lite.json')
    const home = join(root, 'home')
    await writeFile(config, JSON.stringify({ ...valid, profile: 'developer', packs: ['workspace'] }))

    expect(await main(['init', '--config', config, '--home', home], io())).toBe(0)
    const current = await resolveCurrentTree(home)
    const profile = await resolveCurrentTree(join(current, 'profile'))
    const packageJson = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    const resolved = JSON.parse(await readFile(join(current, 'resolved.json'), 'utf8')) as { pluginIds: string[] }
    const cordis = await readFile(join(profile, 'cordis.yml'), 'utf8')

    expect(packageJson.dependencies).toEqual(Object.fromEntries([
      '@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-attachment', '@deepseek-ai/dsh-brand',
      '@deepseek-ai/dsh-code-runtime', '@deepseek-ai/dsh-invariants', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-scope',
      '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-persistence', '@deepseek-ai/dsh-settings', '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-timeout', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-typert-protocol',
      '@deepseek-ai/dsh-user-approval', '@deepseek-ai/schemastery',
    ].map((name) => [name, name === '@deepseek-ai/cordis' ? '4.0.1' : name === '@deepseek-ai/schemastery' ? '3.18.1' : '0.1.0-rc.6'])))
    expect(JSON.parse(await readFile(join(profile, 'profile-state.json'), 'utf8'))).toEqual({
      state: 'ready',
      frozenInstall: true,
      activated: true,
      platform: 'linux',
      arch: process.arch,
      closureId: 'linux-workspace',
    })
    await expect(access(join(profile, 'pnpm-lock.yaml'))).resolves.toBeUndefined()
    await expect(access(join(profile, 'node_modules', '@deepseek-ai', 'dsh-tool-fs'))).rejects.toThrow()
    expect(resolved.pluginIds).toEqual(['session-export', 'workspace-notes'])
    expect(cordis).not.toContain('tool-fs')
    expect(cordis).not.toContain('tool-bash')
    expect(cordis).not.toContain('tool-web-fetch')
  })

  it('persists canonical pack order from reversed input and diagnoses the generated profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-pack-order-'))
    const config = join(root, 'lite.json')
    const home = join(root, 'home')
    await writeFile(config, JSON.stringify({ ...valid, profile: 'custom', packs: ['shell', 'workspace'] }))

    const output = io()
    output.platform = 'darwin'
    const exitCode = await main(['init', '--config', config, '--home', home], output)
    expect({ exitCode, stderr: output.stderr }).toEqual({ exitCode: 0, stderr: [] })
    const current = await resolveCurrentTree(home)
    expect(JSON.parse(await readFile(join(current, 'resolved.json'), 'utf8'))).toMatchObject({ packIds: ['workspace', 'shell'] })
    expect(await main(['doctor', '--home', home], output)).toBe(0)
    expect(await main(['inspect', '--home', home], output)).toBe(0)
    const profile = await resolveCurrentTree(join(current, 'profile'))
    const packageJson = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(JSON.parse(output.stdout.at(-1)!)).toEqual({
      schemaVersion: 1,
      identity: {
        profile: 'custom',
        closureId: 'darwin-workspace+shell',
        upstream: { channel: 'stable', version: '0.1.0-rc.6' },
      },
      platform: 'darwin',
      arch: process.arch,
      packageNames: Object.keys(packageJson.dependencies).sort(),
      packageVersions: packageJson.dependencies,
      cordisRows: [
        { id: 'subprocess', name: '@deepseek-ai/dsh-subprocess-local' },
        { id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local' },
        { id: 'sandbox-policy', name: '@deepseek-ai/dsh-sandbox-policy', config: { mode: 'workspace-write' } },
        { id: 'shell-env', name: '@deepseek-ai/dsh-shell-env' },
        { id: 'bash-sandbox', name: '@deepseek-ai/dsh-bash-sandbox' },
        { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
      ],
      packIds: ['workspace', 'shell'],
      pluginIds: ['command-allowlist', 'session-export', 'workspace-notes'],
    })
  })

  it('applies the developer workspace preset when packs are omitted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-'))
    const config = join(root, 'lite.json')
    const home = join(root, 'home')
    await writeFile(config, JSON.stringify({ ...valid, profile: 'developer' }))
    expect(await main(['init', '--config', config, '--home', home], io())).toBe(0)
    const current = await resolveCurrentTree(home)
    expect(JSON.parse(await readFile(join(current, 'resolved.json'), 'utf8'))).toMatchObject({ packIds: ['workspace'] })
  })

  it.each([
    [{ channel: 'stable', version: '0.1.0-rc.5' }, 'unsupported upstream'],
    [{ channel: 'latest', version: '0.1.0-rc.6' }, 'unsupported upstream'],
  ])('rejects incoherent upstream selection before creating a home', async (upstream, diagnostic) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-'))
    const config = join(root, 'lite.json')
    const home = join(root, 'home')
    await writeFile(config, JSON.stringify({ ...valid, upstream }))
    const output = io()
    expect(await main(['init', '--config', config, '--home', home], output)).toBe(1)
    expect(output.stderr).toEqual([diagnostic])
    await expect(access(home)).rejects.toThrow()
  })

  it('keeps the prior home unchanged when an init candidate is invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-'))
    const config = join(root, 'lite.json')
    const home = join(root, 'home')
    await writeFile(config, JSON.stringify(valid))
    expect(await main(['init', '--config', config, '--home', home], io())).toBe(0)
    const beforeTree = await resolveCurrentTree(home)
    const before = await readFile(join(beforeTree, 'lite.config.json'), 'utf8')
    await writeFile(config, JSON.stringify({ ...valid, packs: ['missing'] }))

    expect(await main(['init', '--config', config, '--home', home], io())).toBe(1)
    expect(await readFile(join(await resolveCurrentTree(home), 'lite.config.json'), 'utf8')).toBe(before)
  })

  it('keeps the prior home unchanged when the assembled runtime candidate fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-runtime-candidate-'))
    const config = join(root, 'lite.json')
    const home = join(root, 'home')
    await writeFile(config, JSON.stringify(valid))
    expect(await main(['init', '--config', config, '--home', home], io())).toBe(0)
    const beforeTree = await resolveCurrentTree(home)

    await expect(initialize(config, home, 'linux', async () => { throw new Error('activation failed') }))
      .rejects.toThrow('activation failed')
    expect(await resolveCurrentTree(home)).toBe(beforeTree)
  })

  it('never includes malformed JSON contents in diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-'))
    const config = join(root, 'lite.json')
    const sentinel = 'SENTINEL_API_KEY_DO_NOT_PRINT'
    await writeFile(config, `{"apiKey":"${sentinel}",`)
    const output = io()

    expect(await main(['init', '--config', config, '--home', join(root, 'home')], output)).toBe(1)
    expect(output.stderr.join('\n')).toBe('invalid JSON in Lite configuration')
    expect(output.stderr.join('\n')).not.toContain(sentinel)
  })

  it('rejects plaintext credential fields without printing their values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-'))
    const config = join(root, 'lite.json')
    const sentinel = 'SENTINEL_PLAINTEXT_CREDENTIAL'
    await writeFile(config, JSON.stringify({ ...valid, apiKey: sentinel }))
    const output = io()

    expect(await main(['init', '--config', config, '--home', join(root, 'home')], output)).toBe(1)
    expect(output.stderr).toEqual(['Lite configuration must not contain plaintext credentials'])
    expect(output.stderr.join('\n')).not.toContain(sentinel)
  })

  it('reports mismatched stored state without printing its contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-'))
    const config = join(root, 'lite.json')
    const home = join(root, 'home')
    const sentinel = 'SENTINEL_STORED_SECRET'
    await writeFile(config, JSON.stringify(valid))
    expect(await main(['init', '--config', config, '--home', home], io())).toBe(0)
    const current = await resolveCurrentTree(home)
    await writeFile(join(current, 'resolved.json'), JSON.stringify({ ...valid, authorization: sentinel }))
    const output = io()

    expect(await main(['inspect', '--home', home], output)).toBe(1)
    expect(output.stderr).toEqual(['stored Lite state does not match configuration'])
    expect([...output.stdout, ...output.stderr].join('\n')).not.toContain(sentinel)
  })

  it('reports corrupt stored state without printing parser fragments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-'))
    const config = join(root, 'lite.json')
    const home = join(root, 'home')
    const sentinel = 'SENTINEL_CORRUPT_STATE'
    await writeFile(config, JSON.stringify(valid))
    expect(await main(['init', '--config', config, '--home', home], io())).toBe(0)
    const current = await resolveCurrentTree(home)
    await writeFile(join(current, 'resolved.json'), `{"token":"${sentinel}",`)
    const output = io()

    expect(await main(['doctor', '--home', home], output)).toBe(1)
    expect(output.stderr).toEqual(['invalid JSON in generated Lite state'])
    expect(output.stderr.join('\n')).not.toContain(sentinel)
  })

  it('refuses doctor when the generated profile is not ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-'))
    const config = join(root, 'lite.json')
    const home = join(root, 'home')
    await writeFile(config, JSON.stringify(valid))
    expect(await main(['init', '--config', config, '--home', home], io())).toBe(0)
    const current = await resolveCurrentTree(home)
    const profile = await resolveCurrentTree(join(current, 'profile'))
    await writeFile(join(profile, 'profile-state.json'), JSON.stringify({ state: 'pending-install' }))
    const output = io()
    expect(await main(['doctor', '--home', home], output)).toBe(1)
    expect(output.stderr).toEqual(['generated profile is not ready'])
  })

  it.each(['pnpm-lock.yaml', 'package'])('refuses doctor and run when the installed profile has corrupt %s state', async (corruption) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-'))
    const config = join(root, 'lite.json')
    const home = join(root, 'home')
    await writeFile(config, JSON.stringify(valid))
    expect(await main(['init', '--config', config, '--home', home], io())).toBe(0)
    const current = await resolveCurrentTree(home)
    const profile = await resolveCurrentTree(join(current, 'profile'))
    if (corruption === 'pnpm-lock.yaml') await writeFile(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    else await rm(join(profile, 'node_modules', '@deepseek-ai', 'dsh-tools'), { recursive: true, force: true })

    for (const command of [['doctor'], ['run', 'ping']] as const) {
      const output = io()
      expect(await main([...command, '--home', home], output)).toBe(1)
      expect(output.stderr).toEqual(['generated profile is not ready'])
    }
  })

  it('refuses a profile directory whose closure does not match the resolved configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-'))
    const chatConfig = join(root, 'chat.json')
    const workspaceConfig = join(root, 'workspace.json')
    const chatHome = join(root, 'chat-home')
    const workspaceHome = join(root, 'workspace-home')
    await writeFile(chatConfig, JSON.stringify(valid))
    await writeFile(workspaceConfig, JSON.stringify({ ...valid, profile: 'developer', packs: ['workspace'] }))
    expect(await main(['init', '--config', chatConfig, '--home', chatHome], io())).toBe(0)
    expect(await main(['init', '--config', workspaceConfig, '--home', workspaceHome], io())).toBe(0)
    const chatCurrent = await resolveCurrentTree(chatHome)
    const workspaceCurrent = await resolveCurrentTree(workspaceHome)
    await rm(join(chatCurrent, 'profile'), { recursive: true })
    await import('node:fs/promises').then(({ symlink }) => symlink(join(workspaceCurrent, 'profile'), join(chatCurrent, 'profile')))

    const output = io()
    expect(await main(['doctor', '--home', chatHome], output)).toBe(1)
    expect(output.stderr).toEqual(['generated profile is not ready'])
  })

  it('redacts untrusted identifiers from validation errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-'))
    const config = join(root, 'lite.json')
    const sentinel = 'SENTINEL_PLUGIN_SECRET'
    await writeFile(config, JSON.stringify({ ...valid, plugins: [sentinel] }))
    const output = io()

    expect(await main(['init', '--config', config, '--home', join(root, 'home')], output)).toBe(1)
    expect(output.stderr).toEqual(['Lite configuration references an unknown plugin'])
    expect(output.stderr.join('\n')).not.toContain(sentinel)
  })

  it('fails a run without credentials without exposing unrelated environment secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-'))
    const config = join(root, 'lite.json')
    const home = join(root, 'home')
    await writeFile(config, JSON.stringify(valid))
    expect(await main(['init', '--config', config, '--home', home], io())).toBe(0)
    const previousKey = process.env.DEEPSEEK_API_KEY
    const sentinel = 'SENTINEL_CLI_ENV_SECRET'
    process.env.DEEPSEEK_API_KEY = ''
    process.env.DSH_LITE_TEST_SECRET = sentinel
    const output = io()

    try {
      expect(await main(['run', 'ping', '--home', home], output)).toBe(1)
    } finally {
      if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previousKey
      delete process.env.DSH_LITE_TEST_SECRET
    }
    expect(output.stderr).toEqual(['task did not complete'])
    expect([...output.stdout, ...output.stderr].join('\n')).not.toContain(sentinel)
  })
})
