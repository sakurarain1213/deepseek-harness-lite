import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const fromRoot = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/cordis': fromRoot('packages/runtime/node_modules/@deepseek-ai/cordis/lib/index.js'),
      '@deepseek-ai/dsh-tools': fromRoot('packages/runtime/node_modules/@deepseek-ai/dsh-tools/lib/index.js'),
      '@deepseek-ai/dsh-system-prompt': fromRoot('packages/runtime/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js'),
      '@deepseek-ai/schemastery': fromRoot('node_modules/.pnpm/node_modules/@deepseek-ai/schemastery/lib/index.mjs'),
      '@dsh-lite/plugin-test-support': fileURLToPath(new URL('./test-support/src/harness.ts', import.meta.url)),
    },
  },
  test: {
    include: ['plugins/*/tests/**/*.spec.ts'],
  },
})
