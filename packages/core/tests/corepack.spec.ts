import { describe, expect, it } from 'vitest'
import { resolveCorepackCommand } from '../src/corepack.js'

describe('Corepack command resolution', () => {
  it('runs the JavaScript entry with Node when Windows exposes only a cmd shim', async () => {
    const execPath = 'C:\\hosted toolcache\\windows\\node\\22.22.0\\x64\\node.exe'
    const entry = 'C:\\hosted toolcache\\windows\\node\\22.22.0\\x64\\node_modules\\corepack\\dist\\corepack.js'
    const args = ['pnpm@10.15.0', 'install', '--dir', 'C:\\work tree\\profile & audit ^ marker']

    await expect(resolveCorepackCommand(args, {
      platform: 'win32',
      execPath,
      env: { Path: 'C:\\hosted toolcache\\windows\\node\\22.22.0\\x64' },
      fileExists: async (path) => path === entry,
    })).resolves.toEqual({ file: execPath, args: [entry, ...args] })
  })

  it('keeps the native Corepack executable on POSIX', async () => {
    await expect(resolveCorepackCommand(['pnpm@10.15.0', '--version'], {
      platform: 'linux',
      execPath: '/usr/bin/node',
      env: { PATH: '/usr/bin' },
      fileExists: async () => false,
    })).resolves.toEqual({ file: 'corepack', args: ['pnpm@10.15.0', '--version'] })
  })
})
