// Tiny router: patterns like '/api/guilds/:guildId/stats'. Params are raw path segments;
// handlers validate them.
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
    return this;
  }

  get(pattern, handler) {
    return this.add('GET', pattern, handler);
  }

  post(pattern, handler) {
    return this.add('POST', pattern, handler);
  }

  // Returns { handler, params }, { methodNotAllowed: true }, or null.
  match(method, pathname) {
    const segments = pathname.split('/').filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchParts(route.parts, segments);
      if (!params) continue;
      if (route.method === method) return { handler: route.handler, params };
      pathMatched = true;
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

function matchParts(parts, segments) {
  if (parts.length !== segments.length) return null;
  const params = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(':')) params[parts[i].slice(1)] = segments[i];
    else if (parts[i] !== segments[i]) return null;
  }
  return params;
}
