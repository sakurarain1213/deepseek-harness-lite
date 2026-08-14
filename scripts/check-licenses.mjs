import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
const args = process.argv.slice(2)
const inputIndex = args.indexOf('--input')
const root = resolve(import.meta.dirname, '..')
const allowed = new Set(['0BSD', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'CC0-1.0', 'ISC', 'MIT', 'MPL-2.0', 'Python-2.0', 'Unlicense'])
const allowedExceptions = new Set()

function parseExpression(expression) {
  const tokens = expression.match(/\(|\)|[A-Za-z0-9][A-Za-z0-9-.+]*/g) ?? []
  if (tokens.join('').length !== expression.replace(/\s+/g, '').length || tokens.length === 0) throw new Error('invalid SPDX expression')
  let position = 0
  const rejected = []

  function primary() {
    if (tokens[position] === '(') {
      position++
      orExpression()
      if (tokens[position++] !== ')') throw new Error('unbalanced SPDX parentheses')
      return
    }
    const license = tokens[position++]
    if (!license || ['AND', 'OR', 'WITH', ')'].includes(license)) throw new Error('expected SPDX license identifier')
    if (!allowed.has(license)) rejected.push(license)
    if (tokens[position] === 'WITH') {
      position++
      const exception = tokens[position++]
      if (!exception || ['AND', 'OR', 'WITH', '(', ')'].includes(exception)) throw new Error('expected SPDX exception identifier')
      if (!allowedExceptions.has(exception)) rejected.push(exception)
    }
  }

  function andExpression() {
    primary()
    while (tokens[position] === 'AND') {
      position++
      primary()
    }
  }

  function orExpression() {
    andExpression()
    while (tokens[position] === 'OR') {
      position++
      andExpression()
    }
  }

  orExpression()
  if (position !== tokens.length) throw new Error('unexpected SPDX token')
  return rejected
}

let source
const manifestErrors = []
if (inputIndex >= 0) source = await readFile(resolve(args[inputIndex + 1]), 'utf8')
else {
  const report = {}
  const store = join(root, 'node_modules/.pnpm')
  for (const entry of await readdir(store, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const modules = join(store, entry.name, 'node_modules')
    for (const child of await readdir(modules, { withFileTypes: true }).catch(() => [])) {
      const manifests = child.name.startsWith('@')
        ? (await readdir(join(modules, child.name), { withFileTypes: true }))
          .filter((item) => item.isDirectory())
          .map((item) => join(modules, child.name, item.name, 'package.json'))
        : child.isDirectory() ? [join(modules, child.name, 'package.json')] : []
      for (const manifest of manifests) {
        let metadata
        try {
          metadata = JSON.parse(await readFile(manifest, 'utf8'))
        } catch {
          manifestErrors.push(`${manifest}: unreadable or invalid package manifest`)
          continue
        }
        if (typeof metadata?.name !== 'string' || typeof metadata?.version !== 'string') {
          manifestErrors.push(`${manifest}: package manifest lacks name or version`)
          continue
        }
        const license = typeof metadata.license === 'string' ? metadata.license : 'UNKNOWN'
        ;(report[license] ??= []).push({ name: metadata.name, version: metadata.version })
      }
    }
  }
  source = JSON.stringify(report)
}

const report = JSON.parse(source)
const rejected = [...manifestErrors]
let packages = 0
for (const [license, entries] of Object.entries(report)) {
  if (!Array.isArray(entries)) throw new Error(`invalid license report group: ${license}`)
  for (const entry of entries) {
    packages++
    const versions = Array.isArray(entry.versions) ? entry.versions : [entry.version ?? 'unknown']
    let rejectedLicense = false
    try {
      rejectedLicense = parseExpression(license).length > 0
    } catch {
      rejectedLicense = true
    }
    if (rejectedLicense) {
      for (const version of versions) rejected.push(`${entry.name ?? 'unknown'}@${version}: ${license}`)
    }
  }
}
if (rejected.length) {
  process.stderr.write(`license audit failed:\n${rejected.sort().join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`license audit passed (${packages} installed package manifests)\n`)
}
