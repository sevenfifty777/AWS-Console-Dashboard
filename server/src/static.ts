import { existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export interface StaticFile {
  path: string;
  type: string;
  cacheControl: string;
}

/** Maps a request URL to a file of the built browser app, never outside publicDir. */
export function resolveStatic(publicDir: string, url: string): StaticFile | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.split(/[?#]/)[0] || '/');
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;

  const root = resolve(publicDir);
  let file = resolve(root, `.${pathname.startsWith('/') ? pathname : `/${pathname}`}`);
  if (file !== root && !file.startsWith(root + sep)) return null;
  // Page URLs (no file extension) all serve the app shell.
  if (file === root || !extname(file)) file = resolve(root, 'index.html');
  if (!existsSync(file) || !statSync(file).isFile()) return null;

  const hashedAsset = file.startsWith(resolve(root, 'assets') + sep);
  return {
    path: file,
    type: CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    cacheControl: hashedAsset ? 'public, max-age=31536000, immutable' : 'no-store',
  };
}
