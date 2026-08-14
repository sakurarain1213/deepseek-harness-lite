import { describe, expect, it } from 'vitest'
import { isPathInside } from '../src/path-containment.js'

describe('path containment', () => {
  it('treats Windows namespaced junction targets as local to the same node_modules tree', () => {
    const root = 'D:\\a\\project\\profile\\node_modules'

    expect(isPathInside(root, '\\\\?\\D:\\a\\project\\profile\\node_modules\\.pnpm\\cordis\\node_modules\\@deepseek-ai\\cordis', 'win32')).toBe(true)
    expect(isPathInside(root, '\\\\?\\d:\\A\\PROJECT\\profile\\node_modules\\.pnpm\\cordis', 'win32')).toBe(true)
    expect(isPathInside(root, '\\\\?\\D:\\a\\project\\outside\\cordis', 'win32')).toBe(false)
  })

  it('keeps POSIX containment strict', () => {
    expect(isPathInside('/profile/node_modules', '/profile/node_modules/.pnpm/cordis', 'linux')).toBe(true)
    expect(isPathInside('/profile/node_modules', '/profile/other/cordis', 'linux')).toBe(false)
  })
})
