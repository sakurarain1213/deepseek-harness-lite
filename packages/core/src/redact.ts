const SECRET_KEY = /^(?:api[-_]?key|authorization|credential|password|secret|token|access[-_]?token|refresh[-_]?token)$/i

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value === null || typeof value !== 'object') return value

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    SECRET_KEY.test(key) ? '[REDACTED]' : redact(entry),
  ]))
}
