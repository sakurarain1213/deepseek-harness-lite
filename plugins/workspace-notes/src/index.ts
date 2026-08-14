import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export interface Config {
  workspace: string
  candidate?: string
  maxBytes?: number
}

export const name = 'lite-workspace-notes'
export const inject = ['tools', 'systemPrompt']
export const Config = z.object({
  workspace: z.string(),
  candidate: z.string().default('.dsh-lite/notes.md'),
  maxBytes: z.number().default(16_384),
})

function assertInside(root: string, candidate: string): void {
  const delta = relative(root, candidate)
  if (delta === '..' || delta.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(delta)) {
    throw new Error('notes path is outside workspace')
  }
}

async function existingAncestor(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return existingAncestor(parent)
  }
}

export async function resolveNotesPath(workspace: string, candidate = '.dsh-lite/notes.md'): Promise<string> {
  const requestedTarget = resolve(workspace, candidate)
  if (requestedTarget !== resolve(workspace, '.dsh-lite/notes.md')) throw new Error('notes path must be .dsh-lite/notes.md')
  const workspaceRoot = await realpath(workspace)
  const target = resolve(workspaceRoot, '.dsh-lite/notes.md')
  assertInside(workspaceRoot, target)
  try {
    const stat = await lstat(target)
    const resolvedTarget = await realpath(target)
    assertInside(workspaceRoot, resolvedTarget)
    if (stat.isSymbolicLink()) throw new Error('notes path is outside workspace')
    if (!stat.isFile()) throw new Error('notes path is not a regular file')
    return resolvedTarget
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const ancestor = await existingAncestor(dirname(target))
  assertInside(workspaceRoot, ancestor)
  return target
}

function assertLimit(content: string, maxBytes: number): void {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('maxBytes must be a positive integer')
  const size = Buffer.byteLength(content, 'utf8')
  if (size > maxBytes) throw new Error(`notes exceed ${maxBytes} bytes`)
}

export async function readNotes(workspace: string, maxBytes = 16_384, candidate?: string): Promise<string> {
  const path = await resolveNotesPath(workspace, candidate)
  try {
    const content = await readFile(path, 'utf8')
    assertLimit(content, maxBytes)
    return content
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

export async function writeNotes(workspace: string, content: string, maxBytes = 16_384, candidate?: string): Promise<void> {
  assertLimit(content, maxBytes)
  const path = await resolveNotesPath(workspace, candidate)
  await mkdir(dirname(path), { recursive: true })
  const verified = await resolveNotesPath(workspace, candidate)
  const workspaceRoot = await realpath(workspace)
  const parent = await realpath(dirname(verified))
  assertInside(workspaceRoot, parent)
  const temporary = join(parent, `.notes-${process.pid}-${crypto.randomUUID()}.tmp`)
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    const currentParent = await realpath(dirname(verified))
    if (currentParent !== parent) throw new Error('notes path is outside workspace')
    try {
      const target = await lstat(verified)
      if (target.isSymbolicLink() || !target.isFile()) throw new Error('notes path is outside workspace')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await rename(temporary, verified)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export function noteSection(content: string, maxBytes = 16_384): string {
  assertLimit(content, maxBytes)
  return content.length === 0 ? '' : `<workspace-notes>\n${content}\n</workspace-notes>`
}

export function createWorkspaceNotesTool(config: Config, onWrite?: (content: string) => void) {
  const maxBytes = config.maxBytes ?? 16_384
  return defineTool({
    name: 'lite_notes',
    description: 'Read or replace the bounded workspace notes file.',
    parameters: {
      action: { type: 'string', required: true, enum: ['read', 'write'] },
      content: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      if (args.action === 'read') return readNotes(config.workspace, maxBytes, config.candidate)
      if (args.content === undefined) throw new Error('content is required for write')
      await writeNotes(config.workspace, args.content, maxBytes, config.candidate)
      onWrite?.(args.content)
      return 'notes updated'
    },
  })
}

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  let content = await readNotes(config.workspace, config.maxBytes, config.candidate)
  const disposeContext = ctx.systemPrompt.context({
    name: 'lite:workspace-notes', order: 50, text: () => noteSection(content, config.maxBytes),
  })
  const disposeTool = ctx.tools.register(createWorkspaceNotesTool(config, (next) => { content = next }))
  return async () => { await disposeTool(); await disposeContext() }
}

const plugin = { name, inject, Config, apply }
export default plugin
