# PAC v8 migration — live record (2026-11-08, testnet)

**Result: SUCCESS. pac-arena.testnet is v8, all live state intact. No GitHub push.**

## Before / after
- Schema: 7 → 8. Live state at snapshot (06:36 UTC): 4 coins, 5 agents, 157 trades, 11 battles, prize pool 0.15664322 NEAR, scores degen 371 / holder 691 / sniper 429 / isaiah-pac 350 / clearsite 425. Snapshot: `migration-v8-snapshot.json`.
- After migration: all views byte-identical to the snapshot except the new `judging_complete` field on meme days (true for coins 0 and 1; coins 2 and 3 have no meme day, null on both sides).

## Builds (fresh, from current source)
- Token WASM: `cargo near build non-reproducible-wasm` in contracts/token → 198,066 bytes, SHA-256 b3253c383db3a8e4c411a2aee6e591f25c8893f9849de3788cc54b1d20bf9739, copied to contracts/arena/token.wasm.
- Arena WASM: 774,856 bytes, SHA-256 c84e09a2bdfad676d82ffd14db88f17714fe754b46cc7d762b295791f8c68d96, at target/near/pac_arena/pac_arena.wasm.
- Tests before deploy: arena 80 passed / 0 failed; token 0 tests (none exist).

## Transactions
- Judge key created onchain (function-call key, `record_ai_score` only, 0.5 NEAR allowance, public key ed25519:7cg3JZTByjHo5unQsBxJXtdcBP3jsm81LEKnKYX8JJn7). File `.testnet-judge-key.json`, chmod 600, gitignored. Full-access arena key untouched.
- Migrate tx: **DWNZ8mSVqUJAGHze1X3HRkQpXHRvJjRfVBaGo9bKL5wY** (deploy + migrate).
- Second migrate correctly rejected (receipt 4RGRbMjrwMaLJEtGgFBuegb7ut9eAW8fZfqENVnGFxYV; it panics deserialising v8 state as v7 — expected, it fails as required).
- Migration script bug found and fixed: `scripts/migrate-live-arena-v8.mjs` crashed destructuring a null meme day (coins 2/3 have none). The migration itself had already succeeded; verification was completed by `scripts/verify-v8-post-migration.mjs` (all views + all v8 params + second-migrate rejection).

## Live checks (all passed)
- **H-01 sole-buyer round-trip (the key fix):** new test coin 4 "V8 Test Coin" (V8T) launched by holder (2 NEAR launch + 0.01 initial buy; launch tx hash was not captured in the script output — coin 4 exists onchain with holder as creator, sold 9,900, reserve 0.0099 = full cost). Degen registered on c4, bought 49,504 V8T for 0.05 NEAR (buy tx HZ63qX51TCETMxjG8M5e2cyetgdpKMyVjd9LVq9YKQch), sold ALL back (sell tx 6WVPeSUvzruqJSFPkjMcsJaCEUGZ8avmvCy7Gbndwsff), balance 0, sold/reserve back to 9,900 / 0.0099. Under v7 this sell reverted.
- New coin 4 runs the NEW token WASM (code hash differs from coin 0's old token) — transfer sync live for new coins.
- **Duels:** create (0,1) correctly rejected ("an active duel already exists"); create (0,2) by degen succeeded — duel 10, tx AtQC4jQwPQRQi5bvXNP5zHDGsTZ9HBGf5EK4myz39eYs, ends 2026-11-09 ~06:40 UTC. Pre-existing duels 0–9 (all 0-vs-1) are grandfathered and still active.
- Early resolve attempts correctly rejected: duel 0 ("duel window not over", window ends 13:53 UTC 2026-11-08), meme day 0 coin 0 ("day not over yet", day ends 13:45 UTC 2026-11-08).
- **Season 2965:** ends 2026-11-09 00:00 UTC — NOT due, no resolve attempted.
- **Battle 10:** unchanged — pending, isaiah-pac.testnet vs sniper-pac.testnet, stake 0.1 NEAR, start_ns 0.
- **Judge key:** service runs with it (dry-run and real runs for coins 0/1: nothing new to score — coin 0 submissions have no text, coin 1's only text submission already scored 225). A call with the judge key to `register_agent` is rejected: "Transaction method name register_agent isn't allowed by the access key". No new AI score was recorded because there was no unscored text submission.

## Two failed transactions during checks (no state change, test-script errors — not contract bugs)
- 3TmHrcZkJjgG6BytoY9PELA773nL18DsL7FdS3X1pyo9 (holder sell, amount "0"): holder's initial-buy tokens are LOCKED for 24h, so holder's transferable balance was 0.
- H6otZcR53qxQ97EuamDtd2fNWXPvy32DnxfMGKtMt9au (degen sell, amount "0"): degen had not storage_deposited on c4, so the buy's token transfer failed and on_buy refunded the 0.05 NEAR. Fixed by registering degen first; the round-trip then passed.

## Remaining / not done
- Meme day 0 (coins 0/1) becomes resolvable ~13:45 UTC 2026-11-08; duels 0–9 become resolvable from 13:53 UTC; season 2965 resolves after 2026-11-09 00:00 UTC. The 15:05 WAT resolutions cron may cover the meme/duel ones.
- Holder's 9,900 locked V8T unlock 2026-11-09 ~06:38 UTC; claimable via claim_locked.
- Existing coins 0–3 still run the OLD token WASM — in-place token upgrade is a separate approved step, NOT done.
- No GitHub push (approval covered testnet deploy/migration only).
- Duel 10 (0 vs 2) is live until 2026-11-09 ~06:40 UTC; resolves under the new min-volume (0.1 NEAR gain) and pair-cap rules.
