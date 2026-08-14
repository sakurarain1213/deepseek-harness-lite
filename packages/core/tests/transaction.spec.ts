import { access, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { publishTree, resolveCurrentTree, type TransactionFs } from '../src/transaction.js'

describe('publishTree', () => {
  const deadId = '00000000-0000-4000-8000-000000000001'
  const liveId = '00000000-0000-4000-8000-000000000002'
  const heartbeatId = '00000000-0000-4000-8000-000000000003'

  const lease = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    pid: 42,
    hostname: 'local',
    processStartToken: 'old-process',
    heartbeatToken: '00000000-0000-4000-8000-000000000099',
    heartbeatAt: 1,
    ...overrides,
  })

  it('keeps the previous version visible when pointer publication fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-transaction-'))
    await publishTree(root, async (stage) => writeFile(join(stage, 'value'), 'old'))
    const before = await resolveCurrentTree(root)
    const fs: Partial<TransactionFs> = {
      rename: async (source, target) => {
        if (String(target).endsWith('current.json')) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        const { rename } = await import('node:fs/promises')
        await rename(source, target)
      },
      retryLimit: 1,
      retryDelay: async () => undefined,
    }

    await expect(publishTree(root, async (stage) => writeFile(join(stage, 'value'), 'new'), fs)).rejects.toThrow('busy')
    expect(await readFile(join(await resolveCurrentTree(root), 'value'), 'utf8')).toBe('old')
    expect(await resolveCurrentTree(root)).toBe(before)
    expect((await readdir(root)).some((name) => name.startsWith('.stage-'))).toBe(false)
    expect((await readdir(root)).some((name) => name.startsWith('.pointer-'))).toBe(false)
    expect(await readdir(join(root, 'versions'))).toHaveLength(1)
  })

  it.each(['EACCES', 'EPERM', 'EBUSY'])('retries Windows %s sharing violations and publishes a complete tree', async (code) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-transaction-'))
    let failures = 0
    const fs: Partial<TransactionFs> = {
      rename: async (source, target) => {
        if (String(target).endsWith('current.json') && failures++ < 2) throw Object.assign(new Error('locked'), { code })
        const { rename } = await import('node:fs/promises')
        await rename(source, target)
      },
      retryDelay: async () => undefined,
    }

    await publishTree(root, async (stage) => writeFile(join(stage, 'value'), 'complete'), fs)
    expect(await readFile(join(await resolveCurrentTree(root), 'value'), 'utf8')).toBe('complete')
    expect(failures).toBe(3)
  })

  it('cleans a unique stage when candidate construction fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-transaction-'))
    await expect(publishTree(root, async () => { throw new Error('invalid candidate') })).rejects.toThrow('invalid candidate')
    expect((await readdir(root)).filter((name) => name.startsWith('.stage-') || name.startsWith('.pointer-'))).toEqual([])
    expect(await readdir(join(root, 'versions'))).toEqual([])
  })

  it('uses unique versions for concurrent publications without deleting a live foreign stage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-transaction-'))
    await writeFile(join(root, '.stage-foreign'), 'live')
    await Promise.all([
      publishTree(root, async (stage) => writeFile(join(stage, 'value'), 'a')),
      publishTree(root, async (stage) => writeFile(join(stage, 'value'), 'b')),
    ])
    const current = await resolveCurrentTree(root)
    expect(['a', 'b']).toContain(await readFile(join(current, 'value'), 'utf8'))
    expect((await readdir(join(root, 'versions'))).length).toBe(2)
    await expect(access(join(root, '.stage-foreign'))).resolves.toBeUndefined()
  })

  it('retains only the current tree and one previous tree after successful publications', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-transaction-'))
    for (const value of ['one', 'two', 'three', 'four']) {
      await publishTree(root, async (stage) => writeFile(join(stage, 'value'), value))
    }

    const versions = await readdir(join(root, 'versions'))
    expect(versions).toHaveLength(2)
    expect(await readFile(join(await resolveCurrentTree(root), 'value'), 'utf8')).toBe('four')
    const retained = await Promise.all(versions.map((version) => readFile(join(root, 'versions', version, 'value'), 'utf8')))
    expect(retained.sort()).toEqual(['four', 'three'])
  })

  it('preserves an actively leased reader version beyond the previous tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-transaction-'))
    await publishTree(root, async (stage) => writeFile(join(stage, 'value'), 'leased'))
    await resolveCurrentTree(root, {
      hostname: 'local',
      processStartToken: () => 'reader-process',
    })
    for (const value of ['two', 'three', 'four']) {
      await publishTree(root, async (stage) => writeFile(join(stage, 'value'), value), {
        hostname: 'local',
        isProcessAlive: () => true,
        processStartToken: () => 'reader-process',
      })
    }

    const retained = await Promise.all((await readdir(join(root, 'versions')))
      .map((version) => readFile(join(root, 'versions', version, 'value'), 'utf8')))
    expect(retained.sort()).toEqual(['four', 'leased', 'three'])
  })

  it('reclaims a reader version after its local process identity is provably dead', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-transaction-'))
    await publishTree(root, async (stage) => writeFile(join(stage, 'value'), 'dead-reader'))
    await resolveCurrentTree(root, {
      hostname: 'local',
      processStartToken: () => 'reader-process',
    })
    for (const value of ['two', 'three', 'four']) {
      await publishTree(root, async (stage) => writeFile(join(stage, 'value'), value), {
        hostname: 'local',
        isProcessAlive: () => false,
        processStartToken: () => 'publisher-process',
      })
    }

    const retained = await Promise.all((await readdir(join(root, 'versions')))
      .map((version) => readFile(join(root, 'versions', version, 'value'), 'utf8')))
    expect(retained.sort()).toEqual(['four', 'three'])
    expect((await readdir(root)).filter((name) => name.startsWith('.reader-'))).toEqual([])
  })

  it('recovers a retirement marker owned by a provably dead local process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-transaction-'))
    await publishTree(root, async (stage) => writeFile(join(stage, 'value'), 'stale'))
    const staleVersion = (JSON.parse(await readFile(join(root, 'current.json'), 'utf8')) as { version: string }).version
    await publishTree(root, async (stage) => writeFile(join(stage, 'value'), 'previous'))
    await writeFile(join(root, `.retiring-${staleVersion}.json`), JSON.stringify({
      ...lease(liveId),
      version: staleVersion,
    }))

    await publishTree(root, async (stage) => writeFile(join(stage, 'value'), 'current'), {
      hostname: 'local',
      isProcessAlive: () => false,
      processStartToken: () => 'publisher-process',
    })

    const retained = await Promise.all((await readdir(join(root, 'versions')))
      .map((version) => readFile(join(root, 'versions', version, 'value'), 'utf8')))
    expect(retained.sort()).toEqual(['current', 'previous'])
    await expect(access(join(root, `.retiring-${staleVersion}.json`))).rejects.toThrow()
  })

  it('fails before construction when versions is redirected through a symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-transaction-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-lite-outside-'))
    await symlink(outside, join(root, 'versions'))

    let built = false
    await expect(publishTree(root, async () => { built = true })).rejects.toThrow('contained')
    expect(built).toBe(false)
    expect(await readdir(outside)).toEqual([])
  })

  it('recovers stages owned by a provably dead local process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-transaction-'))
    await writeFile(join(root, `.stage-${deadId}`), 'stale')
    await writeFile(join(root, `.lease-${deadId}.json`), JSON.stringify(lease(deadId)))
    await publishTree(root, async (stage) => writeFile(join(stage, 'value'), 'fresh'), {
      hostname: 'local',
      isProcessAlive: () => false,
    })
    await expect(access(join(root, `.stage-${deadId}`))).rejects.toThrow()
    await expect(access(join(root, `.lease-${deadId}.json`))).rejects.toThrow()
  })

  it('rejects a generated transaction id outside the strict UUID grammar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-transaction-'))
    await expect(publishTree(root, async () => undefined, { randomId: () => '../../escape' }))
      .rejects.toThrow('invalid transaction id')
    expect(await readdir(root)).toEqual([])
  })

  it('ignores a lease whose filename id differs from its payload id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-transaction-'))
    await writeFile(join(root, `.stage-${liveId}`), 'keep')
    await writeFile(join(root, `.lease-${deadId}.json`), JSON.stringify(lease(liveId)))
    await publishTree(root, async (stage) => writeFile(join(stage, 'value'), 'fresh'), {
      hostname: 'local',
      isProcessAlive: () => false,
    })
    await expect(access(join(root, `.stage-${liveId}`))).resolves.toBeUndefined()
    await expect(access(join(root, `.lease-${deadId}.json`))).resolves.toBeUndefined()
  })

  it('ignores crafted and non-strict lease metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-transaction-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-lite-outside-'))
    await writeFile(join(outside, 'sentinel'), 'keep')
    await writeFile(join(root, `.lease-${deadId}.json`), JSON.stringify({
      ...lease(deadId),
      id: '../../outside',
      unexpected: true,
    }))
    await publishTree(root, async (stage) => writeFile(join(stage, 'value'), 'fresh'), {
      hostname: 'local',
      isProcessAlive: () => false,
    })
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('keep')
    await expect(access(join(root, `.lease-${deadId}.json`))).resolves.toBeUndefined()
  })

  it('refuses to recursively delete a symlinked abandoned stage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-transaction-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-lite-outside-'))
    await writeFile(join(outside, 'sentinel'), 'keep')
    await symlink(outside, join(root, `.stage-${deadId}`))
    await writeFile(join(root, `.lease-${deadId}.json`), JSON.stringify(lease(deadId)))
    await publishTree(root, async (stage) => writeFile(join(stage, 'value'), 'fresh'), {
      hostname: 'local',
      isProcessAlive: () => false,
    })
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('keep')
    await expect(access(join(root, `.stage-${deadId}`))).resolves.toBeUndefined()
    await expect(access(join(root, `.lease-${deadId}.json`))).resolves.toBeUndefined()
  })

  it('refuses ownership metadata supplied through a symlinked lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-transaction-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-lite-outside-'))
    const outsideLease = join(outside, 'lease.json')
    await writeFile(join(root, `.stage-${deadId}`), 'keep')
    await writeFile(outsideLease, JSON.stringify(lease(deadId)))
    await symlink(outsideLease, join(root, `.lease-${deadId}.json`))
    await publishTree(root, async (stage) => writeFile(join(stage, 'value'), 'fresh'), {
      hostname: 'local',
      isProcessAlive: () => false,
    })
    await expect(access(join(root, `.stage-${deadId}`))).resolves.toBeUndefined()
    await expect(access(join(root, `.lease-${deadId}.json`))).resolves.toBeUndefined()
  })

  it('preserves leases owned by another host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-transaction-'))
    await writeFile(join(root, `.stage-${liveId}`), 'keep')
    await writeFile(join(root, `.lease-${liveId}.json`), JSON.stringify(lease(liveId, { hostname: 'remote' })))
    await publishTree(root, async (stage) => writeFile(join(stage, 'value'), 'fresh'), {
      hostname: 'local',
      isProcessAlive: () => false,
    })
    await expect(access(join(root, `.stage-${liveId}`))).resolves.toBeUndefined()
    await expect(access(join(root, `.lease-${liveId}.json`))).resolves.toBeUndefined()
  })

  it('recovers a same-host lease when a live pid has been reused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-transaction-'))
    await writeFile(join(root, `.stage-${deadId}`), 'stale')
    await writeFile(join(root, `.lease-${deadId}.json`), JSON.stringify(lease(deadId)))
    await publishTree(root, async (stage) => writeFile(join(stage, 'value'), 'fresh'), {
      hostname: 'local',
      isProcessAlive: () => true,
      processStartToken: () => 'new-process',
    })
    await expect(access(join(root, `.stage-${deadId}`))).rejects.toThrow()
    await expect(access(join(root, `.lease-${deadId}.json`))).rejects.toThrow()
  })

  it('preserves an old heartbeat when the live process identity still matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-transaction-'))
    await writeFile(join(root, `.stage-${liveId}`), 'keep')
    await writeFile(join(root, `.lease-${liveId}.json`), JSON.stringify(lease(liveId)))
    await publishTree(root, async (stage) => writeFile(join(stage, 'value'), 'fresh'), {
      hostname: 'local',
      isProcessAlive: () => true,
      processStartToken: () => 'old-process',
    })
    await expect(access(join(root, `.stage-${liveId}`))).resolves.toBeUndefined()
    await expect(access(join(root, `.lease-${liveId}.json`))).resolves.toBeUndefined()
  })

  it('updates its strict lease heartbeat while a long build is running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-transaction-'))
    let releaseBuild!: () => void
    const buildBlocked = new Promise<void>((resolve) => { releaseBuild = resolve })
    const publication = publishTree(root, async (stage) => {
      await buildBlocked
      await writeFile(join(stage, 'value'), 'fresh')
    }, {
      randomId: (() => {
        const ids = [heartbeatId, '00000000-0000-4000-8000-000000000004']
        return () => ids.shift()!
      })(),
      hostname: 'local',
      processStartToken: () => 'current-process',
      heartbeatIntervalMs: 5,
    })

    const leasePath = join(root, `.lease-${heartbeatId}.json`)
    let firstHeartbeat = 0
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        firstHeartbeat = JSON.parse(await readFile(leasePath, 'utf8')).heartbeatAt as number
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
    }
    let updated: Record<string, unknown> | undefined
    try {
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          const candidate = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>
          if ((candidate.heartbeatAt as number) > firstHeartbeat) {
            updated = candidate
            break
          }
        } catch {
          // A reader may race the in-place heartbeat write; invalid leases are preserved conservatively.
        }
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
      expect(Object.keys(updated ?? {}).sort()).toEqual([
        'heartbeatAt', 'heartbeatToken', 'hostname', 'id', 'pid', 'processStartToken',
      ])
      expect(updated?.heartbeatAt).toEqual(expect.any(Number))
      expect(updated!.heartbeatAt as number).toBeGreaterThan(firstHeartbeat)
    } finally {
      releaseBuild()
      await publication
    }
  })

  it('rejects a symlinked published version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-transaction-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-lite-outside-'))
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(root, 'versions'), { recursive: true }))
    await symlink(outside, join(root, 'versions', deadId))
    await writeFile(join(root, 'current.json'), JSON.stringify({ version: deadId }))
    await expect(resolveCurrentTree(root)).rejects.toThrow('contained')
    expect((await readdir(root)).filter((name) => name.startsWith('.reader-'))).toEqual([])
  })

  it('rejects a current pointer outside the strict UUID grammar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lite-transaction-'))
    await mkdir(join(root, 'versions'), { recursive: true })
    await writeFile(join(root, 'current.json'), JSON.stringify({ version: 'escape' }))
    await expect(resolveCurrentTree(root)).rejects.toThrow('invalid current tree pointer')
  })
})
