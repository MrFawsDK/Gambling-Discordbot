import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { gameMeta, playCoinflip, playPlinko, playRoulette, playRps, playSlots } from './games/games.js';
import { readJson } from './http/body.js';
import { parseCookies, serializeCookie } from './http/cookies.js';
import { HttpError, redirect, sendError, sendJson, setSecurityHeaders } from './http/respond.js';
import { Router } from './http/router.js';
import { serveStatic } from './http/static.js';
import { RateLimiter } from './services/rateLimit.js';

const SESSION_COOKIE = 'sid';
const STATE_COOKIE = 'oauth_state';
const SNOWFLAKE = /^\d{17,20}$/;
const LOCALES = new Set(['da']);
// Admin grants are capped so a typo with too many zeros can't wreck a server's economy.
const ADMIN_MAX_AMOUNT = 1_000_000_000;
const ADMIN_LOG_SIZE = 25;

/**
 * Builds the HTTP server. Everything it needs is passed in, so tests can run it against
 * an in-memory database and a fake Discord login.
 */
export function createApp({ config, botConfig, economy, profiles, stats, sessions, auth, minesManager, blackjack, poker }) {
  const games = botConfig.games;
  const meta = gameMeta(botConfig);
  const loginLimiter = new RateLimiter({ windowMs: 60_000, max: 10 });
  const actionLimiter = new RateLimiter({ windowMs: config.actionIntervalMs, max: 1 });
  const router = new Router();
  // Admin actions since the last restart. The full trail is in the server log.
  const adminLog = [];

  // --- Helpers ---------------------------------------------------------------------

  function clientIp(req) {
    if (config.trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  function sessionCookie(token, maxAgeSeconds) {
    return serializeCookie(SESSION_COOKIE, token, { maxAgeSeconds, secure: config.secureCookies });
  }

  function requireSession(ctx) {
    if (!ctx.session) throw new HttpError(401, 'unauthorized');
    return ctx.session;
  }

  // Only servers the bot is in AND the player is a member of (from their Discord login).
  function allowedGuilds(session) {
    const known = stats.knownGuilds();
    return [...session.guildIds].filter((id) => known.has(id)).map((id) => known.get(id));
  }

  function requireGuild(ctx) {
    const session = requireSession(ctx);
    const { guildId } = ctx.params;
    if (!SNOWFLAKE.test(guildId) || !session.guildIds.has(guildId) || !stats.knownGuilds().has(guildId)) {
      throw new HttpError(403, 'notMember');
    }
    return { guildId, userId: session.user.id, user: session.user };
  }

  // Every POST changes something, so it must come from our own page. Browsers always send
  // Origin on fetch POSTs, and another site can't fake it.
  // Same list as the bot's admin commands, but only user IDs: the website doesn't know
  // anyone's roles, so the admin role from Discord doesn't count here.
  function isAdmin(session) {
    return Boolean(session && botConfig.adminIds.has(session.user.id));
  }

  function requireAdmin(ctx) {
    const session = requireSession(ctx);
    if (!isAdmin(session)) throw new HttpError(403, 'notAdmin');
    return session;
  }

  function requireKnownGuild(guildId) {
    if (!SNOWFLAKE.test(guildId) || !stats.knownGuilds().has(guildId)) throw new HttpError(404, 'notFound');
    return guildId;
  }

  function checkOrigin(req) {
    if (req.headers.origin !== config.baseUrl) throw new HttpError(403, 'badOrigin');
  }

  function limitActions(player) {
    if (!actionLimiter.hit(player.userId)) throw new HttpError(429, 'tooFast');
  }

  // --- Auth ------------------------------------------------------------------------

  router.get('/auth/login', (req, res) => {
    if (!loginLimiter.hit(clientIp(req))) throw new HttpError(429, 'tooFast');
    // The state ties the callback to this browser, so nobody can log you in as them (login CSRF).
    const state = randomBytes(16).toString('base64url');
    redirect(res, auth.authorizeUrl(state), {
      'Set-Cookie': serializeCookie(STATE_COOKIE, state, { maxAgeSeconds: 600, secure: config.secureCookies }),
    });
  });

  router.get('/auth/callback', async (req, res, ctx) => {
    const clearState = serializeCookie(STATE_COOKIE, '', { maxAgeSeconds: 0, secure: config.secureCookies });
    const code = ctx.query.get('code');
    const state = ctx.query.get('state');
    if (!code || !state || !sameString(state, ctx.cookies[STATE_COOKIE])) {
      return redirect(res, '/?login=failed', { 'Set-Cookie': clearState });
    }

    let login;
    try {
      login = await auth.login(code);
    } catch (error) {
      if (!(error instanceof HttpError)) console.error('[auth] Login failed:', error);
      return redirect(res, '/?login=failed', { 'Set-Cookie': clearState });
    }

    profiles.saveUser(login.user.id, login.user.name, login.user.avatarUrl);
    // Logging in again replaces the old session instead of keeping both alive.
    if (ctx.sessionToken) sessions.destroy(ctx.sessionToken);
    const token = sessions.create(login);
    redirect(res, '/', {
      'Set-Cookie': [clearState, sessionCookie(token, Math.floor(config.sessionTtlMs / 1000))],
    });
  });

  router.post('/auth/logout', (req, res, ctx) => {
    checkOrigin(req);
    if (ctx.sessionToken) sessions.destroy(ctx.sessionToken);
    res.setHeader('Set-Cookie', sessionCookie('', 0));
    sendJson(res, 200, { ok: true });
  });

  // --- Read-only API ---------------------------------------------------------------

  router.get('/api/me', (req, res, ctx) => {
    if (!ctx.session) return sendJson(res, 200, { user: null, guilds: [], admin: false });
    sendJson(res, 200, { user: ctx.session.user, guilds: allowedGuilds(ctx.session), admin: isAdmin(ctx.session) });
  });

  router.get('/api/meta', (req, res) => sendJson(res, 200, meta));

  router.get('/api/guilds/:guildId/stats', (req, res, ctx) => {
    const { guildId } = requireGuild(ctx);
    sendJson(res, 200, stats.guild(guildId));
  });

  router.get('/api/guilds/:guildId/me', (req, res, ctx) => {
    const { guildId, userId } = requireGuild(ctx);
    sendJson(res, 200, {
      balance: economy.getBalance(guildId, userId),
      ...stats.player(guildId, userId),
      mines: minesManager.current(guildId, userId),
      blackjack: blackjack.current(guildId, userId),
    });
  });

  // --- Games -----------------------------------------------------------------------

  function gameRoute(path, play) {
    router.post(`/api/guilds/:guildId/${path}`, async (req, res, ctx) => {
      checkOrigin(req);
      const player = requireGuild(ctx);
      const body = await readJson(req);
      limitActions(player);
      sendJson(res, 200, play(player, body));
    });
  }

  gameRoute('coinflip', (player, body) => playCoinflip(economy, games, player, body));
  gameRoute('slots', (player, body) => playSlots(economy, games, player, body));
  gameRoute('roulette', (player, body) => playRoulette(economy, games, player, body));
  gameRoute('mines/start', (player, body) => minesManager.start(player.guildId, player.userId, body));
  gameRoute('mines/reveal', (player, body) => minesManager.reveal(player.guildId, player.userId, body.tile));
  gameRoute('mines/cashout', (player) => minesManager.cashOut(player.guildId, player.userId));
  gameRoute('rps', (player, body) => playRps(economy, games, player, body));
  gameRoute('plinko', (player, body) => playPlinko(economy, games, player, body));
  gameRoute('blackjack/start', (player, body) => blackjack.start(player.guildId, player.userId, player.user.name, body));
  gameRoute('blackjack/insurance', (player, body) => blackjack.insurance(player.guildId, player.userId, body));
  gameRoute('blackjack/action', (player, body) => blackjack.act(player.guildId, player.userId, body));

  // --- Poker -----------------------------------------------------------------------

  function pokerTable(ctx) {
    const player = requireGuild(ctx);
    const id = Number(ctx.params.tableId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(404, 'pokerNoTable');
    return { player, entry: poker.get(player.guildId, id) };
  }

  router.get('/api/guilds/:guildId/poker', (req, res, ctx) => {
    const { guildId } = requireGuild(ctx);
    sendJson(res, 200, { tables: poker.list(guildId) });
  });

  router.post('/api/guilds/:guildId/poker', async (req, res, ctx) => {
    checkOrigin(req);
    const player = requireGuild(ctx);
    const body = await readJson(req);
    limitActions(player);
    const entry = poker.create(player.guildId, player.user, body);
    sendJson(res, 200, { ...poker.view(entry, player.userId), balance: economy.getBalance(player.guildId, player.userId) });
  });

  // Polled by the browser about once a second while the table is open.
  router.get('/api/guilds/:guildId/poker/:tableId', (req, res, ctx) => {
    const { player, entry } = pokerTable(ctx);
    sendJson(res, 200, poker.view(entry, player.userId));
  });

  for (const action of ['join', 'leave', 'start', 'act']) {
    router.post(`/api/guilds/:guildId/poker/:tableId/${action}`, async (req, res, ctx) => {
      checkOrigin(req);
      const { player, entry } = pokerTable(ctx);
      const body = await readJson(req);
      limitActions(player);
      poker[action](entry, player.user, body);
      sendJson(res, 200, { ...poker.view(entry, player.userId), balance: economy.getBalance(player.guildId, player.userId) });
    });
  }

  // --- Admin -----------------------------------------------------------------------

  // Every server the bot knows, not only the admin's own, so coins can be fixed anywhere.
  router.get('/api/admin/guilds', (req, res, ctx) => {
    requireAdmin(ctx);
    const guilds = [...stats.knownGuilds().values()].map((g) => ({ ...g, ...stats.economySummary(g.id) }));
    sendJson(res, 200, { guilds });
  });

  router.get('/api/admin/guilds/:guildId/players', (req, res, ctx) => {
    requireAdmin(ctx);
    const guildId = requireKnownGuild(ctx.params.guildId);
    sendJson(res, 200, {
      summary: stats.economySummary(guildId),
      players: stats.players(guildId),
      log: adminLog.filter((entry) => entry.guildId === guildId),
    });
  });

  router.post('/api/admin/guilds/:guildId/coins', async (req, res, ctx) => {
    checkOrigin(req);
    const admin = requireAdmin(ctx);
    const guildId = requireKnownGuild(ctx.params.guildId);
    const { action, amount, userId = null, everyone = false } = await readJson(req);

    if (action !== 'add' && action !== 'remove') throw new HttpError(400, 'badRequest');
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new HttpError(400, 'invalidAmount');
    if (amount > ADMIN_MAX_AMOUNT) throw new HttpError(400, 'adminTooMuch', { max: ADMIN_MAX_AMOUNT });
    // Exactly one target. "Everyone" only exists for adding, like /addcoins in Discord.
    if (everyone !== true && everyone !== false) throw new HttpError(400, 'badRequest');
    if (everyone === (userId !== null)) throw new HttpError(400, 'adminPickTarget');
    if (everyone && action === 'remove') throw new HttpError(400, 'badRequest');
    if (userId !== null && (typeof userId !== 'string' || !SNOWFLAKE.test(userId))) throw new HttpError(400, 'adminBadUser');

    let result;
    if (everyone) result = { count: economy.grantAll(guildId, amount) };
    else if (action === 'add') result = economy.grant(guildId, userId, amount);
    else result = economy.revoke(guildId, userId, amount);

    const entry = {
      at: Date.now(),
      guildId,
      action,
      target: everyone ? null : userId,
      amount: action === 'remove' ? result.removed : amount,
      count: result.count ?? null,
    };
    adminLog.unshift(entry);
    adminLog.length = Math.min(adminLog.length, ADMIN_LOG_SIZE);
    console.log(`[admin] ${admin.user.id} ${action} ${entry.amount} -> ${everyone ? `everyone (${result.count})` : userId} in ${guildId}`);

    sendJson(res, 200, { ...result, entry });
  });

  // --- Server ----------------------------------------------------------------------

  async function handle(req, res) {
    setSecurityHeaders(res, config);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cookies = parseCookies(req.headers.cookie);
    const sessionToken = cookies[SESSION_COOKIE] || null;
    const ctx = { query: url.searchParams, cookies, sessionToken, session: sessions.get(sessionToken), params: {} };

    try {
      const match = router.match(req.method, url.pathname);
      if (match?.methodNotAllowed) throw new HttpError(405, 'badRequest');
      if (match) {
        ctx.params = match.params;
        return await match.handler(req, res, ctx);
      }

      const localeMatch = /^\/locales\/([a-z]{2})\.json$/.exec(url.pathname);
      if (localeMatch && LOCALES.has(localeMatch[1])) {
        if (await serveStatic(req, res, config.localesDir, `/${localeMatch[1]}.json`)) return;
      }
      if (!url.pathname.startsWith('/api/') && (await serveStatic(req, res, config.publicDir, url.pathname))) return;
      throw new HttpError(404, 'notFound');
    } catch (error) {
      if (res.headersSent) {
        console.error('[http] Error after response started:', error);
        return res.end();
      }
      sendError(res, error);
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error('[http] Request failed:', error);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal', params: {} });
      else res.end();
    });
  });

  const sweeper = setInterval(() => {
    sessions.sweep();
    loginLimiter.sweep();
    actionLimiter.sweep();
  }, 60_000);
  sweeper.unref();
  server.on('close', () => clearInterval(sweeper));

  return server;
}

// Constant-time compare, so the OAuth state can't be guessed byte by byte from timings.
function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
