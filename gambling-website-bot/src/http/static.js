import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Resolves a URL path to a file inside `dir`, or null. Anything that would land outside
// it (../, encoded ../, absolute paths, null bytes) is refused.
export function resolveStatic(dir, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const file = normalize(join(dir, relative));
  if (!file.startsWith(dir + sep)) return null;
  if (!TYPES[extname(file)]) return null;
  return file;
}

// Returns true if a file was sent.
export async function serveStatic(req, res, dir, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const file = resolveStatic(dir, pathname);
  if (!file) return false;

  let info;
  try {
    info = await stat(file);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)],
    'Content-Length': info.size,
    // Small app, no build step: always revalidate so a deploy shows up right away.
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
  return true;
}
