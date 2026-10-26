# Writeup

## v0.13.0 — Biggest losers

### What changed
- **`/leaderboard type:`** with the choices *Richest* (default, same as before) and *Biggest losers (net)*. The losers list sorts by `total_won - total_lost`, lowest first, and only shows players who are down overall. Each row shows the net and the total lost.
- **`Economy.losers(guildId, limit)`** next to `leaderboard`, same columns as `/balance` uses, so the numbers match.
- Brainrot rewards now go by DM instead of a reply in the channel, with a 🪙 reaction if DMs are closed.

### Testing
- `npm test`: 160/160, with a new test for the order and the filter of `losers`.
- `npm run check:locales`: in sync.

## v0.12.0 — Brainrot rewards

### What changed
- **Brainrot phrases pay 670 coins, once each:** writing `10x67`, `6 7`, `skibidi`, `rizz`, `gyatt`, `fanum tax`, `sigma`, `mewing`, `ohio`, `aura farming`, `chill guy`, `tung tung tung sahur`, `tralalero tralala`, `bombardiro crocodilo` or `brr brr patapim` in a normal message pays `economy.phraseReward` (670) the first time per player per server. No slash command, the bot just sends a DM.
- **Matching** (`services/phraseRewards.js`): case-insensitive regexes with no letter or digit allowed right before or after, so `1967`, `670` and `rizzler` don't count. Several new phrases in one message are all paid in one reply.
- **`phrase_rewards` table:** `(guild_id, user_id, phrase)` as primary key. `Economy.claimPhrases` inserts with `INSERT OR IGNORE` and only pays for the rows that went in, inside one transaction, so spamming the same message can't pay twice.
- **Intents:** `GuildMessages` and the privileged `MessageContent`. It has to be turned on in the Developer Portal. The message text is only matched against the list, never stored or logged.
- The player is told by DM, so nobody else sees it (a normal message can't be ephemeral like a slash command reply). With DMs closed, the bot reacts with 🪙 on their message instead. The coins are paid either way.

### Testing
- `npm test`: 159/159, with 3 new tests for matching (whole words, case, numbers inside other numbers) and paying once per phrase, player and server.
- `npm run check:locales`: in sync.

## v0.11.1 — No dealer peek, admins by user ID only

### What changed
- **Blackjack without the peek:** a dealer blackjack no longer ends the round at the deal. Everyone plays their hand, and a drawn 21 (or a 21 on a split hand) pushes against it instead of losing. A player blackjack still skips the turn and pushes, and insurance is settled at the end as before. `peek()` in `BlackjackTable` became `startPlayerTurns()`, and `settleRound` got the push case. The website runs on the same table, so it changes too.
- **Bot admins by user ID only:** `adminRoleIds` is gone, so `isBotAdmin` only checks `adminIds`. A role (that a server admin can hand out) no longer gives access to `/addcoins` and `/removecoins`, and neither does a Discord permission.

### Testing
- `npm test`: 156/156, with new tests for playing on against a dealer blackjack and pushing with a drawn 21.
- Website `npm test`: 30/30. The insurance test now stands before the round settles.

## v0.11.0 — Ready for the website

The new website (`../gambling-website-bot`) uses this bot's database. These changes make two processes share it safely and give the website something to show.

### What changed
- **`PRAGMA busy_timeout = 5000`:** a write that hits the other process's lock waits up to 5 seconds instead of failing at once.
- **`game_history` table:** one row per finished game per player, with `game`, `source` (`discord`/`web`), `stake` and `payout`. `Economy` writes it in the same transaction as the money (`settleSolo`, `settleDuel`, `resolveBet`, and `deposit` with `staked`), so the history can never disagree with the balances. Refunds aren't logged, since they aren't games.
- **The game's name is passed in everywhere:**
  - `settleSolo(..., game)` and `settleDuel(..., game)`
  - `placeBet(guild, user, amount, { game })` (the old `now` argument moved into the same options object)
  - `deposit(..., { game })` for poker
- **`open_bets.game` and `open_bets.source`,** added by a small migration (`ALTER TABLE` only if the column is missing, safe to run any number of times). `new Economy(db, cfg, { source })` defaults to `'discord'`. `refundOpenBets()` now only refunds bets from its own source, so a bot restart doesn't cancel a mines game running on the website, and the other way around.
- **`user_profiles` / `guild_profiles` and `services/profiles.js`:** the bot saves display names, avatar URLs and server names, on every interaction (at most every 10 minutes per user unless the name changed), on startup and on `GuildCreate`/`GuildUpdate`. A failed write is logged and never breaks a command. Only things Discord already shows publicly are stored.

### Testing
- `npm test`: 147/147 (143 + 4 new). They cover:
  - History for every settlement method, and refunds not being logged
  - `refundOpenBets` leaving the other source's bets alone, which then settle normally
  - The migration on an old `open_bets` table, run twice
  - Profiles being throttled, with a new name written right away
- Against a copy of the real `data/bot.db`, the migration added the columns and tables without touching the 16 existing users.
- Not tested live against Discord.

## v0.10.0 — Roulette, and Mines pays less

### What changed
- **New command `/roulette bet (type | number)`:** European roulette with a single zero. `type` bets on red/black, even/odd, low/high (2×) or a dozen/column (3×). `number` bets on one number, 0–36 (36×). Exactly one of the two is required.
- **Mines pays less:**
  - The house edge went from 3 % to 5 % (`HOUSE_EDGE` 0.97 → 0.95).
  - There's a cap of 25× (`MAX_MULTIPLIER`). Reaching it cashes out by itself with a "Max win!" result.
  - The minimum is now 2 mines.
- New pure module `src/games/roulette.js` and `test/roulette.test.js`. The mines tests are updated for the new rules.

### Key decisions
- **Roulette is instant and settled like slots:** `placeBet` → `resolveBet(bet × pays)` before the 1.5-second animation, because the payout is 2×, 3× or 36× and not just win/lose.
- **`number` instead of a "straight" choice.** A single-number bet needs the number anyway, so giving `number` is the bet. Giving both or neither is an error rather than a guess.
- **Every roulette bet returns exactly 36/37.** A test sums the payouts over all 37 pockets for every bet type (and every number) and requires 36. It also checks that each outside bet covers 18 or 12 numbers and never the zero.
- **Why the mines cap.** Before, the return was the same for every strategy, but 10 mines and 8 diamonds paid 2,715×. A few lucky runs printed millions and wrecked the leaderboard. Now everything below the cap returns 95 %, and going for the cap returns much less (about 41 % with 10 mines), so the giant swings are gone. Multipliers at the low end barely changed (3 mines: 1.14× → 1.11× after one diamond).
- **Minimum 2 mines:** with 1 mine and a 5 % edge, the first diamond would pay 20/19 × 0.95 = 1.00×, so it would be pointless.
- With the cap, a board can never be cleared completely, because even 2 mines hit 25× first. The `cleared` path is kept anyway in case the cap is raised.

### Testing
- `npm test`: 143/143. That's 7 new roulette tests, plus the mines tests updated for the edge, the cap (both through `reveal()` and the multiplier table) and the new minimum. This also fixes the 6 mines failures noted in v0.9.1.
- **Roulette:** a simulation ran the real command in Danish and English: a color bet with the animation, a number bet, both options, neither, a forged `type: straight`, and too few coins. 30,000 spins across every bet type: the stats matched the balance change exactly and no bets were left in escrow (empirical RTP 96.4 %, theory 97.3 %).
- **Mines:** the command simulation was rerun with the new rules, including a game that hit the 25× cap and cashed out by itself. At engine level, 300,000 games per strategy returned 94.5–95.4 % below the cap and 41 % when going for the cap with 10 mines.
- All command files pass `node --check`, `npm run check:locales` passes, and all 16 commands build with `toJSON()`.
- Not tested live against Discord. Run `npm run deploy` (new command, and the `/mines` option changed).

## v0.9.1 — /removecoins

### What changed
- New admin command `/removecoins <user> <amount>`. It uses the same check as `/addcoins` (user ID in `adminIds` or a role in `adminRoleIds`). The check moved to `src/utils/admin.js`, so the two commands can't drift apart.
- New `Economy.revoke(guildId, userId, amount)`.

### Key decisions
- **Never below 0.** Removing more than the player has takes their whole balance, and the reply says how much was actually taken. Removing from a player with 0 coins gives an error instead of a fake success.
- **Escrow is left alone.** Coins in a running blackjack, slots or mines game aren't in the balance, so `revoke` doesn't touch them, and the game settles normally.
- **Stats aren't changed.** A removal isn't a game, so `total_won` / `total_lost` stay as they are.
- No `everyone` option, unlike `/addcoins`. Wiping the whole server by mistake is a lot worse than giving everyone too much.

### Testing
- 2 new economy tests: partial and full removal, an empty balance, invalid amounts, and escrow left alone.
- A simulation ran `/removecoins` in Danish and English: a non-admin (refused), an admin by ID, an admin by role with a too-large amount (partial), an empty balance, and a bot target. `/addcoins` still worked after the refactor.
- `npm run check:locales` passes. All 15 commands build with `toJSON()`.
- `npm test`: 129 pass, 6 fail. The 6 failures are mines tests broken by the later change of `MIN_MINES` / `MAX_MINES` / `DEFAULT_MINES` in `src/games/mines.js`, not by this change.

## v0.9.0 — Mines

### What changed
- New command `/mines bet [mines]`: a 4×5 board with 1–10 hidden mines (default 3). Every diamond raises the multiplier, you can cash out after the first one, and a mine loses the bet.
- New pure game module `src/games/mines.js` (`MinesGame` + `multiplier()`) and `test/mines.test.js`.
- `payout()` moved from `games/slots.js` to `games/payout.js`, because slots and mines both pay fractional multipliers. Slots behaves the same.
- `/help`, the README and both locale files are updated. No database or `Economy` changes.

### How it works
- The mines are placed with a partial Fisher–Yates on `crypto.randomInt` when the game starts and never move.
- The board is 20 tile buttons (4 rows of 5). The fifth row is the Cash out button, which shows the current amount. When the game ends, the whole board is shown and every button is disabled.
- The bet goes into escrow with `placeBet` at the start and is settled once with `resolveBet` (0 on a mine, `payout(bet, multiplier)` on a cash-out). A crash mid-game is covered by the existing `refundOpenBets()` on startup.
- The buttons use a collector on the message, like blackjack, so `index.js` is unchanged.

### Key decisions
- **Same house edge for every strategy.** The multiplier after *n* diamonds is `1 / P(surviving n picks) × 0.97`, rounded down to two decimals. Cashing out after any number of picks with any number of mines therefore returns at most 97 % on average. That means there's no "optimal" setting that beats the house, and no setting that's a trap. Rounding down means the multiplier you see is exactly the one that gets paid, and the house never pays more than 97 %.
- **The first diamond always pays more than 1×** (lowest is 1.02× with 1 mine). A test checks this for every mine count and pick number.
- **Walking away is free.** After 60 seconds without a click (collector `idle`), the game cashes out by itself, or refunds with `refundBet` if no tile was picked. The same happens if the message is deleted (Discord error 10008/10003 on edit). An AFK player never loses money, and no stake gets stuck.
- **Cash out at 0 picks is disabled.** It would just be a refund counted as a game played.
- **Only the player can click.** Others get an ephemeral "That's not your game". Double clicks, clicks after the game ended and forged tile IDs are ignored by `reveal()`, and `finish()` only runs once, on top of `resolveBet` already being idempotent.

### Testing
- `npm test`: 133/133 (124 existing + 9 new for mines: distinct mine placement, invalid mine counts, reveal/mine/clear states, ignored double and forged clicks, cash out only once and only after a pick, exact multipliers, and every cash-out point for 1–10 mines returning between 95 % and 97 % and paying more than 1×).
- A simulation ran the real `/mines` command with a fake message and collector, in Danish and English: the start board, Cash out disabled before the first pick, a click from another user, two diamonds then cash out (+7 coins on 100 with 1 mine), a bust with the full board shown, clicks after the game ended, an idle timeout refund, a bet too high, too few coins, and a deleted message mid-game (auto cash-out). No bets were left in escrow and no untranslated keys showed up.
- 3,000 random games through the command: the stats matched the balance change exactly. At engine level, 400,000 games for each of five strategies (1–10 mines, 2–8 picks) returned 96.6–97.1 %.
- `npm run check:locales` passes. All 14 commands build with `toJSON()`.
- Not tested live against Discord. Run `npm run deploy` to register `/mines`.

## v0.8.0 — More slot machines, better odds, several spins at once

### What changed
- **Three machines** instead of one, chosen with the `machine` option (default Classic):
  - **Fruit:** 3 reels, low risk. 57.9 % of spins win something, return 98.7 %.
  - **Classic:** 3 reels, the old machine with better odds. 21.9 % win (was 8 %) plus 30 % bet back, return 96.2 % (was 95.2 %).
  - **Jackpot:** 5 reels, high risk. At least three of a kind wins (27.7 %), five 7️⃣ pays 1000×, return 95.9 %.
- **Several spins at once:** `spins` (1–5) plays that many spins on the same machine in one message. The reels stop column by column on all rows at once.
- `/slots paytable [machine]` shows every machine (or just one) with its win chance and return, calculated live from the pay table.

### Key decisions
- **Winning was too rare.** v0.7.0 paid more than the bet on only 8 % of spins, and 46 % of spins just gave the bet back. The new tables pay fractional multipliers (1.2–1.5×) on common pairs, so normal wins happen far more often. The house edge is still 1–4 % depending on the machine.
- **Fractional payouts are rounded down.** `payout()` works in hundredths (`bet × round(multiplier × 100) / 100`), so 30 × 1.3 is exactly 39 and not 38.999... rounded down to 38. With the minimum bet of 10, the rounding costs at most 1 coin per spin.
- **Only a symbol filling more than half the reels can pay** (2 of 3, or 3 of 5). That's checked when the module loads. It means at most one combination can win per spin, so `evaluate()` stays simple, and `odds()` can calculate the exact return with a binomial formula instead of walking all 21⁵ jackpot outcomes. A test checks the formula against walking every outcome.
- **Several spins are one bet.** `placeBet(bet × spins)` → `resolveBet(total payout)`, so it's one transaction pair and one game in the stats, no matter how many spins. A player who can't afford all of them gets an error saying what it costs in total, instead of playing some of them.
- The `bet` limit (`MAX_BET`) still applies per spin.

### Testing
- `npm test`: 124/124. The slots tests cover weighted reels, evaluation on all three machines (including the jackpot's three-of-a-kind minimum), payout rounding for every bet from 10 to 1999, `odds()` against walking every outcome, and RTP 94–99 % plus win chance ≥ 20 % on every machine.
- A simulation ran the real command with fake interactions in Danish and English: the paytable for all machines and for one, a stake the player can't afford, an invalid machine, and 3 spins on each machine with every animation frame (4 frames for 3 reels, 6 for 5). No untranslated keys or placeholders showed up.
- 20,000 spins per machine (5 at a time, 100 coins each): empirical RTP 99.0 % fruit, 96.6 % classic, 95.8 % jackpot. The stats matched the balance changes exactly, and no bets were left in escrow.
- `npm run check:locales` passes. All 13 commands build with `toJSON()`.
- Not tested live against Discord. Run `npm run deploy` again, because the command options changed.

## v0.7.0 — Slots

### What changed
- New command `/slots` with two subcommands: `spin bet` spins a three-reel slot machine against the house, and `paytable` shows what each combination pays (ephemeral).
- New pure game module `src/games/slots.js` (weighted reels, combination evaluation) and `test/slots.test.js`.
- `/help`, the README and both locale files are updated. No database or `Economy` changes.

### How it works
- Each reel picks a symbol independently with `crypto.randomInt` over the total weight (23). Three of a kind pays the symbol's `three` multiplier, two of a kind anywhere pays its `pair` multiplier, and anything else loses.
- All multipliers are whole numbers, so `bet × multiplier` never needs rounding.
- The reels stop one at a time (three embed edits ~0.7 s apart) before the result is shown.

### Key decisions
- **Settled through escrow, not `settleSolo`.** `settleSolo` only knows win or lose for the bet amount, but slots pays a multiplier. The command calls `placeBet` and then `resolveBet(betId, bet × multiplier)` right away, which also gets the stats right (a 1× pair counts as a game played, not won). Both happen before the animation, so the result is locked in even if editing the message fails. If the process dies between the two calls, the existing `refundOpenBets()` on startup gives the stake back.
- **The house keeps about 5 %.** The weights and pay table were tuned together for a return to player of 95.15 %. Lots of pairs pay 1× (bet back), so a session doesn't drain too fast, while three sevens pay 150×. The test walks every one of the 23³ outcomes and fails if the RTP leaves 90–99 %, so tweaking the table can't silently make it a money printer.
- **Subcommands like blackjack** (`spin` / `paytable`) instead of one command with a flag, so the pay table is easy to find in Discord's command picker.

### Testing
- `npm test`: 122/122 (116 existing + 6 new for slots: weighted mapping, out-of-range rolls, evaluation of three/pair/none, whole-number multipliers, exact RTP).
- A simulation ran the real `/slots` command with fake interactions in Danish and English: paytable, bet too low, bet too high, and a full spin with every animation frame. Then 20,000 spins of 100 coins: empirical RTP 96.3 %, the stats (`total_won − total_lost`) matched the balance change exactly, and no bets were left in escrow.
- `npm run check:locales` passes. All 13 commands build with `toJSON()`.
- Not tested live against Discord. Run `npm run deploy` to register the new command.

## v0.6.0 — Poker (No-Limit Texas Hold'em)

### What changed
- New command `/poker create` opens a multiplayer No-Limit Texas Hold'em table for 2–6 players. Options: buy-in, blinds, min/max buy-in, seats and turn timeout. All are optional and scale with the blinds (defaults 10/20, buy-in 400–2,000, 6 seats, 60 s).
- Players play against each other, not the house. Every chip that goes in comes back out to a player, so there's no rake or house fee.
- Several tables can run at once, also in the same channel, and a player can sit at more than one.
- `index.js` now routes buttons and modals with a registered prefix (`poker:`) to the command's `handleComponent`. Collectors don't work here, because players also click buttons in their own ephemeral messages. Blackjack, RPS and challenges still use collectors and are unchanged.
- `Economy` has two new methods, `withdraw` and `deposit`, each with a `record` callback that runs inside the same transaction.
- New tables: `poker_tables`, `poker_seats`, `poker_hands`, `poker_actions` and `poker_ledger`. They're created automatically on startup (`CREATE TABLE IF NOT EXISTS`), so no migration step is needed.

### How it's built
The engine is pure JavaScript with no Discord code. Every layer only knows about the one below it:

| Layer | File | Job |
| --- | --- | --- |
| Cards | `games/poker/cards.js` | 52-card deck, Fisher–Yates with `crypto.randomInt`, a `Deck` that refuses to deal the same card twice |
| Hand evaluator | `games/poker/handEvaluator.js` | Best 5 of 7 cards: scores all 21 combinations. A score is `[category, tiebreak ranks...]`, compared left to right |
| Betting engine | `games/poker/betting.js` | Legal actions, min bet/raise, short all-ins, when a round is complete |
| Pot manager | `games/poker/pots.js` | Uncalled bet refund, main/side pots by contribution level, splitting with odd chips |
| Game engine | `games/poker/hand.js` | One hand: blinds, dealing, turn order, streets, showdown and payout |
| Table | `games/poker/table.js` | Seats, stacks, button rotation, starting hands |
| Table manager | `services/pokerRoom.js` | Buy-ins and cash-outs, persistence, timers, stale-click protection |
| Persistence | `services/pokerStore.js` | All poker SQL, and wallet ↔ table moves through `Economy` |
| Discord | `commands/poker.js`, `commands/pokerView.js` | Slash command, button/modal handling, embeds |

### Key decisions
- **Chips work like escrow.** A buy-in moves coins from the wallet into `poker_seats.stack` in one transaction (`Economy.withdraw` + the seat row). A cash-out does the reverse and deletes the seat in the same transaction, so a second cash-out finds nothing to pay. Every move is also written to `poker_ledger`.
- **Stacks in the database are only written between hands.** During a hand, the stored stack is still the one from before it. Settling a hand writes the new stacks and flips the hand from `playing` to `settled` in one transaction, and `UPDATE ... WHERE status = 'playing'` means only the first settle does anything.
- **Restarts close tables instead of resuming them.** Discord buttons, timers and the in-memory deck die with the process. Rebuilding all of that is a lot of risky code for something that rarely happens. On startup, `recoverOpenTables()` voids any unfinished hand and cashes everyone out with their stack from before it, which is exactly what's stored. It runs per seat, so a crash halfway through recovery just continues the next time. The old table message is edited to explain what happened.
- **Stale clicks.** Action buttons carry a turn ID in their custom ID (`poker:<table>:<turn>:<action>`), and the turn ID changes every time the action moves on. A double click, a click on an old ephemeral message, or a click that arrives just after a timeout is refused with "That button is outdated". Interaction IDs are also de-duplicated. All game state changes are synchronous, so two clicks can't interleave.
- **Private cards.** Hole cards only appear in ephemeral replies to their owner, never in the public embed, components or custom IDs, and folded hands are never revealed. The Discord simulation (below) checks this.
- **Public action buttons plus a private view.** The table message has Fold / Check-or-Call / Bet-or-Raise / All-in, labelled for whoever's turn it is, and the server only accepts them from that player. **My cards** shows your cards with the same buttons when it's your turn. Bet/Raise opens a modal for the total bet, which is prefilled with the minimum.
- **Betting rules (Poker TDA).** The minimum raise is the size of the last full bet/raise (at least the big blind). An all-in for less than a full raise doesn't reopen the betting for players who already acted. That's tracked per player as the bet they last acted at, so several short all-ins that add up to a full raise do reopen it. A round only ends when everyone still able to act has acted and matched the highest bet.
- **Side pots** are built from contribution levels of players who haven't folded. Folded chips stay in the pots but can't be won by the folded player, and levels with the same eligible players are merged. The uncalled part of the top bet is returned before the pots are built.
- **Odd chips** go to the winner closest to the left of the button (TDA). The hand checks after every payout that the chip total didn't change, and throws if it did.
- **Timeouts:** auto check, otherwise fold. Two timeouts in a row means the player leaves after the hand, so an AFK player doesn't slow the table down forever.
- **The table message isn't auto-deleted while the table is open.** It's only scheduled for cleanup when the table closes. If someone deletes it anyway, the table closes and refunds like after a restart.
- **The pot display** builds side pots from chips collected on earlier streets only, like at a real table. Showing them from live bets made an uncalled raise look like a side pot.
- **Simplifications** (documented in the README): no dead button, new players are dealt in right away, no antes, straddles or time bank, and all live hands are shown at showdown (no mucking).

### Testing
- `npm test`: 116/116 (52 existing + 64 new). The new tests cover:
  - Hand rankings, kickers, ties, the wheel and the steel wheel, and hands that use 0, 1 or 2 hole cards
  - Deck uniqueness and duplicate-card protection
  - Blinds and turn order (3–5 players and heads-up), the big blind option, minimum bets and raises, short all-ins (single and cumulative), and a raise sending the action around again
  - Fold wins, uncalled bet refunds, side pots including several at once, and split pots with odd chips
  - Timeouts, stale and duplicate clicks, and two tables running at once
  - Settlement and cash-out idempotency, restart recovery (including running it twice), and leaving between and during hands
  - Chip conservation: 2,000 random hands at the engine level and 5,000 random actions at the room level
- An extra simulation ran 200 six-player tables (1,875 hands, 450 with side pots, 59 split pots) through `PokerRoom` with random actions. Wallets plus table stacks matched the starting coins exactly every time.
- A Discord simulation ran the real `/poker` command and `handleComponent` with fake interactions, in both Danish and English: create, join through the modal (including a wrong amount and `1.000`), non-host start, buttons used by the wrong player, a stale double click, a raise modal that's too small and then valid, a turn timeout, showdown, leaving between and during hands, and the table closing. Hole cards never appeared in a public message or custom ID before the showdown, all coins ended up back in the wallets, and the ledger balanced (buy-in 1,900 = cash-out 1,900).
- The bot booted against a database with a table frozen in the middle of a hand. Recovery voided the hand, closed the table and gave both players their full 1,000 back. After that it failed only on the fake token, as expected.
- `npm run check:locales` passes, and every poker locale key used in code, including error codes and hand names, exists in both files. All 12 commands build with `toJSON()`.
- Not tested live against Discord.

## v0.5.0 — Blackjack rebuilt

### What changed
- `/blackjack` is split into `/blackjack solo bet` and `/blackjack create [bet]`. A table holds 1–5 players (was 7); others join with the Join button and their own bet.
- **Insurance:** when the dealer shows an ace, every seat can buy insurance for half their bet before the dealer peeks. It pays 2:1 on a dealer blackjack. No answer within 20 seconds counts as no.
- **Shared shoe:** a table deals from one 6-deck shoe across rounds and reshuffles between rounds once 75 % has been dealt.
- **State machine:** `BlackjackTable` walks `LOBBY → DEALING → (INSURANCE) → PLAYER_TURNS → DEALER_TURN → SETTLEMENT → FINISHED`, and every action checks the phase. `settle()` can only run once per round, on top of `resolveBet` already being idempotent. Joining and betting are one step, since you sit down with your bet.
- The table shows its ID and round number, the dealer's visible value, and Turn/Waiting per hand. Turn timeout is 60 seconds (was 30).

### Testing
- `npm test`: 52/52. New tests cover the phases, insurance (bought, declined, timed out, won and lost), settling only once, and the shoe.
- A simulation ran 2000 solo games and 30 rounds of a full 5-player table through the real command with fake interactions. No bets were left in escrow, clicks out of turn were refused, and late clicks paid nothing.
- Not tested live against Discord.

## v0.4.0 — Blackjack

### What changed
- New game `/blackjack`: against the dealer with Hit, Stand and Double (only on the first decision). Blackjack pays 3:2 (rounded down), and the dealer stands on all 17s.
- New escrow system in `Economy`: `placeBet`, `raiseBet`, `resolveBet` and `refundOpenBets`, backed by the `open_bets` table.

### Why escrow
Coinflip and RPS settle instantly, so there's nothing to cheat with. A blackjack round takes several clicks. If the stake were only taken at the end, a player could see they were losing, `/give` everything to an alt, and the settlement would then fail with "not enough coins", dodging the loss.

The stake is therefore taken when the game starts, and the payout is credited at the end:
- **Bot restart mid-game:** the bet is left in `open_bets` and refunded automatically on the next startup.
- **Double click:** `resolveBet` deletes the bet in the same transaction, so a second resolve is a no-op.

### How it works
- **Pure logic** lives in `src/games/blackjack.js`: deck, Fisher–Yates shuffle with `crypto.randomInt`, hand value with soft aces, dealer play and payout.
- **Blackjack at the deal:** if either side has blackjack, the round ends at once.
- **Auto-end:** a hand ends by itself on 21 or a bust. Double draws one card and stands.
- **AFK:** after 60 seconds without a click the player automatically stands, so no stake is ever stuck.
- **Duplicate clicks:** `finish()` is synchronous up to the payout, and `game.finished` is set before any await. Clicks that arrive late are just acknowledged.

### Testing
- `npm test`: 33/33. New tests cover blackjack logic (deck, soft aces, dealer rule, all payout cases including odd stakes) and escrow (holding the stake, double, no double payout, refund on startup).
- A simulation ran 300 games through the real `/blackjack` command with fake interactions. The outcomes were spread out as expected (bust, win, push, blackjack). The balance in the embed matched the DB every time, no bets were left in escrow, and extra clicks after the end paid nothing.
- `npm run check:locales` passes. All 10 commands build. The bot boots and fails only on the fake token.
- Not tested live against Discord.


## v0.3.0 — Rock, paper, scissors, auto cleanup, private balance

### What changed
- New game `/rps`: against the bot, against a named member, or as an open challenge.
- Public bot messages are deleted automatically after 60 minutes (`MESSAGE_TTL_MINUTES`).
- `/balance` is now ephemeral (only visible to the person using it).
- **Refactor:** the challenge flow (Accept/Decline, open/direct, balance checks, timeout) was moved from `coinflip.js` into `src/utils/challenge.js`, so coinflip and RPS share it. Locale keys moved from `commands.coinflip.*` to `challenge.*`, and the modes moved to `common.modes.*`. Coinflip works exactly as before.

### How it works
- **Cleanup:** after a command, `index.js` checks whether the reply is public. If it is, the message is stored in the `scheduled_deletions` table, and a sweeper runs every minute and deletes due messages.
  - **Stored in the DB instead of `setTimeout`,** so deletions still happen after a restart.
  - **Deleted through the channel API (`client.rest`),** because interaction webhook tokens expire after 15 minutes. A bot can always delete its own messages without Manage Messages.
  - **Deletion failures:** "Unknown Message", missing access and similar errors are dropped right away. Network errors are retried up to 5 times.
- **RPS solo:** the bet must be covered at the start and is settled through `settleSolo` once you pick. A tie moves no coins.
- **RPS duel:**
  - **Secret picks:** after Accept, both players pick on the same message. Picks are only kept in memory, and each player gets an ephemeral confirmation, so nobody can see the other's move.
  - **Status embed:** shows who has picked.
  - **Settlement:** when both have picked, the coins move through `settleDuel`.
  - **Timeout:** if someone doesn't pick within 30 seconds, the game is cancelled with no coins moved (rather than forfeiting someone who might just be AFK).
- **Race condition:** the first pick is acknowledged with `update` (the status) followed by an ephemeral `followUp`. This order means a near-simultaneous second pick can't be overwritten by the status update.

### Testing
- `npm test`: 22/22, with new tests for RPS logic (all 9 combinations) and the cleanup service. The cleanup tests use a fake Discord client and cover the due time, give-up error codes, retry/max attempts and disabling.
- `npm run check:locales` passes. All 9 commands build with `toJSON()`.
- The bot was started with a fake token: all modules load, and it fails only on login as expected.
- Not tested live against Discord.


## v0.2.0 — Open coinflip challenges

### What changed
- `/coinflip` has a new `mode` option: `house` (default) or `open`. In open mode the challenge isn't sent to one person. The first member who clicks Accept plays against the challenger.
- README has a copy-paste command list for Discord in Danish and English.

### How it works
- Open mode reuses the duel flow (`startDuel`) with `opponent = null`. The opponent is whoever clicks Accept.
- An open challenge doesn't ping anyone (`allowedMentions.users = []`).
- If someone without enough coins clicks Accept, they get a private message and the challenge **stays open** for others. Direct challenges also work this way now, instead of failing on the flip.
- The challenger can't accept their own challenge. In open mode only the challenger can press Cancel.
- If both `opponent` and `mode:open` are given, the named opponent wins, since that's the more specific choice.

### Testing
- `npm test` (15/15) and `npm run check:locales` pass. The new `mode` option was validated with `toJSON()`.
- Not tested live against Discord.


## v0.1.0 — Foundation + Coinflip

### What was built
- Coin economy per server: starting balance, `/daily` with streaks, `/work`, `/give`, `/leaderboard`, `/balance` with stats.
- First minigame: `/coinflip`, solo against the house or PvP against another member via an Accept/Decline challenge.
- Danish/English support for all messages and slash command descriptions, configurable per server with `/language`.

### Key design choices
- **discord.js v14 as the only dependency.** SQLite comes from Node's built-in `node:sqlite` and `.env` is loaded with `node --env-file-if-exists`, so there's no `better-sqlite3` (native build) and no `dotenv`.
- **All money goes through `Economy`.** Every method that moves coins runs in a transaction and re-checks balances inside it. The database also has `CHECK (balance >= 0)` as a final safety net.
- **PvP without escrow.** No coins are reserved when a challenge is created. When the opponent clicks Accept, `settleDuel` checks that both players can still afford the bet and moves the coins in one transaction. That way a bot restart can never leave coins stuck "in the air", and spamming challenges with the same coins doesn't work.
- **Double-click protection.** `collector.stop()` runs synchronously before any `await`, so Accept can only settle once.
- **The result is locked in before the animation.** The money moves first, and the "Flipping..." embed is only for show. If editing the message fails, the result still counts.
- **Long cooldowns live in the DB** (daily/work) so they survive restarts. Short anti-spam cooldowns (3s) are in memory.
- **Pure game logic** lives in `src/games/` and is tested without Discord.
- **Randomness** comes from `crypto.randomInt`.
- **Command names stay in English**, while descriptions and choices are localized. This keeps the commands the same across servers.

### Security
- Only the `Guilds` intent, and minimal permissions.
- Bets and amounts are validated server-side, even though Discord also enforces min/max.
- `/language` checks Manage Server at runtime, since default permissions can be overridden.
- Errors are logged on the server; users only see a generic message.
- Server names are escaped with `escapeMarkdown`; users are referenced as mentions (embeds don't ping).

### Testing
- `npm test`: 15 unit tests for economy (daily/streak, transfers, overdraft, solo/duel settlement, per-server isolation), i18n (interpolation, fallback, parity) and coinflip logic.
- `npm run check:locales`: no missing keys or placeholder mismatches.
- All command definitions were built with `toJSON()` (discord.js validates lengths and formats).
- **Not tested yet:** a live run against Discord, since that requires a token.

### Known limitations
- Coinflip has no house edge (a fair 50/50).
- Language is set per server; there's no per-user preference yet.

## Profile sync for the website

- **Problem:** the website showed "Ukendt spiller" for everyone who hadn't used a command since profiles were introduced, because the bot only saved a profile on a command. Avatars also went stale when people changed their picture.
- **Fix:** `src/services/profileSync.js` runs on startup and every 6 hours. It fetches the name and avatar for everyone with a wallet whose profile is missing or older than 24 hours.
  - It uses `guild.members.fetch(id)`, one REST call per member, so it doesn't need the privileged Server Members intent. discord.js handles the rate limit.
  - Someone who has left the server falls back to their global Discord name.
  - `Profiles.needsRefresh()` returns the missing profiles first, then the stale ones, one row per user.
- **Tested:** a new test for `needsRefresh`, and the whole suite passes (149/149).
