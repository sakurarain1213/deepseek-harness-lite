import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeTool, withPlugin } from '@dsh-lite/plugin-test-support'
import plugin, { readNotes, resolveNotesPath, writeNotes } from '../src/index.js'

describe('workspace notes plugin', () => {
  it('rejects a notes symlink that escapes the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-notes-'))
    const workspace = join(root, 'workspace')
    const outside = join(root, process.platform === 'win32' ? 'outside' : 'outside.md')
    await mkdir(join(workspace, '.dsh-lite'), { recursive: true })
    if (process.platform === 'win32') await mkdir(outside)
    else await writeFile(outside, 'secret')
    const escapedSymlink = join(workspace, '.dsh-lite', 'notes.md')
    await symlink(outside, escapedSymlink, process.platform === 'win32' ? 'junction' : 'file')

    await expect(resolveNotesPath(workspace, escapedSymlink)).rejects.toThrow('outside workspace')
  })

  it('bounds note writes and reads by UTF-8 bytes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-notes-'))
    await expect(writeNotes(workspace, 'four', 3)).rejects.toThrow('notes exceed 3 bytes')
    await mkdir(join(workspace, '.dsh-lite'), { recursive: true })
    await writeFile(join(workspace, '.dsh-lite', 'notes.md'), 'four')
    await expect(readNotes(workspace, 3)).rejects.toThrow('notes exceed 3 bytes')
  })

  it('rejects every candidate other than the fixed notes file', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-notes-'))
    await writeFile(join(workspace, 'README.md'), 'project content')
    await expect(resolveNotesPath(workspace, 'README.md')).rejects.toThrow('must be .dsh-lite/notes.md')
    await expect(resolveNotesPath(workspace, join(workspace, 'README.md'))).rejects.toThrow('must be .dsh-lite/notes.md')
  })

  it('does not follow a target symlink while publishing a write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-notes-'))
    const workspace = join(root, 'workspace')
    const outside = join(root, process.platform === 'win32' ? 'outside' : 'outside.md')
    const sentinel = process.platform === 'win32' ? join(outside, 'sentinel') : outside
    await mkdir(join(workspace, '.dsh-lite'), { recursive: true })
    if (process.platform === 'win32') await mkdir(outside)
    await writeFile(sentinel, 'outside')
    await symlink(outside, join(workspace, '.dsh-lite', 'notes.md'), process.platform === 'win32' ? 'junction' : 'file')
    await expect(writeNotes(workspace, 'replacement', 64)).rejects.toThrow('outside workspace')
    expect(await readFile(sentinel, 'utf8')).toBe('outside')
  })

  it('executes write and read through the official tool registry and unregisters on disposal', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-notes-'))
    await withPlugin(plugin, { workspace, maxBytes: 64 }, async (context, fiber) => {
      expect((await executeTool(context, 'lite_notes', { action: 'write', content: 'remember this' })).isError).toBe(false)
      expect(await readFile(join(workspace, '.dsh-lite', 'notes.md'), 'utf8')).toBe('remember this')
      expect((await executeTool(context, 'lite_notes', { action: 'read' })).content).toEqual([
        { type: 'text', text: 'remember this' },
      ])
      const assembly = await context.systemPrompt.assemble()
      expect(assembly.contexts).toContainEqual({
        name: 'lite:workspace-notes',
        text: '<workspace-notes>\nremember this\n</workspace-notes>',
      })
      await fiber.dispose()
      expect(context.tools.get('lite_notes')).toBeUndefined()
    })
  })
})
