import { describe, expect, it } from 'vitest'
import { executeTool, withPlugin } from '@dsh-lite/plugin-test-support'
import plugin, { DEFAULT_LITE_COMMAND_RULES, decideCommand, type AllowlistRule } from '../src/index.js'

describe('command allowlist plugin', () => {
  it('denies an unmatched command by default', () => {
    expect(decideCommand(['rm', '-rf', 'build'], [{ executable: 'git', args: ['status'] }]))
      .toEqual({ allowed: false, reason: 'no allowlist rule matched' })
  })

  it('requires exact arguments unless a positional rule is explicit', () => {
    const exact: AllowlistRule[] = [{ executable: 'git', args: ['status'] }]
    expect(decideCommand(['git', 'status'], exact)).toEqual({ allowed: true, rule: 0 })
    expect(decideCommand(['git', 'status', '--short'], exact).allowed).toBe(false)
    expect(decideCommand(['git', 'status', '--short'], [{ executable: 'git', argsPrefix: ['status'] }]).allowed).toBe(true)
  })

  it('ships a narrow read-only rule set for the Lite shell pack', () => {
    expect(decideCommand(['pwd'], DEFAULT_LITE_COMMAND_RULES).allowed).toBe(true)
    expect(decideCommand(['git', 'status'], DEFAULT_LITE_COMMAND_RULES).allowed).toBe(true)
    expect(decideCommand(['git', 'diff', '--stat'], DEFAULT_LITE_COMMAND_RULES).allowed).toBe(true)
    expect(decideCommand(['git', 'diff', '--ext-diff'], DEFAULT_LITE_COMMAND_RULES).allowed).toBe(false)
    expect(decideCommand(['git', 'push'], DEFAULT_LITE_COMMAND_RULES).allowed).toBe(false)
    expect(decideCommand(['rm', '-rf', 'build'], DEFAULT_LITE_COMMAND_RULES).allowed).toBe(false)
  })

  it('guards the official shell command field and fails closed on shell syntax', async () => {
    await withPlugin(plugin, { rules: [{ executable: 'git', args: ['status'] }], toolNames: ['bash'] }, async (context) => {
      context.tools.register({
        name: 'bash',
        description: 'fixture',
        parameters: { command: { type: 'string', required: true } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
        async execute() { return 'ran' },
      })
      expect((await executeTool(context, 'bash', { command: 'git status' })).isError).toBe(false)
      expect((await executeTool(context, 'bash', { command: 'git push' })).isError).toBe(true)
      expect((await executeTool(context, 'bash', { command: 'git push', argv: ['git', 'status'] })).isError).toBe(true)
      for (const command of [
        'git "status"',
        "git 'status'",
        'git\\ status',
        'git status | cat',
        'git status > output',
        'git status; echo unsafe',
        'git status && echo unsafe',
        'git status || echo unsafe',
        'git $(status)',
        'git `status`',
        'git $STATUS',
        'git %STATUS%',
        'git status\necho unsafe',
      ]) {
        expect((await executeTool(context, 'bash', { command })).isError, command).toBe(true)
      }
    })
  })

  it('guards configured command tools and records only sanitized denial facts', async () => {
    const audit: import('../src/index.js').DenialFact[] = []
    await withPlugin(plugin, { rules: [], toolNames: ['fixture_command'], argvToolNames: ['fixture_command'], audit }, async (context, fiber) => {
      context.tools.register({
        name: 'fixture_command',
        description: 'fixture',
        parameters: { type: 'object', additionalProperties: true },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
        async execute() { return 'ran' },
      })
      const secret = 'argument-secret'
      const result = await executeTool(context, 'fixture_command', { argv: ['rm', secret] })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result)).not.toContain(secret)
      expect(audit).toEqual([
        expect.objectContaining({ tool: 'fixture_command', executable: 'rm', reason: 'no allowlist rule matched' }),
      ])
      expect(JSON.stringify(audit)).not.toContain(secret)
      await fiber.dispose()
      expect((await executeTool(context, 'fixture_command', { argv: ['rm', secret] })).isError).toBe(false)
    })
  })
})
