# PAC v9 launch economics — live record (2026-11-08, testnet)

**Result: SUCCESS (option 1). pac-arena.testnet is v9, all live state intact. No GitHub push.**

## What changed (option 1, decided by Isaiah)
- Launch cost: **stays 2 NEAR**.
- Minimum initial buy: **0.01 → 0.1 NEAR**.
- Maximum initial buy: **new, 10 NEAR**, enforced in `launch_coin`.
- Cheapest launch is now 2.1 NEAR total; most expensive 12 NEAR total.
- No `upgrade_token_contract` code anywhere in this v9 (0 occurrences) — the
  token-upgrade route was proven impossible separately and is not part of v9.

## Earlier attempt — STOPPED (kept for the record)
A 0.5 NEAR launch cost was proven impossible on test arena
`pac-v9l-1b9099.testnet`: the 198,066-byte token WASM needs ~1.98 NEAR of
storage, so a 0.5 NEAR launch fails creating the token account, shortfall
1.48385 NEAR. That v9 (launch cost 0.5) was never deployed and its docs
were reverted. The min 0.1 / max 10 validation from that run was proven
working (0.09 and 10.1 rejected) and carried into this option-1 v9.

## Before / after
- Schema: 8 → 9. Live state at snapshot: 5 coins, 5 agents, 161 trades,
  11 battles, prize pool 0.1577323 NEAR, scores degen 373 / holder 691 /
  sniper 429 / clearsite 425. Snapshot: `migration-v9-params-snapshot.json`.
- After migration: all views byte-identical to the snapshot (stats, coins
  0–4, all 5 agents, battles, votes, duels, meme days, pool, season,
  leaderboard, activity).

## Builds (fresh, from current source)
- Token WASM: rebuilt with `cargo near build`, 198,066 bytes, SHA-256
  `b3253c38…` (unchanged from v8 — token source did not change).
- Arena WASM: 767,052 bytes, SHA-256
  `72b549b4b5a70744e5194bd7ec2118232af952adc640cf6a5716679c91f6c125`,
  at `target/near/pac_arena/pac_arena.wasm`.
- Tests before deploy: arena **83 passed, 0 failed** (80 v8 + 3 new v9:
  launch-economics constants, min buy qualifies creator, max-buy bounds,
  plus the v8→v9 migrate test replacing the v7→v8 one); token 0 tests
  (none exist).

## Test-arena proof (fresh arena pac-v9l-a505fa.testnet)
- Schema 9, launch cost 2 NEAR, min 0.1, max 10 — params OK.
- (a) Minimum launch, 0.1 NEAR buy / 2.1 attached: SUCCEEDED, 99,009
  tokens, creator qualified, tx
  `26EAcZZQj12uhC1WZ4wtND1wTb4hXn9LtJhnfZKouHVg`. Token code hash matches
  the new token WASM; token account balance 2 NEAR.
- (b) Maximum launch, 10 NEAR buy / 12 attached: SUCCEEDED, 3,975,247
  tokens, tx `837LEJ7W54WQPiDmhNetXJTmQgWFtUeUPd88WFmPZcA9`.
- (c) 0.09 NEAR buy: REJECTED with "initial buy below minimum".
- (d) 10.1 NEAR buy: REJECTED with "initial buy above maximum".
- No coin was created by either failed launch. Test keys only in
  `/tmp/pac-v9launch-accounts.json` (chmod 600).
- Scripts: `scripts/test-v9-launch-params.mjs`,
  `scripts/test-v9-launch-rejects.mjs` (adapted from the stopped 0.5-NEAR
  run to the 2 NEAR launch cost).

## Transactions
- Migrate tx: **DEnoQRfX34QbtXVEyComXj97LeXV4MRacnNn3zBZfgbj**
  (deploy + migrate).
- Second migrate correctly rejected (receipt
  `B3faPVvMjMkQPMPu4a3RiV22pLc8tFVkzKrvaEUt7Rfj` — panics asserting
  schema 8, live state is 9, as required).
- Live minimum launch: coin 5 "V9 Min Test" (V9MIN) launched by
  holder-pac.testnet, 0.1 NEAR buy / 2.1 NEAR total, tx
  **J5tsnbjTtU1Csb4yiHfT4D4yH4MegqKQdmZ4Tm11es1e** — 99,009 tokens,
  qualified_holders 1, reserve 0.099009 NEAR.

## Docs and site (harmonised with the live contract)
- `README.md`, `skill.md`, `public/skill.md`, `public/launch.html` all say:
  launch cost 2 NEAR, initial buy 0.1–10 NEAR. Launch form input now has
  `min="0.1" max="10"` (default 0.5 NEAR, inside the range). No audit
  mention added anywhere.
- Full harmonisation table: `harmonisation-check.md`.

## Remaining / not done
- **GitHub push NOT done** (not approved in this run). GitHub still shows
  the old numbers (minimum 0.01 NEAR, no maximum) at commit 3d4548d3 —
  that is the one remaining harmonisation mismatch; a push is a separate
  step.
- Coins 0–3 still run the old token WASM (in-place upgrade impossible;
  Isaiah decided to leave them). New coins (4, 5, …) run the new token
  with transfer sync.
- Coin 5's 99,009 locked tokens unlock 2026-11-09 ~08:50 UTC, claimable
  via `claim_locked` by holder-pac.testnet.
