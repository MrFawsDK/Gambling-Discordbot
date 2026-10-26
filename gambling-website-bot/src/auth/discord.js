import { HttpError } from '../http/respond.js';

const API = 'https://discord.com/api/v10';
const SNOWFLAKE = /^\d{17,20}$/;
// identify: who you are. guilds: which servers you're in, so we only show their stats.
const SCOPES = 'identify guilds';

export function createDiscordAuth({ clientId, clientSecret, redirectUri, fetch = globalThis.fetch }) {
  return {
    authorizeUrl(state) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES,
        state,
        prompt: 'none',
      });
      return `https://discord.com/oauth2/authorize?${params}`;
    },

    // Trades the code for a token, reads the user and their guilds, then forgets the token.
    // We never store it, so a leak of the server can't be used to act as anyone on Discord.
    async login(code) {
      const tokenResponse = await call(fetch, `${API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        }),
      });
      const accessToken = tokenResponse?.access_token;
      if (typeof accessToken !== 'string') throw new HttpError(502, 'loginFailed');

      const headers = { Authorization: `Bearer ${accessToken}` };
      const [user, guilds] = await Promise.all([
        call(fetch, `${API}/users/@me`, { headers }),
        call(fetch, `${API}/users/@me/guilds`, { headers }),
      ]);
      return { user: parseUser(user), guildIds: parseGuildIds(guilds) };
    },
  };
}

async function call(fetch, url, options) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    console.error('[auth] Discord request failed:', error.message);
    throw new HttpError(502, 'loginFailed');
  }
  if (!response.ok) {
    // Only the status is logged; the body can contain tokens.
    console.error(`[auth] Discord answered ${response.status} for ${new URL(url).pathname}`);
    throw new HttpError(502, 'loginFailed');
  }
  return response.json();
}

// Discord's response is validated like any other external input.
export function parseUser(raw) {
  if (!raw || !SNOWFLAKE.test(raw.id)) throw new HttpError(502, 'loginFailed');
  const name = String(raw.global_name || raw.username || 'Discord user').slice(0, 100);
  return { id: raw.id, name, avatarUrl: avatarUrl(raw.id, raw.avatar) };
}

export function parseGuildIds(raw) {
  if (!Array.isArray(raw)) throw new HttpError(502, 'loginFailed');
  return raw.map((g) => g?.id).filter((id) => typeof id === 'string' && SNOWFLAKE.test(id));
}

export function avatarUrl(userId, hash) {
  if (typeof hash === 'string' && /^(a_)?[0-9a-f]{32}$/.test(hash)) {
    return `https://cdn.discordapp.com/avatars/${userId}/${hash}.png?size=128`;
  }
  // Discord's default avatar for users without one.
  return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(userId) >> 22n) % 6n)}.png`;
}
