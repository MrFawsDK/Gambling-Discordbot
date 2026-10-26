import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { parseCookies, serializeCookie } from '../src/http/cookies.js';
import { Router } from '../src/http/router.js';
import { resolveStatic } from '../src/http/static.js';

const DIR = join(sep, 'srv', 'public');

test('resolveStatic stays inside the folder', () => {
  assert.equal(resolveStatic(DIR, '/'), join(DIR, 'index.html'));
  assert.equal(resolveStatic(DIR, '/js/app.js'), join(DIR, 'js', 'app.js'));
  for (const path of ['/../secret.js', '/%2e%2e/secret.js', '/js/../../x.js', '/..%2fx.js', '/a%00.js', '/%E0%A4%A.js', '/x.env', '/x']) {
    assert.equal(resolveStatic(DIR, path), null, path);
  }
});

test('cookies parse safely and serialize with the right flags', () => {
  assert.deepEqual(parseCookies('a=1; b=hello%20world; bad=%E0; a=2'), { a: '1', b: 'hello world' });
  assert.deepEqual(parseCookies(undefined), {});
  assert.equal(serializeCookie('sid', 'x', { maxAgeSeconds: 10, secure: true }), 'sid=x; Path=/; HttpOnly; SameSite=Lax; Max-Age=10; Secure');
});

test('router matches params and reports wrong methods', () => {
  const router = new Router().get('/api/guilds/:id/stats', 'stats').post('/api/guilds/:id/coinflip', 'flip');
  assert.deepEqual(router.match('GET', '/api/guilds/123/stats'), { handler: 'stats', params: { id: '123' } });
  assert.deepEqual(router.match('GET', '/api/guilds/123/coinflip'), { methodNotAllowed: true });
  assert.equal(router.match('GET', '/api/guilds/123'), null);
});
