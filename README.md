# Gambling Bot + Website

A Discord bot with a fake coin economy and casino games, plus a website that shows statistics and lets you play the same games in the browser. Both use one shared SQLite database, so it's the same coins everywhere.

> The coins are fake. There's no way to buy or cash them out, and it should stay that way.

| Folder | What it is |
| --- | --- |
| [`gambling-bot/`](gambling-bot) | The Discord bot (discord.js v14, slash commands, Danish and English) |
| [`gambling-website-bot/`](gambling-website-bot) | The website (plain `node:http`, no framework, no build step, Danish) |

Each folder has its own README with every detail. This page is the overview.

## Features

**Economy**
- Balance per server, `/daily` with streak bonus, hourly `/work`, `/give` between members
- `/leaderboard`: the richest, or the biggest net losers
- `/balance` with games played, games won and net result
- Brainrot easter eggs: writing `10x67`, `6 7`, `skibidi`, `rizz`, `fanum tax`, `tung tung tung sahur` and a few more in chat pays 670 coins once per phrase, told to you by DM

**Games**: all against the house unless noted
- **Blackjack:** solo or at a table with up to 5 players, 6-deck shoe, double, split up to four hands, insurance. 3:2 blackjack, dealer stands on 17. No dealer peek, so you always play your hand, and a drawn 21 pushes against a dealer blackjack.
- **Poker:** No-Limit Texas Hold'em for 2–6 players, with side pots and crash recovery
- **Slots:** three machines (Fruit, Classic, five-reel Jackpot), up to 5 spins at once
- **Roulette:** colours, even/odd, low/high, dozens, columns and single numbers
- **Mines:** 4×5 board, 2–10 mines, cash out any time
- **Plinko:** 8/12/16 rows, three risk levels, up to 10 balls
- **Coinflip** and **rock, paper, scissors:** against the house, against a specific member, or as an open challenge

**Website**
- Discord login (OAuth2), you only see servers you share with the bot
- Server statistics: wagered, paid out, house profit, per-game return and win rate, 14-day activity, leaderboards, biggest wins
- Your own stats and history
- All the games above, running the bot's own game code, so the rules and odds are identical
- Admin page for the bot admins

**Admins** are set by Discord user ID in `gambling-bot/src/config.js` (`adminIds`). Roles and server permissions don't count, so a server admin can't print money.

## How it fits together

```
Discord ──▶ gambling-bot ──┐
                           ├──▶ SQLite (bot.db, WAL mode)
Browser ──▶ gambling-website-bot ──┘
              └─ imports ../gambling-bot/src (economy, games, db)
```

- All coin movement goes through one `Economy` class. Every change runs in a transaction and re-checks the balance inside it, so nobody can go negative or be paid twice.
- Games that take several turns hold the stake in escrow (`open_bets`). If a process restarts mid-game, the stake is refunded on startup. Each process only refunds its own games.
- Game logic in `gambling-bot/src/games/` is pure (no Discord code), which is why the website can reuse it and why it's easy to test.
- Every finished game is logged in `game_history`, which is what the website's statistics are built on.

## Quick start

Requires **Node.js 22.13+** (for the built-in `node:sqlite`).

```bash
# Bot
cd gambling-bot
cp .env.example .env        # fill in DISCORD_TOKEN, DISCORD_CLIENT_ID (and DEV_GUILD_ID while testing)
npm install
npm run deploy              # register the slash commands
npm start

# Website (in another terminal)
cd gambling-website-bot
cp .env.example .env        # DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, BASE_URL
npm start                   # http://localhost:3000
```

In the [Discord Developer Portal](https://discord.com/developers/applications):
- **Bot → Privileged Gateway Intents:** turn on **Message Content Intent** (used only for the brainrot phrases). Without it the bot can't log in.
- **OAuth2 → Redirects:** add `BASE_URL/auth/callback` for the website login.
- Invite the bot with the scopes `bot` and `applications.commands` and the permissions View Channels, Send Messages, Embed Links and, optionally, Add Reactions.

## Deployment with Docker

The `Dockerfile` in this folder builds one image for both processes. The database lives in a volume.

```bash
docker build -t gambling .

# Register slash commands
docker run --rm --env-file bot.env -w /app/gambling-bot gambling node src/deploy-commands.js

# Bot
docker run -d --name gambling-bot --restart unless-stopped \
  --env-file bot.env -v /srv/gambling/data:/data \
  -w /app/gambling-bot gambling node src/index.js

# Website, only on localhost: put a reverse proxy with https in front
docker run -d --name gambling-website --restart unless-stopped \
  --env-file website.env -v /srv/gambling/data:/data -p 127.0.0.1:18140:3000 \
  -w /app/gambling-website-bot gambling node src/server.js
```

`bot.env` and `website.env` are the `.env` files from each folder. The image sets `DATABASE_PATH=/data/bot.db` and runs as the unprivileged `node` user, so the data folder must be writable by UID 1000.

Back up the database before changes with `VACUUM INTO`, which also includes what's still in the WAL file (a plain `cp` while the bot runs doesn't):

```bash
docker run --rm -v /srv/gambling/data:/data gambling \
  node -e "new (require('node:sqlite').DatabaseSync)('/data/bot.db').exec(\"VACUUM INTO '/data/bot.db.bak'\")"
```

Running without Docker works too. See the systemd examples in each folder's README.

## Security

- Secrets only come from environment variables. `.env` files and the database are git-ignored.
- Least privilege: no admin permissions for the bot, and the only privileged intent is Message Content. Message text is matched against a fixed phrase list and never stored or logged.
- Parameterized SQL everywhere. Money moves only inside transactions.
- Website: Discord OAuth2 with a constant-time `state` check, the Discord access token is thrown away after login, `HttpOnly`/`SameSite` session cookies, Origin + JSON checks against CSRF, a strict CSP, no `innerHTML`, and every game is decided on the server. Mines positions and the dealer's hole card never reach the browser before the game ends.
- Users only see friendly error messages. Details stay in the server log.

Details are in [`gambling-website-bot/README.md`](gambling-website-bot/README.md#security).

## Tests

```bash
cd gambling-bot && npm test && npm run check:locales
cd gambling-website-bot && npm test
```

The tests cover the economy, every game's rules and payouts, poker (hand evaluator, side pots, a full hand), blackjack tables, the website's API with rigged decks, login, sessions and the locale files.

## Changelog

What changed in each version, why, and how it was tested is in [`gambling-bot/WRITEUP.md`](gambling-bot/WRITEUP.md) and [`gambling-website-bot/WRITEUP.md`](gambling-website-bot/WRITEUP.md).
