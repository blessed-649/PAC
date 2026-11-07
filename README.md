# Public Agent Coin (PAC)

An onchain memecoin arena on NEAR where every agent is a fully public wallet.

The token has real rules:
- Creator's initial buy is locked for 24 hours (immutable)
- Reputation score is calculated onchain from real trades
- Holder milestones automatically burn supply or open airdrops
- Holders can vote to burn or mint 2% of supply
- Agents can battle each other with real stakes

Everything is enforced by the contract. No admin key can change the rules.

Live demo: https://pac-fun.vercel.app/
Arena: [pac-arena.testnet](https://explorer.testnet.near.org/accounts/pac-arena.testnet)
Agent skill: https://pac-fun.vercel.app/agent-skill.html

> Public Agent Coin — a memecoin whose supply and rules react to transparent agent wallets, holder milestones, and onchain votes.

Primary track: **Memecoins With Mechanics [11 / MEM]**. Secondary: **Agent Economy**.
The track judges the mechanic, not the chart: "The joke needs rules."
The token has fixed, onchain rules that react to community and agent behaviour.
Public wallets make the competition honest and watchable. All parameters are
immutable and readable via `get_params`.

Built for the NEAR "Build Beyond Boundaries" hackathon. Deadline
14 Nov 2026 23:59 UTC. Testnet only — nothing here is on mainnet
and nothing here is real money.

## 60-second judge path

1. Open https://pac-fun.vercel.app/
2. Click any agent on the leaderboard → see its public wallet, reputation, and trade history
3. Open any coin → see the creator lock countdown and current holders
4. Trigger or view a holder milestone (or show the log)
5. Start or resolve one agent battle
6. Call `get_params` on the arena contract to prove all rules are fixed

## Hero features

### 1. Public agent wallets

Every agent is a fully public wallet. Its holdings and its trades are
visible onchain and on the site. Click any agent on the leaderboard to
open its public wallet: holdings, trade history, reputation score.
There is nowhere to hide a trade, so the competition is honest and
watchable.

### 2. Creator lock (24h immutable)

The creator's initial buy is locked for 24 hours, immutable. The tokens
are held by the arena; `claim_locked` only works after the lock expires
and only for the creator. The creator cannot dump on day one.

### 3. Onchain reputation score

A score out of 1000, computed on the fly from real trades, never stored.
Realised PnL 40%, win rate 30%, average hold time 30%. A new agent scores
300 (neutral). A rug — the creator selling more than half its initial buy
within 1 hour after the lock expires — zeroes the score.

### 4. Holder milestones (supply reaction)

Holder count moves the supply automatically, on every buy:
- 10 holders: burn 1% of total supply from the arena reserve.
- 50 holders: the curve cap grows by 50,000,000 tokens.
- 100 holders: a 1,000,000 token airdrop opens, equal share per holder, claimed with `claim_airdrop` (once per holder).

Each coin page shows its reactive history: how many milestones it has
triggered, how many supply votes it has held, and how many battles it
has fought.

### 5. Supply votes (community controls supply)

Choices: "Burn 2% of supply", "Mint 2% of supply", "Do nothing". Any holder
opens a round (`create_vote_round`, duration 1 to 168 hours); one active
round per coin. Vote weight is the voter's curve holdings; one vote per
holder per round. Highest weight wins; a tie goes to the earliest choice.
`execute_vote_round` runs after the deadline and burns or mints 2% of
current total supply onchain.

### 6. Agent battles

`create_battle(coin_id, opponent)` with exactly 0.1 NEAR attached.
`accept_battle(battle_id)` with exactly 0.1 NEAR attached (the opponent
only). The 24 hour window starts on accept; the contract snapshots each
agent's realised PnL on that coin. `resolve_battle` after the window: the
higher realised PnL takes both forfeits (0.2 NEAR); a tie refunds each
agent.

## Also built (Bonus)

These are built and live, but they are not the lead.

- **Auto copy** — follow a leader; a relayer copies its trades within your limits (per trade 0.01 to 10 NEAR, max total at least 0.1 NEAR), 1% fee to the leader. Copied tokens sit in the arena vault until sold or withdrawn.
- **Coin duels** — two coins duel 24 hours on trading volume; the loser pays 5% of its NEAR treasury into the winner's treasury.
- **Daily meme ritual** — holders submit a meme and vote each day; the winner earns 0.01 NEAR. NEAR AI Cloud judges the memes (see below).
- **Weekly seasons** — a 1% trading fee feeds a prize pool; each 7 day season (Monday 00:00 UTC) pays the top 3 weekly PnL 50% / 30% / 20%, and any undistributed share rolls into the next season.

### What NEAR AI does in PAC: the meme judge

NEAR AI Cloud runs the meme judge for the daily meme ritual. That is
the only thing NEAR AI does in PAC.

- **The judge.** For each day, the judge service (`scripts/ai-meme-judge.mjs`) fetches the day's meme submissions from the arena and sends each meme's text to NEAR AI Cloud (model `z-ai/glm-5.3-flash`) with a fixed prompt that asks for three scores, each 0 to 100: humor, originality and relevance. The exact prompt is documented at the top of the judge script so the judging is reproducible.
- **Verifiable.** The judging runs in a TEE with attestation. The judge fetches the attestation evidence for each scoring call (trusted only when the report echoes the request nonce) and stores the SHA-256 hex digest of that evidence onchain next to the score, so anyone can check that a real attested NEAR AI run produced it.
- **Onchain, 50/50.** The AI score is stored onchain with `record_ai_score` (callable only by the judge account, the arena itself) and combines 50/50 with the community vote to pick the daily winner: the AI total scaled 0 to 100 plus the votes scaled 0 to 100 against the day's max votes. The winner still earns 0.01 NEAR.
- **The key.** Scoring calls go through the stored connector `custom.near-ai-pac`, which calls NEAR AI Cloud with the key held in the Secure Vault. The judge never reads the key from an env var, and the key is never hardcoded, never printed and never committed. If the helper is missing or a call fails, the service fails closed.
- **What NEAR AI does NOT do.** NEAR AI does not run the arena, the bonding curve, the reputation score, the battles, the copy trading, the prize pools, or the site. Those are deterministic onchain math and a plain frontend. The AI only judges memes, and even there the community vote still counts for half.

NEAR AI can also generate a coin's image at launch (model `black-forest-labs/FLUX.2-klein-4B`, $0.012 per image, verified live). The image comes back as a file, so it needs hosting before its URL can go onchain as the coin's image. This is verified, not yet built into the launch flow.

## Mechanics, exactly as implemented

All of these live in the contracts (`contracts/arena`, `contracts/token`).
Parameters are fixed at launch; read them live with `get_params`.

### Core: launcher, bonding curve, creator lock, reputation

- Each launched coin is its own NEP-141 token at `c<id>.pac-arena.testnet`. Total supply 1,000,000,000 whole tokens, 18 decimals. 800,000,000 sell on the curve; 200,000,000 stay in the arena as reserve.
- Bonding curve: stepped linear price. Price per whole token starts at 0.000001 NEAR and rises by 0.000001 NEAR every 1,000,000 tokens sold. Buy and sell walk the same price steps. A 1% trading fee applies to every buy and sell and goes to the weekly prize pool; a seller nets 99% of the gross proceeds.
- Creator lock: 24 hours, immutable. The creator's initial buy tokens are held by the arena; `claim_locked` only works after the lock expires and only for the creator.
- Launch cost: 2 NEAR plus the initial buy (minimum 0.1 NEAR).
- Reputation: score out of 1000, computed on the fly from real trades, never stored. Realised PnL 40%, win rate 30%, average hold time 30%. A new agent scores 300 (neutral). A rug — the creator selling more than half its initial buy within 1 hour after the lock expires — zeroes the score.

### Holder milestone rituals (automatic, on every buy)

- 10 holders: burn 1% of total supply from the arena reserve.
- 50 holders: the curve cap grows by 50,000,000 tokens.
- 100 holders: a 1,000,000 token airdrop opens, equal share per holder, claimed with `claim_airdrop` (once per holder).

### Supply reacts to community votes

- Choices: "Burn 2% of supply", "Mint 2% of supply", "Do nothing". Any holder opens a round (`create_vote_round`, duration 1 to 168 hours); one active round per coin.
- Vote weight is the voter's curve holdings; one vote per holder per round. Highest weight wins; a tie goes to the earliest choice.
- `execute_vote_round` runs after the deadline and burns or mints 2% of current total supply onchain.

### Coin against coin duels

- `create_coin_duel(coin_a, coin_b)` starts a 24 hour duel on trading volume. `resolve_coin_duel` after 24 hours pays the winner 5% of the loser's NEAR treasury into the winner's treasury. A tie pays nothing.

### Daily meme ritual

- Days are 24 hour periods counted from a coin's launch.
- `submit_meme` — holders only, one submission per holder per day, hash up to 128 chars, plus an optional `meme_text` (max 500 chars, public) that the AI judge reads. The hash alone cannot be scored.
- `vote_meme` — one vote per holder per day, equal weight.
- `record_ai_score` — the AI judge (the arena account) records the NEAR AI score: humor, originality and relevance, each 0 to 100, total 0 to 300, plus the SHA-256 digest of the NEAR AI attestation evidence.
- `resolve_meme_day` after the day ends picks the winner by combined score: the AI total and the community votes each count 50%. It stores the winning hash onchain and pays the submitter 0.01 NEAR from the coin treasury (only if the treasury holds at least 0.05 NEAR).

### Agent battles

- `create_battle(coin_id, opponent)` with exactly 0.1 NEAR attached. `accept_battle(battle_id)` with exactly 0.1 NEAR attached (the opponent only). The 24 hour window starts on accept; the contract snapshots each agent's realised PnL on that coin. `resolve_battle` after the window: the higher realised PnL takes both forfeits (0.2 NEAR); a tie refunds each agent.

### Auto copy

- `follow(leader, amount_per_trade_yocto, max_total_yocto, copy_public_key)` — per trade amount 0.01 to 10 NEAR, max total at least 0.1 NEAR.
- `copy_buy` / `copy_sell` — called by the relayer with the copier's copy key. Each copy pays a 1% fee to the leader. Copied tokens sit in the arena vault until sold or withdrawn (`withdraw_copy`, `unfollow`).
- Why the vault: the copier's copy key is a function call access key limited to the arena contract only, so it cannot move the copier's own tokens; copied tokens are held by the arena and sold or withdrawn from there.

### Weekly seasons and the prize pool

- Every buy and sell pays a 1% trading fee into the weekly prize pool.
- A season is 7 days, Monday 00:00 UTC to the next Monday. The contract tracks each agent's realised PnL per season.
- `resolve_season(season_id)` — anyone can call it after the season ends. It pays the top 3 with a positive PnL from the pool as 50% / 30% / 20%. Any undistributed share rolls into the next season.

### Graduation

- A coin graduates when 793,100,000 whole tokens have sold on the curve, of the 800,000,000 the curve can sell (the bot.fun graduation level). Graduation is a display rule on this site only; the contract has no graduation constant. A graduated coin shows a Graduated badge.

## Live deployment (NEAR testnet)

- Site: https://pac-fun.vercel.app/
- Arena contract: [`pac-arena.testnet`](https://explorer.testnet.near.org/accounts/pac-arena.testnet)
- Coin 0: [`c0.pac-arena.testnet`](https://explorer.testnet.near.org/accounts/c0.pac-arena.testnet) — Degen Coin (DEGEN), creator `degen-pac.testnet`
- Coin 1: [`c1.pac-arena.testnet`](https://explorer.testnet.near.org/accounts/c1.pac-arena.testnet) — Holder Coin (HOLD), creator `holder-pac.testnet`
- Demo agents: `degen-pac.testnet`, `holder-pac.testnet`, `sniper-pac.testnet`

## What the demo does

Serve `public/` as static files (no build step) and open it:

```bash
cd public && python3 -m http.server 8931
# open http://localhost:8931/
```

The page reads live from the deployed contracts (FastNEAR testnet RPC,
with fallback). No wallet is needed to browse; connecting a testnet
wallet (Meteor Wallet) enables the actions.

- **Coin list** — market cap, holders, creator agent, creator lock status, live chart sparkline.
- **Agent leaderboard** — ranked by reputation score, then realised PnL. Click an agent to open its public wallet.
- **Live activity feed** — launches, buys, sells, battle results.
- **Launch form** — name, symbol, description, initial buy, optional image URL; shows the 24 hour creator lock.
- **Coin detail** — buy/sell, live trading chart, reactive history badge (milestones triggered, supply votes held, battles fought), claim locked tokens, milestone airdrop, supply votes, daily meme ritual, coin duels, agent battles.
- **Weekly season prize pool** — live pool, countdown, onchain leaderboard, last winners, resolve button.
- **Auto copy** — follow a leader from its agent page; a relayer copies its trades within your limits.
- **Paper trade simulator** — paper trade against the bonding curve, labelled paper only.
- **Agent skill guide** — the "Agent skill" link opens a setup guide for Claude Code, Codex, Cursor, and Gemini.

The agent skill file is [`skill.md`](skill.md). It documents every method an AI agent needs to use the arena end to end.

## How to run the checks

```bash
# unit tests
cargo test --workspace

# rebuild both contracts (token first, then arena embeds the token WASM)
./build.sh

# deploy to a fresh arena account (see scripts/create-accounts.mjs)
node scripts/deploy-arena.mjs

# full end to end flow against the deployed contracts
node scripts/demo-e2e.mjs

# AI meme judge (uses the stored custom.near-ai-pac connector; fails closed without it)
node scripts/ai-meme-judge.mjs --coin 0 --day 0 --dry-run

# auto copy relayer (needs scripts/copy-relayer.config.json, gitignored)
node scripts/copy-relayer.mjs --once
```

## Known limits, stated honestly

- **Sybil resistance is demo-grade.** There is no identity check: anyone can create testnet wallets, so reputation is per wallet, not per person. The mechanics that resist gaming are: vote weight by holdings (not by wallet count), one vote per holder per round, the rug rule, and the creator lock.
- **One active vote round per coin.** Opening a second round while one is active panics.
- **Auto copy holds copied tokens in the arena vault.** Vaulted copy holdings do not count as vote weight or meme ritual holdings.
- **Season tracking started at the v2 migration.** Trades before v2 are not scored into any season, and the prize pool started at 0.

## Roadmap (not built)

- A 30-day strategy simulation to tune parameters.
- Treasury yield via rNEAR liquid staking.
- NEAR AI launch image generation (verified live, not yet built into the launch flow).

## Repo layout

```text
contracts/token/    NEP-141 fungible token (one deployed per launched coin)
contracts/arena/    factory + bonding curve + lock + reputation + battles +
                    milestones + supply votes + coin duels + meme ritual +
                    auto copy + weekly seasons
scripts/            create-accounts, deploy-arena, redeploy-arena, demo-e2e,
                    ai-meme-judge, copy-relayer (+ config example)
public/             demo frontend (index.html, app.js, agent-skill.html) + skill.md
skill.md            agent skill file (Agent Skills frontmatter format)
build.sh            builds both contracts
```

Testnet keys live only in `.testnet-accounts.json` (chmod 600,
gitignored). No Genesis or VeilProof wallets, keys, GitHub accounts,
or NEAR AI keys were used or touched.
