import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

interface UpstreamLock {
  harnessVersion: string
  packages: Record<string, string>
}

const expectedClosure = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-bash-local',
  '@deepseek-ai/dsh-bash-sandbox',
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-code-runtime',
  '@deepseek-ai/dsh-fs',
  '@deepseek-ai/dsh-fs-local',
  '@deepseek-ai/dsh-fs-observation-policy',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-jobs',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-output-retention',
  '@deepseek-ai/dsh-pwsh-local',
  '@deepseek-ai/dsh-pwsh-sandbox',
  '@deepseek-ai/dsh-sandbox',
  '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-persistence',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-shell',
  '@deepseek-ai/dsh-shell-env',
  '@deepseek-ai/dsh-spill',
  '@deepseek-ai/dsh-subprocess',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-timeout',
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-tool-pwsh',
  '@deepseek-ai/dsh-tool-web',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-user-approval',
  '@deepseek-ai/dsh-web',
  '@deepseek-ai/dsh-web-fetch-http',
  '@deepseek-ai/schemastery',
]

it('records the complete coherent official runtime dependency closure', async () => {
  const lock = JSON.parse(await readFile('compat/upstream-lock.json', 'utf8')) as UpstreamLock
  const packagedLock = JSON.parse(await readFile('packages/core/compat/upstream-lock.json', 'utf8')) as UpstreamLock
  const runtime = JSON.parse(await readFile('packages/runtime/package.json', 'utf8')) as { dependencies: Record<string, string> }
  expect(Object.keys(lock.packages).sort()).toEqual(expectedClosure.sort())
  expect(packagedLock).toEqual(lock)
  for (const [name, version] of Object.entries(lock.packages)) {
    if (name.startsWith('@deepseek-ai/dsh-')) expect(version).toBe(lock.harnessVersion)
  }
  expect(lock.packages['@deepseek-ai/cordis']).toBe('4.0.1')
  expect(Object.keys(runtime.dependencies).some(name => /web|subagent|workflow|mcp|lsp|terminal/.test(name))).toBe(false)
})
