export function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name || name in cookies) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // A malformed cookie is ignored instead of failing the request.
    }
  }
  return cookies;
}

export function serializeCookie(name, value, { maxAgeSeconds, secure = false, path = '/' } = {}) {
  // HttpOnly: scripts can't read the session. SameSite=Lax: other sites can't send it
  // along on POST requests, while the OAuth redirect back from Discord still works.
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${maxAgeSeconds}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
