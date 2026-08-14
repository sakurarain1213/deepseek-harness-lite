import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export interface AllowlistRule {
  executable: string
  args?: string[]
  argsPrefix?: string[]
}

export type AllowlistDecision = { allowed: true; rule: number } | { allowed: false; reason: string }

export interface DenialFact {
  tool: string
  executable: string
  reason: string
  time: string
}

export interface Config {
  rules: AllowlistRule[]
  toolNames?: string[]
  argvToolNames?: string[]
  audit?: DenialFact[]
  maxAuditEntries?: number
}

export const DEFAULT_LITE_COMMAND_RULES: readonly AllowlistRule[] = Object.freeze([
  Object.freeze({ executable: 'pwd' }),
  Object.freeze({ executable: 'git', args: ['status'] }),
  Object.freeze({ executable: 'git', args: ['diff'] }),
  Object.freeze({ executable: 'git', args: ['diff', '--stat'] }),
  Object.freeze({ executable: 'git', args: ['log'] }),
  Object.freeze({ executable: 'git', args: ['log', '--oneline'] }),
])

export const name = 'lite-command-allowlist'
export const inject = ['tools']
export const Config: z<Config> = z.object({
  rules: z.array(z.object({
    executable: z.string(),
    args: z.array(z.string()),
    argsPrefix: z.array(z.string()),
  })).default([]),
  toolNames: z.array(z.string()).default(['bash', 'pwsh']),
  argvToolNames: z.array(z.string()).default([]),
  maxAuditEntries: z.number().default(100),
})

function equal(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

export function decideCommand(argv: readonly string[], rules: readonly AllowlistRule[]): AllowlistDecision {
  if (argv.length === 0) return { allowed: false, reason: 'empty command' }
  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index]
    if (rule === undefined || argv[0] !== rule.executable) continue
    const args = argv.slice(1)
    if (rule.args !== undefined && equal(args, rule.args)) return { allowed: true, rule: index }
    if (rule.argsPrefix !== undefined && rule.argsPrefix.length > 0 && rule.argsPrefix.every((value, position) => args[position] === value)) {
      return { allowed: true, rule: index }
    }
    if (rule.args === undefined && rule.argsPrefix === undefined && args.length === 0) return { allowed: true, rule: index }
  }
  return { allowed: false, reason: 'no allowlist rule matched' }
}

function commandFromArguments(input: unknown): string[] | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  const argv = Reflect.get(input, 'argv')
  if (argv !== undefined) return undefined
  const command = Reflect.get(input, 'command')
  if (typeof command !== 'string' || command.length === 0 || command.trim() !== command) return undefined
  const tokens = command.split(/[ \t]+/)
  return tokens.every((token) => /^[A-Za-z0-9_./:@+=,-]+$/.test(token)) ? tokens : undefined
}

function argvFromArguments(input: unknown): string[] | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  const command = Reflect.get(input, 'command')
  if (command !== undefined) return undefined
  const argv = Reflect.get(input, 'argv')
  return Array.isArray(argv) && argv.every((value) => typeof value === 'string') ? argv : undefined
}

export function apply(ctx: Context, config: Config): void {
  const toolNames = new Set(config.toolNames ?? ['bash', 'pwsh'])
  const argvToolNames = new Set(config.argvToolNames ?? [])
  const audit = config.audit ?? []
  const maxAuditEntries = config.maxAuditEntries ?? 100
  if (!Number.isInteger(maxAuditEntries) || maxAuditEntries < 1) throw new Error('maxAuditEntries must be a positive integer')
  ctx.tools.guard((execution) => {
    if (!toolNames.has(execution.name) && !argvToolNames.has(execution.name)) return undefined
    const argv = argvToolNames.has(execution.name)
      ? argvFromArguments(execution.arguments)
      : commandFromArguments(execution.arguments)
    const decision = argv === undefined
      ? { allowed: false as const, reason: 'a simple command or argv is required' }
      : decideCommand(argv, config.rules)
    if (decision.allowed) return undefined
    audit.push({
      tool: execution.name,
      executable: argv?.[0] ?? '',
      reason: decision.reason,
      time: new Date().toISOString(),
    })
    if (audit.length > maxAuditEntries) audit.splice(0, audit.length - maxAuditEntries)
    return `command denied: ${decision.reason}`
  })
}

const plugin: { name: string; inject: string[]; Config: z<Config>; apply: typeof apply } = {
  name, inject, Config, apply,
}
export default plugin
