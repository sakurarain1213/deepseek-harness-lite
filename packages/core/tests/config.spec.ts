import { describe, expect, it } from 'vitest'
import { parseLiteConfig } from '../src/config.js'

const validConfig = {
  schemaVersion: 1,
  upstream: { channel: 'stable', version: '0.1.0-rc.6' },
  profile: 'custom',
  packs: [],
  plugins: [],
}

describe('parseLiteConfig', () => {
  it('accepts the exact versioned schema', () => {
    expect(parseLiteConfig(validConfig)).toEqual(validConfig)
  })

  it('rejects unknown fields', () => {
    expect(() => parseLiteConfig({ ...validConfig, typo: true })).toThrow()
  })
})
