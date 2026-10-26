// An error meant for the client. `code` is a translation key under `errors.` in the
// frontend, so the server never sends user-facing text, and never internal details.
export class HttpError extends Error {
  constructor(status, code, params = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendError(res, error) {
  if (error instanceof HttpError) return sendJson(res, error.status, { error: error.code, params: error.params });
  console.error('[http] Unhandled error:', error);
  return sendJson(res, 500, { error: 'internal', params: {} });
}

export function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

// Set on every response. The CSP only allows our own scripts and styles, and avatars
// from Discord's CDN, so injected markup can't load or run anything.
export function setSecurityHeaders(res, { secureCookies }) {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' https://cdn.discordapp.com data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}
