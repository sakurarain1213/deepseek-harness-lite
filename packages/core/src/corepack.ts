import { access } from 'node:fs/promises'
import { win32 } from 'node:path'

export interface CorepackCommand {
  file: string
  args: string[]
}

export interface CorepackResolutionOptions {
  platform?: NodeJS.Platform
  execPath?: string
  env?: NodeJS.ProcessEnv
  fileExists?: (path: string) => Promise<boolean>
}

const defaultFileExists = async (path: string): Promise<boolean> => access(path).then(() => true, () => false)

export async function resolveCorepackCommand(args: string[], options: CorepackResolutionOptions = {}): Promise<CorepackCommand> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return { file: 'corepack', args: [...args] }

  const execPath = options.execPath ?? process.execPath
  const env = options.env ?? process.env
  const fileExists = options.fileExists ?? defaultFileExists
  const pathValue = env.Path ?? env.PATH ?? env.path ?? ''
  const directories = [win32.dirname(execPath), ...pathValue.split(';')]
    .map((directory) => directory.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
  const uniqueDirectories = [...new Set(directories.map((directory) => win32.normalize(directory)))]

  for (const directory of uniqueDirectories) {
    const candidates = [
      win32.join(directory, 'node_modules', 'corepack', 'dist', 'corepack.js'),
      win32.join(directory, 'lib', 'corepack.cjs'),
      win32.join(directory, '..', 'dist', 'corepack.js'),
      win32.join(directory, '..', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'),
    ]
    for (const entry of candidates) {
      if (await fileExists(entry)) return { file: execPath, args: [entry, ...args] }
    }
  }

  throw new Error('unable to locate the Corepack JavaScript entry point on Windows')
}
