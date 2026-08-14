import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@dsh-lite/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@dsh-lite/runtime': fileURLToPath(new URL('./packages/runtime/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/tests/**/*.spec.ts', 'apps/*/tests/**/*.spec.ts'],
  },
})
