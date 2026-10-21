import path from 'node:path';

/** Local licensed models and music are private assets, not public Dashboard code. */
export function isPrivateTownAssetPath(pathname: string): boolean {
  // serveStatic runs on Windows as well: duplicate slashes, backslashes, dot
  // segments and casing must not bypass the same auth used by uploads/API.
  const normalized = path.posix.normalize(pathname.replaceAll('\\', '/')).toLowerCase();
  return normalized === '/town/models' || normalized.startsWith('/town/models/')
    || normalized === '/town/audio/local' || normalized.startsWith('/town/audio/local/');
}
