import { chmod, cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const result = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value) throw new Error('usage: prepare-release --stage <path> --version <semver>')
    result.set(name, value)
  }
  const stage = result.get('--stage')
  const version = result.get('--version')
  if (!stage || !version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('usage: prepare-release --stage <path> --version <semver>')
  }
  return { stage: resolve(stage), version }
}

async function run(file, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { cwd: root, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${file} exited with ${code}`)))
  })
}

async function copyNodeRuntime(target) {
  await mkdir(target, { recursive: true })
  if (process.platform === 'win32') {
    const prefix = dirname(process.execPath)
    await cp(process.execPath, join(target, 'node.exe'))
    await cp(join(prefix, 'node_modules', 'corepack'), join(target, 'node_modules', 'corepack'), { recursive: true })
    await copyNodeLicense(prefix, target)
    return
  }

  const prefix = resolve(dirname(process.execPath), '..')
  await mkdir(join(target, 'bin'), { recursive: true })
  await cp(process.execPath, join(target, 'bin', 'node'))
  await cp(join(prefix, 'lib', 'node_modules', 'corepack'), join(target, 'lib', 'node_modules', 'corepack'), { recursive: true })
  await copyNodeLicense(prefix, target)
  const corepack = '#!/bin/sh\nset -eu\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$HERE/node" "$HERE/../lib/node_modules/corepack/dist/corepack.js" "$@"\n'
  await writeFile(join(target, 'bin', 'corepack'), corepack)
  await chmod(join(target, 'bin', 'node'), 0o755)
  await chmod(join(target, 'bin', 'corepack'), 0o755)
}

async function copyNodeLicense(prefix, target) {
  const candidates = [process.env.NODE_RUNTIME_LICENSE, join(prefix, 'LICENSE'), join(prefix, 'LICENSE.md')].filter(Boolean)
  for (const candidate of candidates) {
    if (await lstat(candidate).then((stats) => stats.isFile(), () => false)) {
      await cp(candidate, join(target, 'NODE-LICENSE'))
      return
    }
  }
  throw new Error('the Node.js distribution license is unavailable; set NODE_RUNTIME_LICENSE to its path')
}

async function assertNoLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) throw new Error(`release staging contains a symbolic link: ${path}`)
    if (entry.isDirectory()) await assertNoLinks(path)
  }
}

const { stage, version } = parseArgs(process.argv.slice(2))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
if (manifest.version !== version) throw new Error(`release version ${version} does not match package.json ${manifest.version}`)
await lstat(stage).then(
  () => { throw new Error(`release staging path already exists: ${stage}`) },
  (error) => { if (error?.code !== 'ENOENT') throw error },
)

await mkdir(stage, { recursive: true })
const corepack = process.platform === 'win32'
  ? [process.execPath, join(dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'corepack.js')]
  : ['corepack']
await run(corepack[0], [
  ...corepack.slice(1), 'pnpm@10.15.0', '--filter', '@dsh-lite/cli', 'deploy', '--prod', '--legacy',
  '--config.node-linker=hoisted', join(stage, 'app'),
])
await copyNodeRuntime(join(stage, 'runtime'))

for (const file of ['LICENSE', 'NOTICE.md', 'README.md', 'README.zh.md']) {
  await cp(join(root, file), join(stage, file))
}
await cp(join(root, 'assets'), join(stage, 'assets'), { recursive: true })
await cp(join(root, 'examples'), join(stage, 'examples'), { recursive: true })
await writeFile(join(stage, 'VERSION'), `${version}\n`)

if (process.platform === 'win32') {
  await writeFile(join(stage, 'dsh-lite.cmd'), [
    '@echo off',
    'setlocal',
    'set "DSH_LITE_ROOT=%~dp0"',
    'set "PATH=%DSH_LITE_ROOT%runtime;%PATH%"',
    '"%DSH_LITE_ROOT%runtime\\node.exe" "%DSH_LITE_ROOT%app\\dist\\src\\bin.js" %*',
    '',
  ].join('\r\n'))
} else {
  const launcher = '#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nPATH="$ROOT/runtime/bin:$PATH" exec "$ROOT/runtime/bin/node" "$ROOT/app/dist/src/bin.js" "$@"\n'
  await writeFile(join(stage, 'dsh-lite'), launcher)
  await chmod(join(stage, 'dsh-lite'), 0o755)
}

await assertNoLinks(stage)
process.stdout.write(`prepared ${stage}\n`)
