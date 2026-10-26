# Gambling Bot

A Discord bot with a fake coin economy and minigames you can play against the house or against other members. Supports Danish and English (set per server, default Danish).

> The coins are fake. There's no way to buy or cash them out, and it should stay that way.

## Features

- **Economy:** balance per server, daily reward with streak bonus, `/work` every 30 minutes with silly jobs, transfers between members, leaderboard, and a one-time 670 coins for each brainrot phrase you write in chat (`10x67`, `6 7`, `skibidi`, `rizz`, `fanum tax`, `tung tung tung sahur` and more, see `src/services/phraseRewards.js`)
- **Coinflip:** play solo against the house, challenge a specific member, or post an open challenge anyone on the server can accept
- **Rock, paper, scissors:** against the bot, or PvP where both players pick in secret (same `opponent`/`mode` options as coinflip)
- **Blackjack:** against the dealer with Hit, Stand, Double, Split and Insurance, alone or at a table with up to 5 players sharing a 6-deck shoe. Blackjack pays 3:2, insurance 2:1, and the dealer stands on 17. The dealer doesn't peek, so you play your hand even against a dealer blackjack and push if you draw to 21
- **Slots:** three machines against the house (Fruit, Classic and five-reel Jackpot) with different risk, up to 5 spins at once
- **Mines:** find diamonds on a 4×5 board, cash out whenever you want, lose everything on a mine. 2–10 mines, max 25×, about 95 % return
- **Roulette:** European single-zero roulette: colors, even/odd, high/low, dozens, columns or a single number
- **Poker:** multiplayer No-Limit Texas Hold'em for 2–6 players against each other (not the house), with side pots, private hole cards and no rake. See [Poker](#poker)
- **Auto cleanup:** public bot messages are deleted after 1 hour (configurable); `/balance` and `/help` are private
- **i18n:** all text lives in `locales/da.json` and `locales/en.json`; slash command descriptions and choices are localized too
- **Storage:** SQLite through Node's built-in `node:sqlite` (no native dependencies)
- **Website:** [`../gambling-website-bot`](../gambling-website-bot) shows statistics and lets people play in the browser on the same database. The bot logs every finished game in `game_history` and saves display names for it

## Requirements

- Node.js **22.13+** (built-in `node:sqlite` and `--env-file-if-exists`)
- A Discord application with a bot user

## Setup

1. Create an application at <https://discord.com/developers/applications> and add a bot.
2. Copy the env file and fill it in:
   ```bash
   cp .env.example .env
   ```
3. Install and register the slash commands:
   ```bash
   npm install
   npm run deploy
   ```
   With `DEV_GUILD_ID` set, commands are registered for that server only and show up instantly. Without it they're registered globally, which can take a while.
4. Start the bot:
   ```bash
   npm start
   ```

### Invite link

Use OAuth2 → URL Generator with the scopes `bot` and `applications.commands`. The bot only needs these permissions:

- View Channels
- Send Messages
- Embed Links
- Add Reactions (optional: marks a paid brainrot message with 🪙 when the player has DMs closed)

Intents: `Guilds`, `GuildMessages` and the privileged **Message Content** intent. Turn Message Content on under Bot → Privileged Gateway Intents in the Developer Portal, or the bot can't log in. It's only used for the brainrot rewards: message text is matched against a fixed phrase list and never stored or logged. View Channels is also needed for deleting the bot's own messages after an hour. Deleting its own messages doesn't require Manage Messages.

## Environment variables

| Name | Required | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token |
| `DISCORD_CLIENT_ID` | for deploy | Application ID |
| `DEV_GUILD_ID` | no | Register commands to a single server |
| `DATABASE_PATH` | no | SQLite file, default `data/bot.db` |
| `MAX_BET` | no | Maximum bet, default `100000` |
| `MESSAGE_TTL_MINUTES` | no | Delete public bot messages after this many minutes, default `60`, `0` disables |

Bot admins (for `/addcoins` and `/removecoins`) are set in `src/config.js` with `adminIds` (user IDs). Only those IDs count: no roles and no Discord server permissions, so a server admin can't print or delete money.

