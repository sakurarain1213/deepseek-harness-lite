import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { type LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import CommandAllowlist, { DEFAULT_LITE_COMMAND_RULES } from '@dsh-lite/plugin-command-allowlist'
import Health from '@dsh-lite/plugin-health'
import SafeFetch from '@dsh-lite/plugin-safe-fetch'
import SessionExport from '@dsh-lite/plugin-session-export'
import WorkspaceNotes from '@dsh-lite/plugin-workspace-notes'
import { validateInstalledProfile, type ResolvedProfile } from '@dsh-lite/core'
import type { Platform } from '@dsh-lite/core'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { createDeepSeekAdapter, DEFAULT_DEEPSEEK_MODEL } from './provider.js'

const OFFICIAL_CHAT_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
] as const

export const BUNDLED_PLUGIN_PACKAGES = Object.freeze({
  'command-allowlist': '@dsh-lite/plugin-command-allowlist',
  health: '@dsh-lite/plugin-health',
  'safe-fetch': '@dsh-lite/plugin-safe-fetch',
  'session-export': '@dsh-lite/plugin-session-export',
  'workspace-notes': '@dsh-lite/plugin-workspace-notes',
} as const)

export interface RuntimeProfile extends ResolvedProfile {
  readonly packageNames: readonly string[]
}

export const chatOnly: RuntimeProfile = Object.freeze({
  schemaVersion: 1,
  upstream: { channel: 'stable', version: '0.1.0-rc.6' },
  profile: 'chat-only',
  packIds: [],
  pluginIds: [],
  packageNames: OFFICIAL_CHAT_PACKAGES,
} satisfies RuntimeProfile)

export interface BootRuntimeOptions {
  profile: ResolvedProfile | RuntimeProfile
  profileDir?: string
  platform?: Platform
  adapter?: LlmAdapter
  workspace?: string
}

export interface LiteRuntime {
  readonly context: Context
  readonly profile: ResolvedProfile | RuntimeProfile
  readonly provider: string
  readonly model: string
  lastEvents?: readonly SessionEvent[]
  toJSON(): Record<string, unknown>
  dispose(): Promise<void>
}

async function mountBundledPlugins(context: Context, options: BootRuntimeOptions): Promise<void> {
  for (const id of options.profile.pluginIds) {
    if (id === 'health') {
      await context.plugin(Health, {
        runtime: `node-${process.versions.node}`,
        upstreamVersion: options.profile.upstream.version,
        profile: options.profile.profile,
        packs: [...options.profile.packIds],
        plugins: [...options.profile.pluginIds],
      })
    } else if (id === 'safe-fetch') {
      await context.plugin(SafeFetch, {})
    } else if (id === 'workspace-notes') {
      await context.plugin(WorkspaceNotes, { workspace: options.workspace ?? process.cwd() })
    } else if (id === 'command-allowlist') {
      await context.plugin(CommandAllowlist, { rules: [...DEFAULT_LITE_COMMAND_RULES] })
    } else if (id === 'session-export') {
      await context.plugin(SessionExport, {})
    } else {
      throw new Error(`unsupported bundled plugin "${id}"`)
    }
  }
}

export async function bootRuntime(options: BootRuntimeOptions): Promise<LiteRuntime> {
  const context = new Context()
  try {
    await context.plugin(LlmRuntime)
    await context.plugin(SessionStore)
    await context.plugin(SystemPrompt, { persona: 'You are a concise and helpful assistant.' })
    await context.plugin(ToolRuntime)
    await context.plugin(AgentRegistry)
    await context.plugin(AgentLoop, { agents: [] })
    if (options.profileDir) {
      const installed = await validateInstalledProfile(options.profileDir, {
        expected: { platform: options.platform ?? process.platform as Platform, packIds: options.profile.packIds },
      })
      await context.plugin(Loader, { baseUrl: pathToFileURL(join(installed.profileDir, 'cordis.yml')).href })
      await context.plugin(Include, { path: pathToFileURL(join(installed.profileDir, 'cordis.yml')).href })
      await context.loader.await()
    } else if (options.profile.profile !== 'chat-only') {
      throw new Error('generated runtime profiles require an installed profile directory')
    }
    await mountBundledPlugins(context, options)
    context.llm.registerAdapter(['deepseek-lite'], options.adapter ?? createDeepSeekAdapter())

    const runtime: LiteRuntime = {
      context,
      profile: options.profile,
      provider: 'deepseek-lite',
      model: process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL,
      toJSON() {
        return {
          profile: this.profile,
          provider: this.provider,
          model: this.model,
          ...(this.lastEvents === undefined ? {} : { lastEvents: this.lastEvents }),
        }
      },
      dispose: () => context.fiber.dispose(),
    }
    return runtime
  } catch (error) {
    await context.fiber.dispose()
    throw error
  }
}
