# PAC harmonisation check — 2026-11-08 (after v9 migration)

Standing rule (Isaiah): the website, the contract, and the README must all
say the same thing, so a judge can prove it by reading live onchain params
against the site and README. The live contract is the source of truth.

Checked 2026-11-08 ~08:50 WAT, after the v9 migration (schema 8 → 9).
Sources: live `get_params` on `pac-arena.testnet`; local
`contracts/arena/src/lib.rs`; local `README.md`, `skill.md`,
`public/skill.md`, `public/launch.html`; GitHub README at commit
`3d4548d3` (pushed v8).

## Launch economics (the v9 change)

| Parameter | Live onchain | Local contract | Local site / README | GitHub @3d4548d3 |
|---|---|---|---|---|
| Schema version | 9 | 9 (`schema_version: 9`, `new()` + `migrate()`) | Not stated in README/site (no contradiction; only the historical v6 note) | 8 — **MISMATCH, see below** |
| Launch cost | 2 NEAR (`2000000000000000000000000` yocto) | 2 NEAR (`LAUNCH_COST_YOCTO = 2_000_000_000_000_000_000_000_000`) | 2 NEAR (README, skill, public/skill, launch.html) | 2 NEAR |
| Min initial buy | 0.1 NEAR (`100000000000000000000000` yocto) | 0.1 NEAR (`MIN_INITIAL_BUY_YOCTO = 100_000_000_000_000_000_000_000`) | 0.1 NEAR (README, skill, public/skill, launch.html `min="0.1"`) | 0.01 NEAR — **MISMATCH, see below** |
| Max initial buy | 10 NEAR (`10000000000000000000000000` yocto) | 10 NEAR (`MAX_INITIAL_BUY_YOCTO = 10_000_000_000_000_000_000_000_000`, enforced in `launch_coin`) | 10 NEAR (README, skill, public/skill, launch.html `max="10"`) | none stated — **MISMATCH, see below** |
| Cheapest launch total | 2.1 NEAR (0.1 buy + 2 launch cost) | same | same (launch form default 0.5 NEAR buy, inside 0.1–10) | 2.01 NEAR (old numbers) |

Live proof of the new economics: coin 5 "V9 Min Test" (V9MIN) launched on
the live arena by holder-pac.testnet, 0.1 NEAR buy / 2.1 NEAR total, tx
`J5tsnbjTtU1Csb4yiHfT4D4yH4MegqKQdmZ4Tm11es1e` — 99,009 tokens,
qualified_holders 1, reserve 0.099009 NEAR. Test-arena proof before that:
0.09 rejected ("initial buy below minimum"), 10.1 rejected ("initial buy
above maximum"), 10 NEAR launch gave 3,975,247 tokens.

## Other numbers (swept 2026-11-08)

| Parameter | Live onchain | Local contract | Local site / README | Agrees? |
|---|---|---|---|---|
| Trading fee | 1% (`trading_fee_bp: 100`) | 1% (`TRADING_FEE_BP = 100`) | 1% (README, skill: "a 1% trading fee applies to every buy and sell") | Yes |
| Battle min stake | 0.1 NEAR (`100000000000000000000000` yocto) | 0.1 NEAR (`BATTLE_MIN_STAKE_YOCTO`) | 0.1 NEAR (README, skill: "minimum 0.1 NEAR, no maximum") | Yes |
| Coin duel: loser pays | 5% of treasury (`coin_duel_treasury_bp: 500`) | 5% | 5% (README, index, competition page, app.js) | Yes |
| Coin duel min volume | 0.1 NEAR (`100000000000000000000000` yocto) | 0.1 NEAR (`COIN_DUEL_MIN_VOLUME_YOCTO`) | Not stated numerically in docs/site — no contradiction | Yes |
| Coin duel pair cap | 1 NEAR (`1000000000000000000000000` yocto) | 1 NEAR (`COIN_DUEL_PAIR_CAP_YOCTO`) | Not stated numerically in docs/site — no contradiction | Yes |
| Qualified holder threshold | 10,000 tokens (`min_qualified_holding_tokens: "10000"`) | 10,000 (`MIN_QUALIFIED_HOLDING_TOKENS = 10_000`) | 10,000 (README, skill) | Yes |
| Total supply per coin | 1,000,000,000 (`total_supply_tokens: "1000000000"`) | 1,000,000,000 (`TOTAL_SUPPLY_TOKENS`) | 1,000,000,000 (README, skill) | Yes |
| Reputation weights | 30 / 20 / 15 / 15 / 20 | 30 / 20 / 15 / 15 / 20 | 30% / 20% / 15% / 15% / 20% (README, strategy simulator) | Yes |
| Meme judging grace | 1 hour (`meme_judging_grace_ns: 3600000000000`) | 1 hour | 1 hour (README, per v8 params check) | Yes |

Notes on the sweep:
- The remaining "0.01 NEAR" mentions in `skill.md` / `public/skill.md`
  are the copy-trading per-trade minimum and the meme reward, not the
  launch minimum — they match the live contract and were left alone.
- The `0.5 NEAR` (`"initial_buy_yocto": "500000000000000000000000"`)
  values in `skill.md` / `public/skill.md` are example payloads only
  (a U128 format example and a sample launch call), not stated rules —
  0.5 NEAR is inside the live 0.1–10 range, so they are valid and were
  left alone.
- `public/launch.html` input is `min="0.1" max="10"` with default 0.5
  NEAR, inside the live range.
- No `upgrade_token_contract` code exists anywhere in the local contract
  or scripts (0 occurrences) — the impossible token upgrade is not in
  the codebase.
- No audit mention was added to the README, skill, or site.

## Remaining mismatch (one, explicit)

**GitHub is behind the live contract.** Commit `3d4548d3` (pushed v8)
still says schema 8, minimum initial buy 0.01 NEAR, and no maximum.
The live arena is schema 9 with min 0.1 / max 10. A GitHub push of the
v9 workspace was NOT approved in this run, so this mismatch is
intentional and recorded here, not hidden. Until that push happens, a
judge reading GitHub alone will see the old numbers; a judge reading the
live contract, the local site/README, or the live site after deploy will
see the new ones.

## Verdict

Live contract, local contract, local site, and local README are
harmonised on every number checked. The single open item is the GitHub
push (not approved). Do not claim full harmonisation until that push is
done and this table is re-checked against the new GitHub head.
