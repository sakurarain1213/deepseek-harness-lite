import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'

const RETRYABLE_CODES = new Set(['EACCES', 'EBUSY', 'EPERM'])
const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface TransactionLease {
  id: string
  pid: number
  hostname: string
  processStartToken: string
  heartbeatToken: string
  heartbeatAt: number
}

interface ReaderLease extends TransactionLease {
  version: string
}

interface TreePointer {
  version: string
  previous?: string
}

export interface TransactionFs {
  mkdir: typeof mkdir
  readFile: typeof readFile
  readdir: typeof readdir
  rename: typeof rename
  rm: typeof rm
  writeFile: typeof writeFile
  stat: typeof stat
  lstat: typeof lstat
  realpath: typeof realpath
  randomId(): string
  hostname: string
  isProcessAlive(pid: number): boolean
  processStartToken(pid: number): string | undefined
  heartbeatIntervalMs: number
  retryLimit: number
  retryDelay(attempt: number): Promise<void>
}

const defaultFs: TransactionFs = {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
  stat,
  lstat,
  realpath,
  randomId: randomUUID,
  hostname: hostname(),
  isProcessAlive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
  processStartToken: (pid) => {
    try {
      if (process.platform === 'linux') {
        const source = readFileSync(`/proc/${pid}/stat`, 'utf8').trim()
        return source.slice(source.lastIndexOf(')') + 2).split(' ')[19]
      }
      if (process.platform === 'darwin') {
        const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim()
        return started || undefined
      }
      if (process.platform === 'win32') {
        const started = execFileSync('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
        ], { encoding: 'utf8', windowsHide: true }).trim()
        return started || undefined
      }
    } catch {
      return undefined
    }
    return undefined
  },
  heartbeatIntervalMs: 1_000,
  retryLimit: 10,
  retryDelay: async (attempt) => setTimeout(attempt * 25),
}

const withFs = (overrides: Partial<TransactionFs>): TransactionFs => ({ ...defaultFs, ...overrides })

function assertTransactionId(id: string): void {
  if (!TRANSACTION_ID.test(id)) throw new Error('invalid transaction id')
}

function parseLease(filename: string, source: string): TransactionLease | undefined {
  const match = /^\.lease-([0-9a-f-]+)\.json$/i.exec(filename)
  if (!match || !TRANSACTION_ID.test(match[1]!)) return undefined
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const lease = value as Record<string, unknown>
  if (Object.keys(lease).sort().join(',') !== 'heartbeatAt,heartbeatToken,hostname,id,pid,processStartToken') return undefined
  if (
    lease.id !== match[1]
    || typeof lease.id !== 'string'
    || !TRANSACTION_ID.test(lease.id)
    || !Number.isSafeInteger(lease.pid)
    || (lease.pid as number) <= 0
    || typeof lease.hostname !== 'string'
    || lease.hostname.length === 0
    || typeof lease.processStartToken !== 'string'
    || lease.processStartToken.length === 0
    || typeof lease.heartbeatToken !== 'string'
    || !TRANSACTION_ID.test(lease.heartbeatToken)
    || typeof lease.heartbeatAt !== 'number'
    || !Number.isSafeInteger(lease.heartbeatAt)
    || lease.heartbeatAt < 0
  ) return undefined
  return lease as unknown as TransactionLease
}

function parseReaderLease(filename: string, source: string): ReaderLease | undefined {
  const match = /^\.reader-([0-9a-f-]+)\.json$/i.exec(filename)
  if (!match || !TRANSACTION_ID.test(match[1]!)) return undefined
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const lease = value as Record<string, unknown>
  if (Object.keys(lease).sort().join(',') !== 'heartbeatAt,heartbeatToken,hostname,id,pid,processStartToken,version') return undefined
  if (
    lease.id !== match[1]
    || typeof lease.id !== 'string'
    || !TRANSACTION_ID.test(lease.id)
    || typeof lease.version !== 'string'
    || !TRANSACTION_ID.test(lease.version)
    || !Number.isSafeInteger(lease.pid)
    || (lease.pid as number) <= 0
    || typeof lease.hostname !== 'string'
    || lease.hostname.length === 0
    || typeof lease.processStartToken !== 'string'
    || lease.processStartToken.length === 0
    || typeof lease.heartbeatToken !== 'string'
    || !TRANSACTION_ID.test(lease.heartbeatToken)
    || typeof lease.heartbeatAt !== 'number'
    || !Number.isSafeInteger(lease.heartbeatAt)
    || lease.heartbeatAt < 0
  ) return undefined
  return lease as unknown as ReaderLease
}

