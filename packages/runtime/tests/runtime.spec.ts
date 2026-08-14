import { inspect } from 'node:util'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { bootRuntime, chatOnly } from '../src/index.js'
import { loadPackManifest, materializeProfile } from '@dsh-lite/core'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveCurrentTree, validateInstalledProfile } from '@dsh-lite/core'

const nativePlatform = process.platform as 'darwin' | 'linux' | 'win32'

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly answer: string) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.answer } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const scriptedAdapter = (answer: string): ScriptedAdapter => new ScriptedAdapter(answer)

describe('official minimal runtime', () => {
  it('boots the official agent spine', async () => {
    const adapter = scriptedAdapter('hello')
    const runtime = await bootRuntime({ profile: chatOnly, adapter })

    expect(runtime.context.agents).toBeDefined()
    expect(runtime.context.sessions).toBeDefined()
    expect(runtime.context.llm).toBeDefined()
    await runtime.dispose()
  })

  it('keeps the chat-only inventory free of heavy capability families', () => {
    expect(chatOnly.packageNames.some(name => /web|subagent|workflow|mcp|lsp|terminal/.test(name))).toBe(false)
  })

  it('mounts only explicitly selected bundled plugin tools', async () => {
    const health = await bootRuntime({ profile: { ...chatOnly, pluginIds: ['health'] }, adapter: scriptedAdapter('ok') })
    const none = await bootRuntime({ profile: chatOnly, adapter: scriptedAdapter('ok') })
    try {
      expect(health.context.tools.schemas().map(tool => tool.name)).toContain('lite_health')
      expect(none.context.tools.schemas().map(tool => tool.name)).not.toContain('lite_health')
    } finally {
      await health.dispose()
      await none.dispose()
    }
  })

  it('mounts the shell policy with a usable read-only default', async () => {
    const runtime = await bootRuntime({
      profile: { ...chatOnly, pluginIds: ['command-allowlist'] },
      adapter: scriptedAdapter('ok'),
    })
    const fixture = runtime.context.tools.register({
      name: 'bash',
      description: 'fixture',
      parameters: { command: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      async execute() { return 'ran' },
    })
    try {
      const signal = new AbortController().signal
      const allowed = await runtime.context.tools.execute({ callId: 'allowed' as never, name: 'bash', arguments: { command: 'git status' }, signal })
      expect(allowed.isError, JSON.stringify(allowed)).toBe(false)
      await expect(runtime.context.tools.execute({ callId: 'denied' as never, name: 'bash', arguments: { command: 'git push' }, signal }))
        .resolves.toMatchObject({ isError: true })
    } finally {
      fixture()
      await runtime.dispose()
    }
  })

  it('mounts a validated generated profile and removes its tools when the pack is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-runtime-profile-'))
    const workspace = await loadPackManifest(resolve('packages/packs/workspace/pack.json'))
    await materializeProfile([workspace], join(root, 'workspace'), nativePlatform)
    await materializeProfile([], join(root, 'chat'), nativePlatform)
    const workspaceProfile = await validateInstalledProfile(await resolveCurrentTree(join(root, 'workspace')))
    const chatProfile = await validateInstalledProfile(await resolveCurrentTree(join(root, 'chat')))

    await expect(bootRuntime({ profile: chatOnly, profileDir: workspaceProfile.profileDir, platform: nativePlatform })).rejects.toThrow('closure')
    const workspaceResolved = { ...chatOnly, profile: 'developer', packIds: ['workspace'], pluginIds: ['session-export', 'workspace-notes'] }
    const withWorkspace = await bootRuntime({ profile: workspaceResolved, profileDir: workspaceProfile.profileDir, platform: nativePlatform })
    const withoutWorkspace = await bootRuntime({ profile: chatOnly, profileDir: chatProfile.profileDir, platform: nativePlatform })
    try {
      const workspaceTools = withWorkspace.context.tools.schemas().map((tool) => tool.name)
      const chatTools = withoutWorkspace.context.tools.schemas().map((tool) => tool.name)
      expect(workspaceTools).toEqual(expect.arrayContaining(['lite_session_export', 'lite_notes']))
      expect(workspaceTools).not.toEqual(expect.arrayContaining(['read', 'write']))
      expect(chatTools).not.toEqual(expect.arrayContaining(['read', 'write']))
    } finally {
      await withWorkspace.dispose()
      await withoutWorkspace.dispose()
    }
  })

  it('mounts a profile materialized from reversed pack input against canonical resolved pack ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-runtime-order-'))
    const workspace = await loadPackManifest(resolve('packages/packs/workspace/pack.json'))
    const shell = await loadPackManifest(resolve('packages/packs/shell/pack.json'))
    await materializeProfile([shell, workspace], join(root, 'profile'), nativePlatform)
    const profileDir = await resolveCurrentTree(join(root, 'profile'))
    const runtime = await bootRuntime({
      profile: {
        ...chatOnly,
        profile: 'custom',
        packIds: ['workspace', 'shell'],
        pluginIds: ['command-allowlist', 'session-export', 'workspace-notes'],
      },
      profileDir,
      platform: nativePlatform,
    })
    try {
      const tools = runtime.context.tools.schemas().map((tool) => tool.name)
      expect(tools).toEqual(expect.arrayContaining(['lite_notes', nativePlatform === 'win32' ? 'pwsh' : 'bash']))
      expect(tools).not.toEqual(expect.arrayContaining(['read', 'write']))
    } finally {
      await runtime.dispose()
    }
  }, 30_000)

  it('keeps the research profile on the bounded Lite fetch tool', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-runtime-research-'))
    const research = await loadPackManifest(resolve('packages/packs/research/pack.json'))
    await materializeProfile([research], join(root, 'profile'), nativePlatform)
    const profileDir = await resolveCurrentTree(join(root, 'profile'))
    const runtime = await bootRuntime({
      profile: { ...chatOnly, profile: 'custom', packIds: ['research'], pluginIds: ['safe-fetch'] },
      profileDir,
      platform: nativePlatform,
    })
    try {
      const tools = runtime.context.tools.schemas().map((tool) => tool.name)
      expect(tools).toContain('lite_safe_fetch')
      expect(tools).not.toContain('web_fetch')
    } finally {
      await runtime.dispose()
    }
  })

  it('does not retain credentials in enumerable or serializable runtime state', async () => {
    const previous = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = 'SENTINEL_RUNTIME_STATE_KEY'
    let runtime: Awaited<ReturnType<typeof bootRuntime>> | undefined
    try {
      runtime = await bootRuntime({ profile: chatOnly })
      expect(JSON.stringify(runtime)).not.toContain('SENTINEL_RUNTIME_STATE_KEY')
      expect(inspect(runtime)).not.toContain('SENTINEL_RUNTIME_STATE_KEY')
    } finally {
      await runtime?.dispose()
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previous
    }
  })

  it('rejects runtime initialization after mounted services when a plugin is unsupported', async () => {
    await expect(bootRuntime({
      profile: { ...chatOnly, pluginIds: ['missing'] },
      adapter: scriptedAdapter('unused'),
    })).rejects.toThrow('unsupported bundled plugin')
  })
})
