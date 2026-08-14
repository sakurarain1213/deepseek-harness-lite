import { expect, it } from 'vitest'
import { redact } from '../src/redact.js'

it('redacts credentials without changing ordinary metadata', () => {
  expect(redact({ authorization: 'Bearer secret', model: 'flash', apiKey: 'ah-secret' }))
    .toEqual({ authorization: '[REDACTED]', model: 'flash', apiKey: '[REDACTED]' })
})

it('redacts nested credentials without mutating the input', () => {
  const input = { nested: [{ access_token: 'secret', label: 'safe' }] }
  expect(redact(input)).toEqual({ nested: [{ access_token: '[REDACTED]', label: 'safe' }] })
  expect(input.nested[0]?.access_token).toBe('secret')
})
