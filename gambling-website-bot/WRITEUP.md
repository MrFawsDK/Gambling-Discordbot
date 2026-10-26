# Writeup

## v0.1.0 — First version

### What it is
A website next to the Discord bot with statistics per server, and coinflip, slots, roulette and mines in the browser. It runs on the bot's own database, so it's the same coins as in Discord.

### Key decisions
- **The bot's code is reused, not copied.** `src/bot.js` imports `openDatabase`, `Economy`, `Profiles` and the game modules from `../gambling-bot/src`. The rules, odds and money handling exist in one place, so the website can't drift from the bot. The price is that both folders have to sit next to each other, which the README says.
- **No framework or dependencies.** The website needs routing, cookies, a JSON body and static files. That's about 200 lines on `node:http`, and every line is visible and testable, so it doesn't need Express plus three middleware packages. It's also easier to see exactly what happens security-wise.
- **Discord OAuth2 login.** It's the only safe way to know which Discord user someone is. The scope is `identify guilds`: just enough to know who you are and which servers you can see. The access token is thrown away right after login.
- **Two processes, one database.** This needed changes in the bot (see the bot's WRITEUP v0.11.0):
  - `busy_timeout`, so a write waits for the other process's lock instead of failing.
  - `open_bets.source`, so a restart of one process doesn't refund games running in the other.
  - `game_history`, written in the same transaction as the money, so the stats always match the balances.
  - `user_profiles` / `guild_profiles`, so the stats can show names instead of IDs.
- **Sessions in memory.** No session tokens in the shared database. A restart logs everyone out, which is acceptable for this app.
- **Mines lives on the server.** The board is never sent to the browser before the game is over, and a reload gets the running game back from `/api/guilds/:id/me`. As in Discord, an idle game cashes out (or refunds) by itself after 2 minutes. On shutdown, every running game is settled before exiting.
- **CSRF via Origin + JSON.** A POST must have exactly our `Origin`, and the body must be `application/json`. Together with `SameSite=Lax` that's enough without a separate CSRF token.
- **The frontend never uses `innerHTML`.** `dom.js` builds elements with `textContent`, and the CSP blocks inline scripts and styles anyway. That's also why the bar chart sets its height through `el.style` and not a `style` attribute.

### Testing
- `npm test`: 22/22, including an integration test that starts the real HTTP server against an in-memory database with a fake Discord login. It covers:
  - Security headers, and path traversal (`../`, `%2e%2e`, `..%2f`, null bytes)
  - The OAuth flow: a missing or wrong `state`, Discord failing, a successful login, and logout
  - Access: no session, a fake session, not a member, the bot not in the server, a bad ID
  - CSRF: a foreign `Origin`, no `Origin`, a form body, broken JSON, a body that's too large, and GET on a POST route
  - Games: money and history (`source = 'web'`), validation of every input, mines keeping the board secret, resuming after a reload, forged tiles, and timeouts
  - Statistics combining Discord and website games, and keeping other servers out
- The OAuth client is tested with a fake `fetch`: the token is never in the result, and Discord errors become `loginFailed`.
- **In the browser:** headless Firefox against a demo server with test data and an automatic fake login. I checked statistics, my stats, slots, roulette and mines on desktop, and statistics on mobile (390 px). A player named `Sofie <b>bold</b>` was shown as text. Two layout bugs were found and fixed: a table that was too wide, and messy game lines.
- **Against a copy of the real `bot.db`:** the migration added the columns and tables, the 16 existing users were untouched, and `/auth/login` redirected correctly to Discord.
- **Not tested:** a real Discord login (needs a client secret) and clicking through the games in a real browser. The game flows are covered over HTTP by the integration test.

## Production deploy (gambling.mrfaws.dk)

- **No SVG.** `favicon.svg` is gone, along with the `<link rel="icon">`. An avatar that isn't from Discord's CDN is now an empty grey circle (a `span.avatar`) instead of the favicon.
- **Layout on the server**, same pattern as the other apps there:
  - `/opt/gambling/releases/<UTC timestamp>/` holds `gambling-bot/` and `gambling-website-bot/` side by side plus a `Dockerfile`; `/opt/gambling/current` points at the live release.
  - One image `gambling:<timestamp>` (node:22-alpine) runs as two containers: `gambling-bot` and `gambling-website` (`127.0.0.1:18140 -> 3000`), both `--restart unless-stopped`.
  - Both mount `/srv/gambling/data` as `/data` (`DATABASE_PATH=/data/bot.db`), so they share one database. It started as a copy of the local `bot.db`.
  - Env files live in `/opt/gambling/env/{bot,website}.env` (root, 600).
  - Caddy: a `gambling.mrfaws.dk` block that proxies to `127.0.0.1:18140`. Caddy runs with `admin off`, so config changes need `systemctl restart caddy` rather than a reload.
- **Tested:** both containers start, the bot logs in, and `https://gambling.mrfaws.dk/` returns 200. `/auth/login` redirects to Discord with the right callback, and the other sites on the server still respond after the Caddy restart.

## Danish only, new game UI and an admin page

### What changed
- **English removed.** `locales/en.json` and the language button are gone. Text still lives in `da.json`, so the server keeps sending error codes and the frontend translates them. `scripts/validateLocales.js` now only checks `da.json` for empty strings and broken placeholders. The test that every `t('...')` key and every server error code exists is still there.
- **New game UI, same games.** The server routes and the bot's game code are untouched, so odds, payouts and escrow are exactly as before. Only `public/js/views/play.js` and the CSS changed:
  - Coinflip: a 3D coin (two CSS faces with `backface-visibility`) that is tossed and lands on the result the server already decided. You pick a side, then flip.
  - Slots: a cabinet with real reels. Each reel scrolls through random filler symbols and stops on the server's result, left to right, with a slight overshoot. A pay line, LCD displays for bet/spin/win, and multi-spin runs one spin after the other.
  - Roulette: a European wheel (37 pockets in wheel order, drawn with `conic-gradient`) and a ball that orbits the other way and drops into the winning pocket. Bets are picked on a normal betting table. It's still one bet per spin, like the Discord command.
  - Mines: raised tiles that flip when revealed, a big multiplier, cash out, the other mines shown one by one when you lose, and a slider for the number of mines.
  - Shared: bet controls with ½, 2×, min and max, plus a row of recent results for coinflip and roulette.
  - All animation is CSS or the Web Animations API, and it respects `prefers-reduced-motion`. Element styles are only ever set through `el.style`, which the CSP allows.
- **Admin page** (`#/admin`, `src/app.js` + `public/js/views/admin.js`):
  - `GET /api/admin/guilds`, `GET /api/admin/guilds/:id/players`, `POST /api/admin/guilds/:id/coins` with `{ action: 'add' | 'remove', amount, userId | everyone: true }`.
  - Access uses the bot's own `adminIds` and not the admin role, because the website can't see Discord roles. So right now it's only MrFawsDK.
  - Same `Economy.grant`, `revoke` and `grantAll` as `/addcoins` and `/removecoins`. A removal takes at most what the player has.
  - Every change goes to the server log, and the last 25 are listed on the page until the next restart.

### Testing
- `npm test`: 24/24. Two new tests cover the admin API: non-admins get `notAdmin`, add/remove/everyone work, and so does input validation (bad action, decimals, too much, no target or both targets, removing from everyone, a bad ID, an unknown server) and CSRF.
- The bot's own tests still pass: 147/147.
- **In the browser:** headless Firefox (driven over WebDriver BiDi) against a demo server with an in-memory database and the admin logged in. I played all four games and took screenshots at 1280 px and 390 px. I checked that the roulette ball stops on the number the server returned and that the coin shows the right face. Two layout fixes came out of it: slot controls under the machine on phones, and the mines board above the panel on phones.

## Card games: blackjack, poker and rock-paper-scissors

### What changed
- **Blackjack** (`src/games/blackjackManager.js`, `public/js/views/blackjack.js`): solo against the dealer on the bot's own `BlackjackTable`, exactly like `/blackjack solo`. The stake goes into escrow with `placeBet`. Double, split and insurance raise it with `raiseBet`, and the round is settled once with `resolveBet`. Every player keeps their own 6-deck shoe between rounds, reshuffled at the cut card. Timers match Discord: auto-stand after 60 s, and unanswered insurance counts as no after 20 s. The dealer's hole card is **never sent** before the round is settled, so it can't be read from the page. On shutdown a running round is refunded.
- **Poker** (`src/games/webPoker.js`, `public/js/views/poker.js`): No-Limit Hold'em tables between website players, on the bot's own `PokerRoom` and `PokerStore` (buy-ins, cash-outs, hands and the ledger in the same tables). Other players' hole cards are only sent at a showdown, and the deck never leaves the server. The browser polls every second and only redraws when the table's `version` changes. Turn IDs stop double clicks, just like the Discord buttons.
- **Rock-paper-scissors** against the house, like `/rps` without an opponent.
- **Change in the bot:** `poker_tables` got a `source` column (migration in `db.js`), and `PokerStore` tags tables with the economy's source. `recoverOpenTables()` now only closes its own process's tables. Without this, a bot restart would close the website's tables mid-hand (and the other way round).
- **Frontend:** playing cards built from plain elements and CSS (corners, pips, court cards, card backs), dealt from the shoe with an animation, the hole card flipped over, and the dealer's cards dealt one by one. Casino chips in colours by size. A blackjack table with the rules printed on the felt and keyboard shortcuts (H/S/D/P). An oval poker table with your own seat always at the bottom, dealer button, SB/BB, turn timer, pot, board, showdown with hand names, and a raise slider with ½ pot / pot / all-in.
- **Fixes:**
  - "Tag gevinsten" in mines failed with `badRequest`. A POST without a body had no JSON content type, so the server refused it. `api()` now always sends `{}`.
  - `api()` treats an empty response as an error instead of returning `null`.

### Testing
- `npm test`: 29/29. New tests:
  - RPS.
  - Blackjack with a rigged shoe: the hole card stays hidden, a win pays 1:1, insurance against a dealer blackjack, split + double in escrow, illegal moves and too few coins.
  - Poker: settings validation, buy-ins, only the host starts, hidden cards, wrong player / old turn ID, fold, cash-out with chips conserved, `source = 'web'`, CSRF and other servers.
  - A POST without a JSON body is refused.
- The bot: 148/148, including a new test that a restart only closes its own process's poker tables.
- **In the browser** (headless Firefox, demo server, 1280 px and 390 px): played full blackjack rounds, poker hands to showdown against two computer-controlled players, and RPS.

## Plinko

- **The game lives in the bot** (`gambling-bot/src/games/plinko.js`): 8, 12 or 16 rows and low/medium/high risk. Every peg is 50/50 (`crypto.randomInt`), and the bucket is the number of right bounces, so the edges are rare and pay the most. The return is calculated exactly from the binomial distribution: 98.9–99.1 % on every board, max 1000×. The tests check that and that every table is symmetric.
- **Discord:** `/plinko bet [rows] [risk] [balls 1–10]`. The board is drawn as dots in a code block, and the balls fall through it over a few edits, like the slot reels. The money goes through `placeBet` → `resolveBet` (game `plinko`) before the animation, same as slots.
- **Website:** `POST /api/guilds/:id/plinko` calls the bot's `drop()` and sends each ball's path back. The browser replays the paths: pegs and balls are placed in percent of the board, so it scales without measuring anything. Each ball makes a small hop between pegs and lands in its bucket, which bounces. You can drop more balls while the first ones are still falling. The board settings are locked meanwhile, and only the newest balance counts if responses arrive out of order.
- **Tested:** the bot's plinko tests (RTP, symmetry, the bucket = right bounces, validation), a website test (every ball's bucket and multiplier match the bot's table, the payout and the history), and in the browser at 1280 and 390 px.
