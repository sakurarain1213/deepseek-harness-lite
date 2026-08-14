import { z } from 'zod'

export const LiteConfigSchema = z.object({
  schemaVersion: z.literal(1),
  upstream: z.object({
    channel: z.enum(['stable', 'latest']),
    version: z.string().min(1),
  }).strict(),
  profile: z.string().min(1),
  packs: z.array(z.string().min(1)),
  plugins: z.array(z.string().min(1)),
}).strict()

export type LiteConfig = z.infer<typeof LiteConfigSchema>

export const parseLiteConfig = (value: unknown): LiteConfig => LiteConfigSchema.parse(value)