function parseRetirementLease(filename: string, source: string): ReaderLease | undefined {
  const match = /^\.retiring-([0-9a-f-]+)\.json$/i.exec(filename)
  if (!match || !TRANSACTION_ID.test(match[1]!)) return undefined
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const lease = value as Record<string, unknown>
  if (Object.keys(lease).sort().join(',') !== 'heartbeatAt,heartbeatToken,hostname,id,pid,processStartToken,version') return undefined
  if (
    lease.version !== match[1]
    || typeof lease.version !== 'string'
    || !TRANSACTION_ID.test(lease.version)
    || typeof lease.id !== 'string'
    || !TRANSACTION_ID.test(lease.id)
    || !Number.isSafeInteger(lease.pid)
    || (lease.pid as number) <= 0
    || typeof lease.hostname !== 'string'
    || lease.hostname.length === 0
    || typeof lease.processStartToken !== 'string'
    || lease.processStartToken.length === 0
    || typeof lease.heartbeatToken !== 'string'
    || !TRANSACTION_ID.test(lease.heartbeatToken)
    || typeof lease.heartbeatAt !== 'number'
    || !Number.isSafeInteger(lease.heartbeatAt)
    || lease.heartbeatAt < 0
  ) return undefined
  return lease as unknown as ReaderLease
}

function parsePointer(source: string): TreePointer {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error('invalid current tree pointer')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid current tree pointer')
  const pointer = value as Record<string, unknown>
  const keys = Object.keys(pointer).sort().join(',')
  if (
    (keys !== 'version' && keys !== 'previous,version')
    || typeof pointer.version !== 'string'
    || !TRANSACTION_ID.test(pointer.version)
    || (pointer.previous !== undefined && (typeof pointer.previous !== 'string' || !TRANSACTION_ID.test(pointer.previous)))
  ) throw new Error('invalid current tree pointer')
  return pointer as unknown as TreePointer
}

function immediateChild(root: string, name: string): string {
  const target = resolve(root, name)
  if (dirname(target) !== root) throw new Error('transaction artifact is not an immediate child')
  return target
}

async function isSafeAbandonedDirectory(path: string, fs: TransactionFs): Promise<boolean> {
  try {
    const info = await fs.lstat(path)
    return !info.isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

async function retryRename(fs: TransactionFs, source: string, target: string): Promise<void> {
  for (let attempt = 0;; attempt++) {
    try {
      await fs.rename(source, target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!code || !RETRYABLE_CODES.has(code) || attempt >= fs.retryLimit) throw error
      await fs.retryDelay(attempt + 1)
    }
  }
}

function isProvablyDead(lease: TransactionLease, fs: TransactionFs): boolean {
  if (lease.hostname !== fs.hostname) return false
  if (!fs.isProcessAlive(lease.pid)) return true
  const currentStart = fs.processStartToken(lease.pid)
  return currentStart !== undefined && currentStart !== lease.processStartToken
}

async function assertContainedVersions(root: string, fs: TransactionFs): Promise<string> {
  const realRoot = await fs.realpath(root)
  const versionsPath = join(root, 'versions')
  if ((await fs.lstat(versionsPath)).isSymbolicLink()) throw new Error('versions directory is not contained in transaction root')
  const versions = await fs.realpath(versionsPath)
  if (dirname(versions) !== realRoot) throw new Error('versions directory is not contained in transaction root')
  return versions
}

async function cleanupDeadOwners(root: string, fs: TransactionFs): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  await Promise.all(names.filter((name) => name.startsWith('.lease-') && name.endsWith('.json')).map(async (name) => {
    const leasePath = immediateChild(root, name)
    let lease: TransactionLease | undefined
    try {
      if ((await fs.lstat(leasePath)).isSymbolicLink()) return
      lease = parseLease(name, await fs.readFile(leasePath, 'utf8'))
    } catch {
      return
    }
    if (!lease || !isProvablyDead(lease, fs)) return
    const stage = immediateChild(root, `.stage-${lease.id}`)
    const pointer = immediateChild(root, `.pointer-${lease.id}`)
    if (!await isSafeAbandonedDirectory(stage, fs) || !await isSafeAbandonedDirectory(pointer, fs)) return
    await fs.rm(stage, { recursive: true, force: true })
    await fs.rm(pointer, { recursive: true, force: true })
    await fs.rm(leasePath, { force: true })
  }))
}

async function cleanupDeadReaders(root: string, fs: TransactionFs): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  await Promise.all(names.filter((name) => name.startsWith('.reader-') && name.endsWith('.json')).map(async (name) => {
    const leasePath = immediateChild(root, name)
    try {
      if ((await fs.lstat(leasePath)).isSymbolicLink()) return
      const lease = parseReaderLease(name, await fs.readFile(leasePath, 'utf8'))
      if (lease && isProvablyDead(lease, fs)) await fs.rm(leasePath, { force: true })
    } catch {
      // Ambiguous reader ownership is retained so version reclamation fails closed.
    }
  }))
}

