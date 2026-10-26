# Gambling Website

A website for the [gambling bot](../gambling-bot): statistics about what people have played, and the bot's games playable in the browser. It uses **the same database** as the bot, so it's the same coins, the same balance and the same leaderboards. Danish only.

> The coins are fake. There's no way to buy or cash them out.

## Features

- **Log in with Discord** (OAuth2). You only see servers that you're a member of **and** that the bot is in.
- **Statistics per server:**
  - Games played, total wagered and paid out, the house's profit, coins in circulation
  - Per game: count, return, win rate and biggest win
  - Activity over the last 14 days
  - Leaderboards for richest, most profit and most games
  - Latest games and biggest wins, marked as played in Discord or on the website
- **My stats:** your balance, win rate, net result, per game and your latest games.
- **Games:** blackjack, poker (Texas Hold'em), roulette, slots (all three machines, up to 5 spins), mines, coinflip and rock-paper-scissors. Same rules and odds as the bot, because the website runs the bot's own game code.
  - Blackjack is the bot's `BlackjackTable` played solo against the dealer: 6-deck shoe kept between rounds, insurance, double, split up to four hands, the same timers.
  - Poker tables are the bot's `PokerRoom` + `PokerStore`, so they use the same tables in the database, tagged `source = 'web'`. They're separate from the tables in Discord. The browser polls the table about once a second.
- **Admin page** (`#/admin`), only for the user IDs in the bot's `adminIds` (the admin role from Discord doesn't count, since the website can't see roles). Shows every player's balance per server and can add or remove coins per player, give everyone coins, or give coins to a Discord ID. Same `Economy.grant/revoke/grantAll` as `/addcoins` and `/removecoins`.
- No dependencies: Node's built-in `node:http` and `node:sqlite`, plus plain HTML/CSS/JS with no build step.

## Requirements

- Node.js **22.13+**
- The bot in a folder next to this one: `Discord/gambling-bot` and `Discord/gambling-website-bot`. The website imports the bot's database code, economy and games from `../gambling-bot/src` (all through `src/bot.js`).
- A **bot started at least once with v0.11.0 or later**. That version saves server and user names, and logs game history.

## Setup

1. In the [Discord developer portal](https://discord.com/developers/applications), open the bot's application (or a new one) → **OAuth2**:
   - Copy the **Client ID** and **Client Secret**.
   - Under **Redirects**, add `http://localhost:3000/auth/callback` (or `<BASE_URL>/auth/callback` in production).
2. Copy the env file and fill it in:
   ```bash
   cp .env.example .env
   ```
3. Start it:
   ```bash
   npm start
   ```
4. Open <http://localhost:3000> and log in.

No `npm install` is needed, since there are no dependencies.

## Environment variables

| Name | Required | Description |
| --- | --- | --- |
| `DISCORD_CLIENT_ID` | yes | OAuth2 client ID |
| `DISCORD_CLIENT_SECRET` | yes | OAuth2 client secret. Keep it secret, never commit it |
| `BASE_URL` | no | Public URL, default `http://localhost:<PORT>`. Must match the redirect in Discord. Cookies get `Secure` when it's https |
| `PORT` | no | Default `3000` |
| `DATABASE_PATH` | no | The bot's database, default `../gambling-bot/data/bot.db`. Relative paths are resolved from this folder |
| `TRUST_PROXY` | no | `1` only behind a reverse proxy you control, so `X-Forwarded-For` is used for rate limits |
| `MAX_BET` | no | Must match the bot's if you changed it there |

## How it shares the database with the bot

- Both processes open the same SQLite file in WAL mode with a busy timeout, so they can read and write at the same time.
- All money moves through the bot's `Economy` class in transactions, exactly as in the bot.
- Bets in escrow (a running mines game) are tagged `source = 'web'`. On startup the website only refunds its **own** interrupted games, and the bot only refunds its own. Neither can cancel a game running in the other.
- Every finished game is logged in `game_history` with `game` and `source` (`discord` or `web`). The statistics are built from that table and from the `users` table.
- The history starts with bot v0.11.0. Older games only count in the totals and leaderboards.

## Security

- **Login:** Discord OAuth2 with the scopes `identify guilds` and a random `state` checked in constant time (stops login CSRF). The Discord access token is used once to read who you are and which servers you're in, then thrown away. It's never stored.
- **Sessions:** a random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` on https), valid for 24 hours. Sessions live in memory, so a restart logs everyone out. The server list is only fetched at login, so someone who leaves a server can see its stats until the session runs out.
- **Access:** every `/api/guilds/:id/...` call checks that the ID is a Discord snowflake, that you're a member, and that the bot is in that server.
- **CSRF:** every POST must have our own `Origin` and a JSON body, so a form or script on another site can't play for you.
- **Server-side games:** the browser only sends what you pick. The result is decided and paid before the response is sent. The mines are never sent to the browser until the game is over.
- **Input:** bets must be whole numbers inside the limits. Bodies are capped at 4 KB. Machine and bet type names are checked against the real lists (`hasOwn`, so `constructor` doesn't work).
- **Headers:** a strict CSP (only our own scripts and styles, and images from `cdn.discordapp.com`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, and HSTS on https.
- **XSS:** the frontend never uses `innerHTML`. Names from Discord are always inserted as text.
- **Rate limits:** login is limited to 10 per minute per IP, and game actions to one per 300 ms per player.
- **Admin:** every `/api/admin/...` call checks the session's user ID against the bot's `adminIds`. Amounts are whole numbers up to 1,000,000,000, removal never goes below 0, and every change is logged to the server log.
- **Errors:** users only get an error code that the frontend translates. Details stay in the server log, and tokens are never logged.

## Development

```bash
npm test               # unit tests and an HTTP integration test against an in-memory database
npm run check:locales  # check da/en key and placeholder parity
```

```
locales/            da.json (all user-facing text)
public/             index.html, css/, js/ (app.js, api.js, dom.js, i18n.js, views/)
scripts/            locale check
src/
  bot.js            the only place that imports from ../gambling-bot
  app.js            routes, auth flow, access checks
  server.js         startup and graceful shutdown
  auth/             Discord OAuth2, sessions
  games/            coinflip/slots/roulette, mines sessions
  http/             cookies, JSON body, static files, router, security headers
  services/         statistics queries, rate limiter
test/
```

## Deployment

Run it next to the bot on the same machine, so both can reach the database file. Example with systemd:

```ini
[Service]
WorkingDirectory=/opt/gambling-website-bot
ExecStart=/usr/bin/npm start
Restart=on-failure
User=gambling-bot
```

- Use the same user as the bot (it needs write access to `data/`).
- Put it behind a reverse proxy with https (Caddy, nginx), set `BASE_URL=https://...` and `TRUST_PROXY=1`.
- Don't expose port 3000 directly to the internet.
