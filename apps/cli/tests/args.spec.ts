import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'

describe('CLI arguments', () => {
  it('parses init, doctor, inspect, and run commands', () => {
    expect(parseArgs(['init', '--config', 'lite.json', '--home', '.lite'])).toEqual({ command: 'init', config: 'lite.json', home: '.lite' })
    expect(parseArgs(['doctor', '--home', '.lite'])).toEqual({ command: 'doctor', home: '.lite' })
    expect(parseArgs(['inspect', '--home', '.lite'])).toEqual({ command: 'inspect', home: '.lite' })
    expect(parseArgs(['run', 'answer', 'briefly', '--home', '.lite'])).toEqual({ command: 'run', task: 'answer briefly', home: '.lite' })
  })

  it('rejects unknown and repeated options', () => {
    expect(() => parseArgs(['doctor', '--home', '.lite', '--typo', 'yes'])).toThrow('unknown option "--typo"')
    expect(() => parseArgs(['doctor', '--home', '.lite', '--home', '.other'])).toThrow('duplicate option "--home"')
  })
})