async function protectedVersions(root: string, fs: TransactionFs): Promise<{ blocked: boolean, versions: Set<string> }> {
  const protectedIds = new Set<string>()
  let names: string[]
  try {
    names = await fs.readdir(root)
  } catch {
    return { blocked: true, versions: protectedIds }
  }
  for (const name of names) {
    if (name.startsWith('.lease-') && name.endsWith('.json')) {
      const match = /^\.lease-([0-9a-f-]+)\.json$/i.exec(name)
      if (!match || !TRANSACTION_ID.test(match[1]!)) return { blocked: true, versions: protectedIds }
      protectedIds.add(match[1]!)
      continue
    }
    if (!name.startsWith('.reader-') || !name.endsWith('.json')) continue
    const leasePath = immediateChild(root, name)
    try {
      if ((await fs.lstat(leasePath)).isSymbolicLink()) return { blocked: true, versions: protectedIds }
      const lease = parseReaderLease(name, await fs.readFile(leasePath, 'utf8'))
      if (!lease) return { blocked: true, versions: protectedIds }
      protectedIds.add(lease.version)
    } catch {
      return { blocked: true, versions: protectedIds }
    }
  }
  return { blocked: false, versions: protectedIds }
}

async function exists(path: string, fs: TransactionFs): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function pruneVersions(
  root: string,
  versions: string,
  pointer: TreePointer,
  owner: TransactionLease,
  eligibleVersions: ReadonlySet<string>,
  fs: TransactionFs,
): Promise<void> {
  await cleanupDeadReaders(root, fs)
  const initial = await protectedVersions(root, fs)
  if (initial.blocked) return
  const keep = new Set([pointer.version, pointer.previous, ...initial.versions].filter((id): id is string => id !== undefined))
  let names: string[]
  try {
    names = await fs.readdir(versions)
  } catch {
    return
  }
  for (const name of names) {
    if (!TRANSACTION_ID.test(name) || keep.has(name) || !eligibleVersions.has(name)) continue
    const candidate = immediateChild(versions, name)
    const markerName = `.retiring-${name}.json`
    const marker = immediateChild(root, markerName)
    try {
      if (await exists(marker, fs)) {
        if ((await fs.lstat(marker)).isSymbolicLink()) continue
        const stale = parseRetirementLease(markerName, await fs.readFile(marker, 'utf8'))
        if (!stale || !isProvablyDead(stale, fs)) continue
        await fs.rm(marker, { force: true })
      }
    } catch {
      continue
    }
    try {
      await fs.writeFile(marker, `${JSON.stringify({ ...owner, version: name })}\n`, { flag: 'wx' })
    } catch {
      continue
    }
    try {
      const current = parsePointer(await fs.readFile(join(root, 'current.json'), 'utf8'))
      if (current.version === name || current.previous === name) continue
      const protectedAfterMarker = await protectedVersions(root, fs)
      if (protectedAfterMarker.blocked || protectedAfterMarker.versions.has(name)) continue
      const info = await fs.lstat(candidate)
      if (info.isSymbolicLink() || !info.isDirectory()) continue
      const realCandidate = await fs.realpath(candidate)
      if (dirname(realCandidate) !== versions) continue
      await fs.rm(candidate, { recursive: true, force: true })
    } catch {
      // Reclamation is best-effort; uncertain state is preserved.
    } finally {
      await fs.rm(marker, { force: true }).catch(() => undefined)
    }
  }
}

