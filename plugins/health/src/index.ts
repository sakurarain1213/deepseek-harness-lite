import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export interface Config {
  runtime: string
  upstreamVersion: string
  profile: string
  packs: string[]
  plugins: string[]
}

export const name = 'lite-health'
export const inject = ['tools']
export const Config = z.object({
  runtime: z.string().default('node'),
  upstreamVersion: z.string().default('unknown'),
  profile: z.string().default('unknown'),
  packs: z.array(z.string()).default([]),
  plugins: z.array(z.string()).default([]),
})

export function createHealthTool(config: Config) {
  const status = Object.freeze({
    runtime: config.runtime,
    upstreamVersion: config.upstreamVersion,
    profile: config.profile,
    packs: [...config.packs],
    plugins: [...config.plugins],
    ok: true,
  })
  return defineTool({
    name: 'lite_health',
    description: 'Return sanitized DeepSeek Harness Lite runtime status.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runtime: { type: 'string', required: true },
          upstreamVersion: { type: 'string', required: true },
          profile: { type: 'string', required: true },
          packs: { type: 'array', required: true, items: { type: 'string' } },
          plugins: { type: 'array', required: true, items: { type: 'string' } },
          ok: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() { return status },
    isConcurrencySafe: () => true,
  })
}

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(createHealthTool(config))
}

const plugin = { name, inject, Config, apply }
export default plugin
