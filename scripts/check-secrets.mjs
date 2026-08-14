import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const args = process.argv.slice(2)
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index < 0 ? fallback : args[index + 1]
}
const root = resolve(valueAfter('--root', resolve(import.meta.dirname, '..')))
const scanHistory = !args.includes('--no-history')
const maxBlobBytes = 5 * 1024 * 1024
const patterns = [
  { name: 'private key', value: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: 'OpenAI-style token', value: /\bsk-[A-Za-z0-9_-]{24,}\b/ },
  { name: 'DeepSeek-style token', value: /\bah-[0-9a-f]{64}\b/i },
  { name: 'GitHub token', value: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { name: 'AWS access key', value: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: 'assigned credential', value: /\b(?:DEEPSEEK_API_KEY|OPENAI_API_KEY|API_KEY|ACCESS_TOKEN)\s*[=:]\s*['"]?(?!<|\$\{|process\.env)(?:sk-[A-Za-z0-9_-]{24,}|[A-Za-z0-9+/]{32,}={0,2})/i },
]

async function git(args) {
  const { stdout } = await execFileAsync('git', args, { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

function nulList(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean)
}

function findings(source, content) {
  const lines = content.split(/\r?\n/)
  const matches = []
  for (let index = 0; index < lines.length; index++) {
    for (const pattern of patterns) {
      if (pattern.value.test(lines[index])) matches.push(`${source}:${index + 1}: ${pattern.name}`)
      pattern.value.lastIndex = 0
    }
  }
  return matches
}

const files = [...new Set([
  ...nulList(await git(['ls-files', '-z'])),
  ...nulList(await git(['ls-files', '--others', '--exclude-standard', '-z'])),
])].sort()
const violations = []
for (const file of files) {
  const path = resolve(root, file)
  if (isAbsolute(file) || relative(root, path).startsWith('..')) continue
  const content = await readFile(path).catch(() => null)
  if (content === null) violations.push(`${file}: unreadable file`)
  else if (content.byteLength > maxBlobBytes) violations.push(`${file}: exceeds ${maxBlobBytes}-byte scan limit`)
  else violations.push(...findings(file, content.toString('utf8')))
}

const staged = nulList(await git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']))
for (const file of staged) {
  const blob = await git(['show', `:${file}`]).catch(() => null)
  if (blob === null) violations.push(`index:${file}: unreadable blob`)
  else if (blob.byteLength > maxBlobBytes) violations.push(`index:${file}: exceeds ${maxBlobBytes}-byte scan limit`)
  else violations.push(...findings(`index:${file}`, blob.toString('utf8')))
}

if (scanHistory) {
  const commits = (await git(['rev-list', '--all'])).toString('utf8').trim().split(/\r?\n/).filter(Boolean)
  for (const commit of commits) {
    const tree = (await git(['ls-tree', '-r', '-l', '-z', commit])).toString('utf8').split('\0').filter(Boolean)
    for (const entry of tree) {
      const match = entry.match(/^\d+\s+blob\s+[0-9a-f]+\s+(\d+)\t(.+)$/s)
      if (!match) continue
      const file = match[2]
      if (Number(match[1]) > maxBlobBytes) {
        violations.push(`${commit.slice(0, 12)}:${file}: exceeds ${maxBlobBytes}-byte scan limit`)
        continue
      }
      const blob = await git(['show', `${commit}:${file}`]).catch(() => null)
      if (blob === null) violations.push(`${commit.slice(0, 12)}:${file}: unreadable blob`)
      else violations.push(...findings(`${commit.slice(0, 12)}:${file}`, blob.toString('utf8')))
    }
  }
}

if (violations.length) {
  process.stderr.write(`secret scan failed:\n${[...new Set(violations)].join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`secret scan passed (${files.length} worktree files${scanHistory ? ' plus history' : ''})\n`)
}
