import { HttpError } from './respond.js';

const MAX_BODY_BYTES = 4096;

// Only JSON objects. Requiring the JSON content type also means a plain HTML form on
// another site can't submit to the API (that would need a CORS preflight we never allow).
export async function readJson(req, limit = MAX_BODY_BYTES) {
  const type = req.headers['content-type'] ?? '';
  if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'badRequest');
  if (Number(req.headers['content-length'] ?? 0) > limit) throw new HttpError(413, 'badRequest');

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'badRequest');
    chunks.push(chunk);
  }
  if (size === 0) return {};

  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'badRequest');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'badRequest');
  return data;
}
