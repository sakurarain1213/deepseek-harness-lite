export type CliArgs =
  | { command: 'init'; config: string; home: string }
  | { command: 'doctor' | 'inspect'; home: string }
  | { command: 'run'; task: string; home: string }

const options = (argv: string[], allowed: string[]): Map<string, string> => {
  const result = new Map<string, string>()
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]
    if (!name?.startsWith('--') || !allowed.includes(name)) throw new Error(`unknown option "${name ?? ''}"`)
    if (result.has(name)) throw new Error(`duplicate option "${name}"`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${name}`)
    result.set(name, value)
  }
  return result
}

export function parseArgs(argv: string[]): CliArgs {
  const command = argv[0]
  if (command === 'init') {
    const parsed = options(argv, ['--config', '--home'])
    const config = parsed.get('--config')
    const home = parsed.get('--home')
    if (!config || !home) throw new Error('init requires --config and --home')
    return { command, config, home }
  }
  if (command === 'doctor' || command === 'inspect') {
    const home = options(argv, ['--home']).get('--home')
    if (!home) throw new Error(`${command} requires --home`)
    return { command, home }
  }
  if (command === 'run') {
    const homeIndex = argv.indexOf('--home')
    if (homeIndex < 2 || homeIndex !== argv.length - 2) throw new Error('run requires a task and --home')
    const home = argv[homeIndex + 1]
    const task = argv.slice(1, homeIndex).join(' ').trim()
    if (!home || !task) throw new Error('run requires a task and --home')
    return { command, task, home }
  }
  throw new Error('expected init, doctor, inspect, or run')
}
