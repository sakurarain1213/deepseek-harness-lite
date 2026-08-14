import { posix, win32 } from 'node:path'

export function isPathInside(root: string, candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  const pathApi = platform === 'win32' ? win32 : posix
  const normalizedRoot = platform === 'win32' ? win32.toNamespacedPath(root) : root
  const normalizedCandidate = platform === 'win32' ? win32.toNamespacedPath(candidate) : candidate
  const path = pathApi.relative(normalizedRoot, normalizedCandidate)
  return !pathApi.isAbsolute(path) && path !== '..' && !path.startsWith(`..${pathApi.sep}`)
}
