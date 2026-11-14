/**
 * Compare absolute Windows paths by separators only, and without the `\\?\` prefix Delta's
 * canonical paths carry and Claude drops; Unix spelling and case remain significant.
 */
export function pathKey(path: string, ...counterparts: string[]): string {
  const windows = (value: string) => /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\')
  if (!windows(path) && !counterparts.some(windows)) return path
  return path.replace(/\\/g, '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '')
}

/**
 * An explicitly Windows counterpart disambiguates slash-led mixed UNC spellings.
 * This contextual comparison is not transitive; do not use it to deduplicate or persist path keys.
 */
export function samePath(left: string, right: string): boolean {
  return pathKey(left, right) === pathKey(right, left)
}

/** Whether `path` is `directory` or lies inside it, compared as {@link samePath} compares. */
export function isWithin(path: string, directory: string): boolean {
  const inner = pathKey(path, directory)
  const outer = pathKey(directory, path).replace(/\/+$/, '')
  return inner === outer || inner.startsWith(`${outer}/`)
}