export async function publishTree(
  rootDir: string,
  build: (stageDir: string) => Promise<void>,
  overrides: Partial<TransactionFs> = {},
): Promise<string> {
  const fs = withFs(overrides)
  const root = resolve(rootDir)
  const id = fs.randomId()
  assertTransactionId(id)
  const heartbeatToken = fs.randomId()
  assertTransactionId(heartbeatToken)
  const stageName = `.stage-${id}`
  const pointerName = `.pointer-${id}`
  const leaseName = `.lease-${id}.json`
  const stage = immediateChild(root, stageName)
  const versions = join(root, 'versions')
  const version = immediateChild(versions, id)
  const candidate = process.platform === 'win32' ? version : stage
  const pointer = immediateChild(root, pointerName)
  const lease = immediateChild(root, leaseName)
  await fs.mkdir(versions, { recursive: true })
  const realVersions = await assertContainedVersions(root, fs)
  await cleanupDeadOwners(root, fs)
  const eligibleVersions = new Set(await fs.readdir(versions))
  const processStartToken = fs.processStartToken(process.pid)
  if (!processStartToken) throw new Error('unable to establish transaction process identity')
  const leaseRecord: TransactionLease = {
    id,
    pid: process.pid,
    hostname: fs.hostname,
    processStartToken,
    heartbeatToken,
    heartbeatAt: Date.now(),
  }
  const serializeLease = () => `${JSON.stringify(leaseRecord)}\n`
  await fs.writeFile(lease, serializeLease(), { flag: 'wx' })
  let heartbeatWrite = Promise.resolve()
  const heartbeat = setInterval(() => {
    leaseRecord.heartbeatAt = Date.now()
    heartbeatWrite = heartbeatWrite.then(() => fs.writeFile(lease, serializeLease())).catch(() => undefined)
  }, fs.heartbeatIntervalMs)
  heartbeat.unref()
  let versionPublished = false
  let pointerPublished = false
  try {
    await fs.mkdir(candidate, { recursive: false })
    if (candidate === version) versionPublished = true
    await build(candidate)
    if (candidate === stage) {
      await retryRename(fs, stage, version)
      versionPublished = true
    }
    let previous: string | undefined
    try {
      previous = parsePointer(await fs.readFile(join(root, 'current.json'), 'utf8')).version
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const nextPointer: TreePointer = { version: id, ...(previous ? { previous } : {}) }
    await fs.writeFile(pointer, `${JSON.stringify(nextPointer)}\n`, { flag: 'wx' })
    await retryRename(fs, pointer, join(root, 'current.json'))
    pointerPublished = true
    await pruneVersions(root, realVersions, nextPointer, leaseRecord, eligibleVersions, fs)
    return version
  } finally {
    clearInterval(heartbeat)
    await heartbeatWrite
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(pointer, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(lease, { force: true }).catch(() => undefined)
    if (versionPublished && !pointerPublished) await fs.rm(version, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function resolveCurrentTree(
  rootDir: string,
  overrides: Partial<TransactionFs> = {},
): Promise<string> {
  const fs = withFs(overrides)
  const root = resolve(rootDir)
  const versions = await assertContainedVersions(root, fs)
  for (let attempt = 0; attempt <= fs.retryLimit; attempt++) {
    const pointer = parsePointer(await fs.readFile(join(root, 'current.json'), 'utf8'))
    const marker = immediateChild(root, `.retiring-${pointer.version}.json`)
    if (await exists(marker, fs)) {
      if (attempt === fs.retryLimit) throw new Error('current tree is being retired')
      await fs.retryDelay(attempt + 1)
      continue
    }
    const id = fs.randomId()
    assertTransactionId(id)
    const heartbeatToken = fs.randomId()
    assertTransactionId(heartbeatToken)
    const processStartToken = fs.processStartToken(process.pid)
    if (!processStartToken) throw new Error('unable to establish reader process identity')
    const leasePath = immediateChild(root, `.reader-${id}.json`)
    const lease: ReaderLease = {
      id,
      version: pointer.version,
      pid: process.pid,
      hostname: fs.hostname,
      processStartToken,
      heartbeatToken,
      heartbeatAt: Date.now(),
    }
    await fs.writeFile(leasePath, `${JSON.stringify(lease)}\n`, { flag: 'wx' })
    let retained = false
    try {
      if (await exists(marker, fs)) continue
      const target = await fs.realpath(join(versions, pointer.version))
      if (dirname(target) !== versions) throw new Error('current tree is not contained in versions')
      retained = true
      return target
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt === fs.retryLimit) throw error
    } finally {
      if (!retained) await fs.rm(leasePath, { force: true }).catch(() => undefined)
    }
    await fs.retryDelay(attempt + 1)
  }
  throw new Error('unable to lease current tree')
}

export async function publishDirectory(
  targetDir: string,
  sourceDir: string,
  overrides: Partial<TransactionFs> = {},
): Promise<string> {
  const fs = withFs(overrides)
  return publishTree(targetDir, async (stage) => {
    const copy = await import('node:fs/promises')
    await copy.cp(sourceDir, stage, { recursive: true, force: true })
  }, fs)
}