Other tuning values (starting balance, daily amount, cooldowns, minimum bet) live in `src/config.js`.

## Commands

| Command | Description |
| --- | --- |
| `/balance [user]` | Wallet and game stats (only visible to you) |
| `/daily` | Daily coins, +50 per streak day (max +500) |
| `/work` | 50–250 coins, once every 30 minutes |
| `/give <user> <amount>` | Give coins to someone |
| `/leaderboard [type]` | Top 10 on the server: richest (default) or biggest net losers |
| `/coinflip <bet> <side>` | 50/50 against the house |
| `/coinflip <bet> <side> opponent:@user` | Challenge a specific member (they get pinged) |
| `/coinflip <bet> <side> mode:open` | Open challenge, the first member who accepts plays |
| `/rps <bet>` | Rock, paper, scissors against the bot (a tie refunds the bet) |
| `/rps <bet> opponent:@user` | Challenge a member, both pick in secret |
| `/rps <bet> mode:open` | Open rock, paper, scissors challenge |
| `/blackjack solo <bet>` | Blackjack against the dealer (Hit / Stand / Double / Split / Insurance) |
| `/blackjack create [bet]` | Open a table (up to 5 players): others join with their own bet, everyone plays in turn, new rounds until the table empties |
| `/slots spin <bet> [machine] [spins]` | Spin a slot machine (default Classic). `spins` plays 1–5 at once, the bet counts per spin. See [Slots](#slots) |
| `/slots paytable [machine]` | What each machine pays and its odds (only visible to you) |
| `/mines <bet> [mines]` | Mines on a 4×5 board with 2–10 mines (default 3), max 25×. See [Mines](#mines) |
| `/roulette <bet> type:<bet>` | Roulette on red/black, even/odd, low/high, a dozen or a column (2× or 3×) |
| `/roulette <bet> number:<0–36>` | Roulette on a single number (36×). See [Roulette](#roulette) |
| `/plinko <bet> [rows] [risk] [balls]` | Plinko: 8/12/16 rows (default 12), low/medium/high risk (default medium), 1–10 balls. About 99 % return, up to 1000× |
| `/poker create [options]` | Open a No-Limit Hold'em table for 2–6 players. All options are optional, see [Poker](#poker) |
| `/language <language>` | Change server language (Manage Server) |
| `/addcoins <amount> [user] [everyone]` | Bot admin: give coins to a player or everyone |
| `/removecoins <user> <amount>` | Bot admin: remove coins from a player (never below 0) |
| `/help` | Command overview |

### Command list for Discord

Ready to paste into an info channel. Copy everything inside the code block; Discord renders the formatting. Both versions stay under Discord's 2000-character limit.

<details>
<summary>Dansk</summary>

```md
## 🪙 Gambling Bot — kommandoer
Alle starter med **1.000 coins**. Dine coins er falske, dramaet er ægte.

**Økonomi**
`/balance` — se din pung og statistik (kun synlig for dig)
`/daily` — hent daglige coins (streaks giver bonus)
`/work` — tjen coins hver halve time
`/give @bruger beløb` — giv coins til nogen
`/leaderboard` — de rigeste på serveren, eller de største tabere i netto

**Coinflip**
`/coinflip bet side` — 50/50 mod huset
`/coinflip bet side opponent:@bruger` — udfordr et bestemt medlem
`/coinflip bet side mode:Åben udfordring` — alle på serveren kan tage imod

**Sten, saks, papir**
`/rps bet` — mod botten (uafgjort = du får din indsats tilbage)
`/rps bet opponent:@bruger` — udfordr et medlem, I vælger i hemmelighed
`/rps bet mode:Åben udfordring` — alle kan tage imod

**Blackjack**
`/blackjack solo bet` — mod dealeren: Træk, Stå, Doble, Split eller Forsikring. Blackjack betaler 3:2
`/blackjack create` — åbn et bord, op til 5 spillere sætter sig med hver deres indsats

**Slots**
`/slots spin bet` — enarmet tyveknægt mod huset. Vælg Frugt, Klassisk eller Jackpot med `machine`, og op til 5 spins på én gang med `spins`
`/slots paytable` — se maskinerne og hvad de betaler

**Mines**
`/mines bet` — find diamanter og tag gevinsten, før du rammer en mine. `mines` vælger 2–10 miner, maks 25×

**Roulette**
`/roulette bet type` — rød/sort, lige/ulige, lav/høj, dusin eller kolonne
`/roulette bet number` — sats på ét tal (0–36) og vind 36×

**Plinko**
`/plinko bet` — slip kugler gennem søm. `rows` vælger 8, 12 eller 16 rækker, `risk` lav/mellem/høj (op til 1000×), og `balls` op til 10 ad gangen

**Poker**
`/poker create` — åbn et Texas Hold'em-bord til 2–6 spillere. I spiller mod hinanden, ikke mod huset

*Botens beskeder slettes automatisk efter 1 time.*

**Andet**
`/help` — vis alle kommandoer
`/language` — skift botens sprog (kræver Administrer server)
```

</details>

<details>
<summary>English</summary>

```md
## 🪙 Gambling Bot — commands
Everyone starts with **1,000 coins**. The coins are fake, the drama is real.

**Economy**
`/balance` — check your wallet and stats (only visible to you)
`/daily` — claim daily coins (streaks give a bonus)
`/work` — earn coins every 30 minutes
`/give @user amount` — give coins to someone
`/leaderboard` — the richest on the server, or the biggest net losers

**Coinflip**
`/coinflip bet side` — 50/50 against the house
`/coinflip bet side opponent:@user` — challenge a specific member
`/coinflip bet side mode:Open challenge` — anyone on the server can accept

**Rock, paper, scissors**
`/rps bet` — against the bot (a tie gives your bet back)
`/rps bet opponent:@user` — challenge a member, you both pick in secret
`/rps bet mode:Open challenge` — anyone can accept

**Blackjack**
`/blackjack solo bet` — against the dealer: Hit, Stand, Double, Split or Insurance. Blackjack pays 3:2
`/blackjack create` — open a table, up to 5 players sit down with their own bet

**Slots**
`/slots spin bet` — slot machines against the house. Pick Fruit, Classic or Jackpot with `machine`, and up to 5 spins at once with `spins`
`/slots paytable` — see the machines and what they pay

**Mines**
`/mines bet` — find diamonds and cash out before you hit a mine. `mines` picks 2–10 mines, max 25×

**Roulette**
`/roulette bet type` — red/black, even/odd, low/high, dozen or column
`/roulette bet number` — bet on one number (0–36) and win 36×

**Poker**
`/poker create` — open a Texas Hold'em table for 2–6 players. You play against each other, not the house

*The bot's messages are deleted automatically after 1 hour.*

**Other**
`/help` — show all commands
`/language` — change the bot's language (requires Manage Server)
```

</details>

## Slots

Three machines with different risk. Every reel is spun on its own, and matching symbols count anywhere on the reels. A spin pays your bet times the multiplier, rounded down to whole coins (1× means you get your bet back).

| Machine | Reels | Win chance* | Return to player | Top prize |
| --- | --- | --- | --- | --- |
| Fruit (`fruit`) | 3 | 57.9 % | 98.7 % | 20× |
| Classic (`classic`, default) | 3 | 21.9 % (+30 % bet back) | 96.2 % | 100× |
| Jackpot (`jackpot`) | 5 | 27.7 % | 95.9 % | 1000× |

\* Spins that pay more than the bet.

- **Fruit:** five fruits, any pair pays 1.4–1.5×, three of a kind 3–20×. You win often, but small.
- **Classic:** a pair of 🍒 or 🍋 gives the bet back, higher pairs pay 1.2–3×, three of a kind 5–100×.
- **Jackpot:** five reels, you need at least three of a kind. Five 7️⃣ pays 1000×.

`spins` (1–5) plays several spins at once on the same machine. Everything is charged and paid as one bet, so you need `bet × spins` coins. `/slots paytable` shows the full tables and the odds, which are calculated from the weights in `src/games/slots.js`. A test keeps every machine between 94 % and 99 % return and at least 20 % win chance, so a tweak can't make one hopeless or a money printer.

## Mines

A 4×5 board of 20 tiles hides 2–10 mines (default 3). They're placed when the game starts and never move. Click tiles one at a time:

- **💎 Diamond:** your multiplier goes up. The embed shows what you'd get now and what the next diamond is worth.
- **💣 Mine:** the game is over and the bet is gone. The whole board is shown.
- **Cash out:** take the current multiplier × bet. Possible after the first diamond.
- Reaching the max of **25×** cashes out by itself.

The multiplier after *n* diamonds is the fair price for surviving *n* picks × 0.95, rounded down to two decimals and capped at 25×. Below the cap, every way of playing returns 95 % on average, so more mines just means bigger jumps and more risk. Going for the cap is a bad deal, though: with 10 mines you need 5 diamonds in a row, which returns about 41 %. That's on purpose, since the huge multipliers (over 2000×) were blowing up the economy. Example with 3 mines: 1.11× after one diamond, 1.32× after two, 2.38× after five.

Only the player who started the game can click. After 60 seconds without a click the game cashes out by itself, or refunds the bet if no tile was picked, so walking away never costs anything. The same happens if the message is deleted.

## Roulette

European roulette with one zero (37 pockets). Pick **either** `type` or `number`:

| Bet | Wins on | Pays |
| --- | --- | --- |
| Red / Black | 18 numbers | 2× |
| Even / Odd | 18 numbers | 2× |
| Low (1–18) / High (19–36) | 18 numbers | 2× |
| 1st / 2nd / 3rd dozen | 12 numbers | 3× |
| 1st / 2nd / 3rd column | 12 numbers | 3× |
| `number` (0–36) | 1 number | 36× |

The payout includes your bet: 2× on 100 coins pays 200, so you're up 100. The zero loses all `type` bets, which is the house edge: every bet returns 36/37 ≈ 97.3 % on average.

## Poker

No-Limit Texas Hold'em. Players buy in with coins from their wallet and play against each other; the bot deals, keeps track of bets and pots, and decides the winners. There's no rake: every chip that goes in comes back out to a player.

### Creating a table

`/poker create` with any of these options:

| Option | Default | Notes |
| --- | --- | --- |
| `buy_in` | the minimum buy-in | Your own buy-in as the host |
| `small_blind` | 10 | |
| `big_blind` | 2 × small blind (20) | Can't be smaller than the small blind |
| `min_buy_in` | 20 big blinds (400) | At least 10 big blinds |
| `max_buy_in` | 100 big blinds (2,000) | At least the minimum, at most `MAX_BET` |
| `max_players` | 6 | 2–6 |
| `turn_timeout` | 60 | 15–300 seconds |

The table message has **Join** (opens a buy-in form), **Start game** (host only, needs 2 players), **Leave** and **Players**. The coins for a buy-in leave the wallet right away and become chips on the table.

### Playing

1. The dealer button (🔘) moves one seat each hand. The two players after it post the small and big blind. Heads-up, the button posts the small blind, acts first before the flop and last after it.
2. Everyone gets two private cards. Press **My cards** to see them; only you can see that reply, and when it's your turn it has your action buttons too.
3. Betting rounds: pre-flop, flop (3 cards), turn (1), river (1). Actions: **Fold**, **Check**, **Call**, **Bet/Raise** (opens a form for the total bet), **All-in**. The action buttons on the table message work too, but only for whoever's turn it is.
4. If everyone else folds, the last player wins without showing. Otherwise the best five-card hand from your two cards and the five on the board wins.
5. The next hand starts by itself 8 seconds later. Join and leave between hands.

**Rules the bot enforces** (they follow the Poker TDA rules):

- A bet or raise must be at least the big blind, and a raise at least as big as the last full bet or raise. You can always go all-in for less.
- An all-in that's less than a full raise doesn't reopen the betting: players who already acted can only call or fold, unless the all-ins together add up to a full raise.
- A betting round ends only when everyone still in has acted and matched the highest bet, not just when everyone has acted once.
- Side pots: when someone is all-in for less, they can only win what they matched from each player. The rest goes into side pots that only the players who paid into them can win. Each pot is decided separately.
- The part of a bet nobody called goes back to the player who made it.
- Ties split the pot. Odd chips go to the winner closest to the left of the button.
- Every hand still in at a showdown is shown. Folded hands are never shown.
- **Timeouts:** no answer within the turn timeout means an automatic check, or a fold if there's a bet. Two timeouts in a row and you're taken off the table after that hand, with your chips going back to your wallet.
- **Leaving:** between hands you're cashed out at once. During a hand you're in, your chips stay in play, you check or fold automatically, and you're cashed out when the hand ends.
- A player who runs out of chips is removed after the hand and can buy in again with **Join**.

Simplifications compared to a casino: no dead button (the button just moves to the next occupied seat), new players are dealt in right away without posting, no straddles or antes, and no time bank.

### When something goes wrong

- **Bot restart:** a table can't survive a restart (its buttons and timers are gone). On startup every open table is closed, and everyone gets the stack they had before the unfinished hand. The old table message is edited to say so.
- **Table message deleted:** the same thing happens right away.
- **Nobody starts the table** within 10 minutes: it closes and returns the buy-ins.

## Development

```bash
npm test               # unit tests (economy, i18n, game logic, poker)
npm run check:locales  # check da/en key and placeholder parity
```

### Project structure

```
locales/            da.json + en.json (all user-facing text)
scripts/            check-locales.js
src/
  commands/         one file per slash command + index.js registry (poker.js + pokerView.js for poker)
  games/            pure game logic (no Discord code, easy to test)
    payout.js       shared rounding for fractional multipliers (slots, mines)
    poker/          cards, hand evaluator, betting rules, pots, one hand, the table
  services/         economy (all coin movement), guild settings, message cleanup,
                    pokerStore (poker persistence), pokerRoom (runs a poker table)
  utils/            embeds, errors, formatting, cooldowns, shared PvP challenge flow
  config.js         env + tuning values
  db.js             SQLite schema and transaction helper
  deploy-commands.js
  index.js          client + interaction routing
test/
```

### Adding a new game

1. Put the pure logic in `src/games/<game>.js` and test it in `test/`.
2. Create `src/commands/<game>.js` and settle money through `Economy`, always with the game's name so it shows up in the statistics (`settleSolo(..., 'coinflip')`, `placeBet(..., { game: 'slots' })`): `settleSolo` / `settleDuel` for instant games, or `placeBet` → `resolveBet` for games that take several turns (the stake is held in escrow, so it can't be given away mid-game). Fractional multipliers go through `payout()` in `src/games/payout.js`. For PvP, use `startChallenge` from `src/utils/challenge.js`; it handles Accept/Decline, open challenges and balance checks.
   - A game with its own bookkeeping (like poker chips) uses `withdraw` / `deposit` with a `record` callback, so the wallet change and the game's own rows land in the same transaction.
   - Buttons normally use a collector on the message. A command can instead export `handleComponent(interaction, ctx)`: `index.js` then routes every button and modal whose custom ID starts with `<command>:` to it. Export `managesCleanup = true` if the command schedules its own message deletion.
3. Add the command to `src/commands/index.js`.
4. Add text to **both** locale files and run `npm run check:locales`.
5. Run `npm run deploy` to register the command.

## Deployment

Any machine with Node 22.13+ works. Example with systemd:

```ini
[Service]
WorkingDirectory=/opt/gambling-bot
ExecStart=/usr/bin/npm start
Restart=on-failure
User=gambling-bot
```

Run it as a dedicated non-root user that only has write access to the `data/` folder. Back up `data/bot.db` if people care about their coins.

The website (`../gambling-website-bot`) can run on the same machine against the same `data/bot.db`. Both processes open it in WAL mode with a busy timeout, and each only refunds its own interrupted games on startup (`open_bets.source`).
