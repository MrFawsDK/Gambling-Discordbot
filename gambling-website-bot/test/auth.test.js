import assert from 'node:assert/strict';
import { test } from 'node:test';
import { avatarUrl, createDiscordAuth, parseGuildIds, parseUser } from '../src/auth/discord.js';
import { SessionStore } from '../src/auth/sessions.js';

const ID = '200000000000000001';

test('Discord responses are validated', () => {
  assert.deepEqual(parseUser({ id: ID, username: 'alice', global_name: 'Alice', avatar: null }), {
    id: ID,
    name: 'Alice',
    avatarUrl: avatarUrl(ID, null),
  });
  assert.throws(() => parseUser({ id: '../../etc' }));
  assert.throws(() => parseUser(null));
  assert.deepEqual(parseGuildIds([{ id: '100000000000000001' }, { id: 'x' }, null, { id: 5 }]), ['100000000000000001']);
  assert.throws(() => parseGuildIds({}));
});

test('avatar URLs only use real avatar hashes', () => {
  assert.equal(avatarUrl(ID, 'a_0123456789abcdef0123456789abcdef'), `https://cdn.discordapp.com/avatars/${ID}/a_0123456789abcdef0123456789abcdef.png?size=128`);
  assert.match(avatarUrl(ID, '../../evil'), /^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
});

test('login exchanges the code and never keeps the token', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    const body = url.endsWith('/oauth2/token')
      ? { access_token: 'secret-token' }
      : url.endsWith('/users/@me')
        ? { id: ID, username: 'alice' }
        : [{ id: '100000000000000001' }];
    return { ok: true, status: 200, json: async () => body };
  };
  const auth = createDiscordAuth({ clientId: 'cid', clientSecret: 'shh', redirectUri: 'http://localhost/auth/callback', fetch });
  const result = await auth.login('the-code');
  assert.deepEqual(result.guildIds, ['100000000000000001']);
  assert.ok(!JSON.stringify(result).includes('secret-token'));
  assert.equal(calls[0].options.body.get('code'), 'the-code');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer secret-token');

  const url = new URL(auth.authorizeUrl('abc'));
  assert.equal(url.searchParams.get('scope'), 'identify guilds');
  assert.equal(url.searchParams.get('state'), 'abc');
});

test('a Discord error becomes loginFailed', async () => {
  const auth = createDiscordAuth({ clientId: 'c', clientSecret: 's', redirectUri: 'r', fetch: async () => ({ ok: false, status: 401 }) });
  await assert.rejects(auth.login('x'), { code: 'loginFailed' });
});

test('sessions expire', () => {
  let now = 0;
  const store = new SessionStore({ ttlMs: 1000, now: () => now });
  const token = store.create({ user: { id: ID }, guildIds: ['1'] });
  assert.ok(token.length >= 40);
  assert.equal(store.get(token).guildIds.has('1'), true);
  now = 1000;
  assert.equal(store.get(token), null);
  assert.equal(store.get(''), null);
  assert.equal(store.get(undefined), null);
});
