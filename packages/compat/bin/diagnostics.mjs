const MAX_DIAGNOSTIC_LENGTH = 512

export function sanitizeDiagnostic(value) {
  return String(value)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1[redacted]@')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b((?:api[_-]?key|authorization|token)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{24,}|ah-[0-9a-f]{64})\b/gi, '[redacted]')
    .slice(0, MAX_DIAGNOSTIC_LENGTH)
}
