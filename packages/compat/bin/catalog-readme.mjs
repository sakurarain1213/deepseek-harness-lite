import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function renderCatalog(catalog) {
  const plugins = Array.isArray(catalog?.plugins) ? catalog.plugins : []
  const lines = [
    '# Plugin verification catalog',
    '',
    'Recommendations are derived from pinned install, build, and activation evidence. A listed entry is discoverable but not recommended.',
    '',
    '| Plugin | Package | Status | Recommended | Source commit | Last verified |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const plugin of plugins) {
    const commit = /^[0-9a-f]{40}$/.test(plugin.sourceCommit ?? '') ? plugin.sourceCommit.slice(0, 12) : 'unavailable'
    lines.push(`| \`${plugin.id}\` | \`${plugin.package}\` | ${plugin.status} | ${plugin.recommended ? 'yes' : 'no'} | \`${commit}\` | ${plugin.lastVerifiedAt} |`)
  }
  return `${lines.join('\n')}\n`
}

async function main() {
  const args = process.argv.slice(2)
  const valueAfter = (flag) => {
    const index = args.indexOf(flag)
    return index < 0 ? undefined : args[index + 1]
  }
  const input = valueAfter('--input')
  if (!input) throw new Error('--input is required')
  const rendered = renderCatalog(JSON.parse(await readFile(resolve(input), 'utf8')))
  if (args.includes('--stdout')) process.stdout.write(rendered)
  const output = valueAfter('--output')
  if (output) await writeFile(resolve(output), rendered)
  if (!args.includes('--stdout') && !output) throw new Error('--stdout or --output is required')
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main()
