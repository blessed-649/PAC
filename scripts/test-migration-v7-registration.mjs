// PAC v7 migration proof WITH agent registration (v6 -> v7).
// The first v7 test (test-migration-v7.mjs) already migrated the main
// test arena to v7 (agents-decide stake, no registration). This script
// proves the FULL v7 change — agents-decide stake PLUS agent
// registration (the new registered_agents collection appended after
// schema_version) — on a FRESH arena, because the registration adds a
// state-layout change the first script did not cover.
// It builds a fresh v6 arena from the EXACT live v6 WASM (fetched via
// view_code from pac-arena.testnet, sha ad97f691...), creates minimal
// v6 state (1 coin, an agent with a score, a pending battle at the
// fixed 0.1 NEAR forfeit, prize-pool fee accrual), then deploys the
// NEW (v7) WASM, calls migrate(), and verifies:
//   - every piece of v6 state survives EXACTLY (coins, agent scores,
//     the old battle with its 0.1 NEAR stake, pool, activity)
//   - existing agents read is_agent=false (never registered)
//   - get_params reports schema_version 7, battle_min_stake_yocto
//     0.1 NEAR, agent_registration_enabled true, and
//     battle_forfeit_yocto is GONE
//   - a second migrate() is REJECTED (one-shot) and new() is rejected
//   - register_agent works live: marks the caller, is idempotent,
//     cannot register another account, get_agent returns the flag
//   - new battles use the agents-decide model (below-minimum rejected,
//     0.1 NEAR minimum works, cancel refunds)
// Only after this prints MIGRATION TEST OK may the live arena
// pac-arena.testnet be migrated the same way.
// The fresh arena is a sub-account of the main test arena, and the two
// traders are the existing v6 test traders, so no helper call is made.
// Keys for the new arena are written ONLY to
// /tmp/pac-migration-v7-reg-accounts.json (chmod 600).
// Run: node scripts/test-migration-v7-registration.mjs
import fs from 'node:fs';
import BN from 'bn.js';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';

const V6_ACCOUNTS = '/tmp/pac-migration-v4-accounts.json';
const V6_WASM = '/tmp/pac-v6-live.wasm';
const NEW_WASM = new URL('../target/near/pac_arena/pac_arena.wasm', import.meta.url);
const RPC = 'https://rpc.testnet.fastnear.com';
const OUT = '/tmp/pac-migration-v7-reg-accounts.json';
const parseNear = (n) => utils.format.parseNearAmount(n);

const v6 = JSON.parse(fs.readFileSync(V6_ACCOUNTS, 'utf8'));
const ids = Object.keys(v6);
const ARENA_ID = ids[0];
const TRADER_A = ids[1];
const TRADER_B = ids[2];
const NEW_ARENA_ID = `v7reg.${ARENA_ID}`;

const keyStore = new keyStores.InMemoryKeyStore();
for (const id of ids) await keyStore.setKey('testnet', id, KeyPair.fromString(v6[id].privateKey));
if (fs.existsSync(OUT)) {
  const reg = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  for (const id of Object.keys(reg)) await keyStore.setKey('testnet', id, KeyPair.fromString(reg[id].privateKey));
}
const near = await connect({
  networkId: 'testnet', nodeUrl: RPC,
  walletUrl: 'https://testnet.mynearwallet.com/',
  helperUrl: 'https://helper.testnet.near.org', keyStore,
});
const acct = (id) => near.account(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, label) {
  let delay = 2000;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try { return await fn(); } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      const retryable = msg.includes('429') || msg.includes('503') || msg.includes('502') || msg.includes('ECONNRESET') || msg.includes('timeout');
      if (!retryable || attempt === 6) throw e;
      console.log(`  [retry ${attempt}/6] ${label} after ${delay}ms`);
      await sleep(delay); delay *= 2;
    }
  }
}
async function view(arenaId, method, args = {}) {
  const a = await near.account(arenaId);
  return withRetry(() => a.viewFunction({ contractId: arenaId, methodName: method, args }), `view ${method}`);
}
async function call(fromId, contractId, method, args, deposit = '0', gas = 100_000_000_000_000n) {
  const a = await acct(fromId);
  return withRetry(() => a.functionCall({
    contractId, methodName: method, args, gas, attachedDeposit: BigInt(parseNear(deposit)),
  }), `call ${method}`);
}
async function expectFail(promise, label) {
  try {
    await promise;
    throw new Error(`expected failure but succeeded: ${label}`);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (msg.includes('expected failure but succeeded')) throw e;
    console.log(`  [ok] correctly rejected: ${label} -> ${msg.slice(0, 120)}`);
  }
}

console.log('== 0. create the fresh arena sub-account and deploy the live v6 WASM (skipped if it already exists and is v6)');
let freshArenaReady = false;
try {
  const existing = await view(NEW_ARENA_ID, 'get_params', {});
  if (existing.schema_version === 6 && existing.battle_forfeit_yocto === '100000000000000000000000') {
    console.log('  fresh arena', NEW_ARENA_ID, 'already exists and is v6 — reusing it');
    freshArenaReady = true;
  }
} catch (e) {
  // No state yet; create it below.
}
if (!freshArenaReady) {
  const newKeyPair = KeyPair.fromRandom('ed25519');
  await keyStore.setKey('testnet', NEW_ARENA_ID, newKeyPair);
  console.log('  creating', NEW_ARENA_ID, 'funded with 8.5 NEAR from', ARENA_ID, '...');
  await withRetry(() => acct(ARENA_ID).then((a) => a.createAccount(
    NEW_ARENA_ID, newKeyPair.getPublicKey(), new BN(parseNear('8.5')),
  )), 'create fresh arena sub-account');
  fs.writeFileSync(OUT, JSON.stringify({ [NEW_ARENA_ID]: { privateKey: newKeyPair.toString() } }, null, 2), { mode: 0o600 });
  console.log('  fresh arena account created; key written to', OUT);
  const v6Wasm = fs.readFileSync(V6_WASM);
  console.log('  v6 wasm bytes:', v6Wasm.length);
  await withRetry(() => acct(NEW_ARENA_ID).then((a) => a.deployContract(v6Wasm)), 'deploy v6');
  console.log('  v6 WASM deployed to', NEW_ARENA_ID);
  await call(NEW_ARENA_ID, NEW_ARENA_ID, 'new', {}, '0', 100_000_000_000_000n);
  console.log('  new() initialised the v6 state');
}

const v6params = await view(NEW_ARENA_ID, 'get_params', {});
if (v6params.schema_version !== 6) throw new Error(`fresh arena schema_version is ${v6params.schema_version}, expected 6`);
if (v6params.battle_forfeit_yocto !== '100000000000000000000000') throw new Error('fresh arena battle_forfeit_yocto is not 0.1 NEAR');
if ('battle_min_stake_yocto' in v6params) throw new Error('fresh arena already has battle_min_stake_yocto — not v6?!');
if ('agent_registration_enabled' in v6params) throw new Error('fresh arena already has agent_registration_enabled — not v6?!');
console.log('  fresh arena', NEW_ARENA_ID, 'is v6 (schema 6, fixed 0.1 NEAR forfeit, no registration)');

console.log('\n== 1. build minimal v6 state: launch a coin, buy, create a battle');
console.log('  trader B launches coin 0 (2.5 NEAR: 2 launch + 0.5 initial buy) ...');
await call(TRADER_B, NEW_ARENA_ID, 'launch_coin', {
  name: 'RegTest', symbol: 'RGT', description: 'v7 registration migration test coin',
  initial_buy_yocto: parseNear('0.5'), image_url: null,
}, '2.5', 300_000_000_000_000n); // launch deploys a token sub-account; needs the 300 Tgas max
await sleep(3000);
let coin0 = await view(NEW_ARENA_ID, 'get_coin', { coin_id: 0 });
console.log('  coin 0:', coin0.name, coin0.symbol, '| sold', coin0.sold_tokens, '| holders', coin0.holders);
if (!coin0) throw new Error('coin 0 did not launch');
// A buyer must hold FT storage on the coin's token contract before
// the arena can transfer tokens to them (storage_deposit 0.00125 NEAR).
console.log('  registering trader B on the coin 0 FT contract (storage_deposit 0.00125 NEAR) ...');
await call(TRADER_B, coin0.token_id, 'storage_deposit', { account_id: TRADER_B }, '0.00125');
await sleep(2000);
console.log('  trader B buys 0.1 NEAR on coin 0 ...');
await call(TRADER_B, NEW_ARENA_ID, 'buy', { coin_id: 0 }, '0.1');
await sleep(2000);
console.log('  trader B challenges trader A on coin 0 with the v6 fixed 0.1 NEAR forfeit ...');
await call(TRADER_B, NEW_ARENA_ID, 'create_battle', { coin_id: 0, opponent: TRADER_A }, '0.1');
await sleep(2000);
let battle0 = await view(NEW_ARENA_ID, 'get_battle', { battle_id: 0 });
console.log('  battle 0 status:', battle0.status, '| forfeit:', battle0.forfeit_yocto);
if (battle0.status !== 'pending') throw new Error(`v6 battle should be pending, got ${battle0.status}`);
if (battle0.forfeit_yocto !== '100000000000000000000000') throw new Error('v6 battle forfeit should be 0.1 NEAR');

// Snapshot the full v6 state for the post-migration comparison.
const baseline = {
  stats: await view(NEW_ARENA_ID, 'get_stats', {}),
  coin0: await view(NEW_ARENA_ID, 'get_coin', { coin_id: 0 }),
  agentA: await view(NEW_ARENA_ID, 'get_agent', { account: TRADER_A }),
  agentB: await view(NEW_ARENA_ID, 'get_agent', { account: TRADER_B }),
  battle0: await view(NEW_ARENA_ID, 'get_battle', { battle_id: 0 }),
  pool: await view(NEW_ARENA_ID, 'get_prize_pool', {}),
  activity: await view(NEW_ARENA_ID, 'get_activity', { limit: 100 }),
};
console.log('  v6 baseline:', JSON.stringify(baseline.stats), '| coin0 sold', baseline.coin0.sold_tokens,
  '| agentA score', baseline.agentA.score, '| agentB score', baseline.agentB.score,
  '| pool', baseline.pool, '| activity', baseline.activity.length);
if ('is_agent' in baseline.agentA || 'is_agent' in baseline.agentB) throw new Error('v6 get_agent already has is_agent — not v6?!');

console.log('\n== 2. deploy NEW (v7) WASM to the SAME account (no new())');
const newWasm = fs.readFileSync(NEW_WASM);
console.log('  new wasm bytes:', newWasm.length);
await withRetry(() => acct(NEW_ARENA_ID).then((a) => a.deployContract(newWasm)), 'deploy new');
console.log('  v7 WASM deployed over v6 state');

console.log('\n== 3. call migrate()');
await call(NEW_ARENA_ID, NEW_ARENA_ID, 'migrate', {}, '0', 100_000_000_000_000n);
console.log('  migrate() succeeded');

// The deploy + migrate are two transactions, and an RPC node can
// briefly serve the new WASM against the not-yet-migrated state,
// which fails deserialisation. Wait until the migrated state is
// readable before any verification view.
console.log('  waiting for the migrated state to be readable ...');
for (let i = 0; i < 30; i++) {
  await sleep(2000);
  try {
    const p = await view(NEW_ARENA_ID, 'get_params', {});
    if (p.schema_version === 7) {
      console.log('  migrated state readable (schema_version 7 live)');
      break;
    }
  } catch (e) {
    // Not readable yet; keep waiting.
  }
  if (i === 29) throw new Error('migrated state never became readable');
}

console.log('\n== 4. verify every piece of v6 state survived EXACTLY');
function eq(label, a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} CHANGED:\n  before: ${JSON.stringify(a)}\n  after:  ${JSON.stringify(b)}`);
  console.log(`  [ok] ${label} unchanged`);
}
const after = {
  stats: await view(NEW_ARENA_ID, 'get_stats', {}),
  coin0: await view(NEW_ARENA_ID, 'get_coin', { coin_id: 0 }),
  agentA: await view(NEW_ARENA_ID, 'get_agent', { account: TRADER_A }),
  agentB: await view(NEW_ARENA_ID, 'get_agent', { account: TRADER_B }),
  battle0: await view(NEW_ARENA_ID, 'get_battle', { battle_id: 0 }),
  pool: await view(NEW_ARENA_ID, 'get_prize_pool', {}),
  activity: await view(NEW_ARENA_ID, 'get_activity', { limit: 100 }),
};
eq('stats', baseline.stats, after.stats);
eq('coin0', baseline.coin0, after.coin0);
// AgentViews gain the new is_agent field (false until registered), so
// compare every field except is_agent, then assert is_agent is false.
for (const [label, before, afterV] of [['agentA', baseline.agentA, after.agentA], ['agentB', baseline.agentB, after.agentB]]) {
  const { is_agent: _ia, ...beforeRest } = before;
  const { is_agent, ...afterRest } = afterV;
  if (JSON.stringify(beforeRest) !== JSON.stringify(afterRest)) throw new Error(`${label} CHANGED (excluding is_agent):\n  before: ${JSON.stringify(beforeRest)}\n  after:  ${JSON.stringify(afterRest)}`);
  if (is_agent !== false) throw new Error(`${label} is_agent should be false after migration, got ${is_agent}`);
  console.log(`  [ok] ${label} unchanged except is_agent=false (never registered)`);
}
eq('battle0', baseline.battle0, after.battle0);
eq('pool', baseline.pool, after.pool);
eq('activity', baseline.activity, after.activity);

// migrate() must be one-shot: a second call fails (state is v7 now).
await expectFail(call(NEW_ARENA_ID, NEW_ARENA_ID, 'migrate', {}), 'second migrate()');
// new() must fail: state already exists.
await expectFail(call(NEW_ARENA_ID, NEW_ARENA_ID, 'new', {}), 'new() after migrate');

console.log('\n== 5. verify v7 params: schema 7, min stake 0.1 NEAR, registration enabled, no fixed forfeit');
const params = await view(NEW_ARENA_ID, 'get_params', {});
console.log('  schema_version:', params.schema_version,
  '| battle_min_stake_yocto:', params.battle_min_stake_yocto,
  '| agent_registration_enabled:', params.agent_registration_enabled,
  '| battle_forfeit_yocto present:', 'battle_forfeit_yocto' in params);
if (params.schema_version !== 7) throw new Error(`schema_version should be 7, got ${params.schema_version}`);
if (params.battle_min_stake_yocto !== '100000000000000000000000') throw new Error(`battle_min_stake_yocto should be 0.1 NEAR, got ${params.battle_min_stake_yocto}`);
if (params.agent_registration_enabled !== true) throw new Error('agent_registration_enabled should be true');
if ('battle_forfeit_yocto' in params) throw new Error('battle_forfeit_yocto must be gone in v7');
console.log('  [ok] v7 params live: schema 7, min stake 0.1 NEAR, registration enabled');

console.log('\n== 6. REGISTRATION: register_agent marks the caller, is idempotent, cannot register another account');
// A never-traded account reads is_agent=false.
const fresh = await view(NEW_ARENA_ID, 'get_agent', { account: NEW_ARENA_ID });
if (fresh.is_agent !== false) throw new Error('fresh account should read is_agent=false');
console.log('  [ok] a never-traded account reads is_agent=false');
console.log('  trader A registers ...');
await call(TRADER_A, NEW_ARENA_ID, 'register_agent', {});
await sleep(2000);
let aA = await view(NEW_ARENA_ID, 'get_agent', { account: TRADER_A });
let aB = await view(NEW_ARENA_ID, 'get_agent', { account: TRADER_B });
console.log('  after A registers: A is_agent', aA.is_agent, '| B is_agent', aB.is_agent, '| A score', aA.score, '(was', baseline.agentA.score, ')');
if (aA.is_agent !== true) throw new Error('A should be is_agent=true after registering');
if (aB.is_agent !== false) throw new Error('B should still be is_agent=false (A cannot register B)');
if (aA.score !== baseline.agentA.score) throw new Error('registering must not change the score');
console.log('  [ok] register_agent marks the caller only, and does not change the score');
console.log('  trader A registers again (idempotent) ...');
await call(TRADER_A, NEW_ARENA_ID, 'register_agent', {});
await sleep(2000);
aA = await view(NEW_ARENA_ID, 'get_agent', { account: TRADER_A });
if (aA.is_agent !== true) throw new Error('A should stay is_agent=true after a second register_agent');
console.log('  [ok] register_agent is idempotent');
console.log('  trader B registers ...');
await call(TRADER_B, NEW_ARENA_ID, 'register_agent', {});
await sleep(2000);
aB = await view(NEW_ARENA_ID, 'get_agent', { account: TRADER_B });
if (aB.is_agent !== true) throw new Error('B should be is_agent=true after registering');
console.log('  [ok] both traders are now registered agents');

console.log('\n== 7. NEW BATTLE MODEL: below-minimum rejected, 0.1 NEAR minimum works, cancel refunds');
const statsBefore = await view(NEW_ARENA_ID, 'get_stats', {});
const nextBattleId = statsBefore.battles;
console.log('  next battle id:', nextBattleId, '(battle 0 is the old v6 battle, still pending at 0.1 NEAR)');
await expectFail(
  call(TRADER_B, NEW_ARENA_ID, 'create_battle', { coin_id: 0, opponent: TRADER_A }, '0.05'),
  'create_battle with a 0.05 NEAR stake (below the 0.1 minimum)',
);
console.log('  trader A challenges trader B on coin 0 with the 0.1 NEAR minimum ...');
await call(TRADER_A, NEW_ARENA_ID, 'create_battle', { coin_id: 0, opponent: TRADER_B }, '0.1');
await sleep(2000);
let nb = await view(NEW_ARENA_ID, 'get_battle', { battle_id: nextBattleId });
console.log('  battle', nextBattleId, 'status:', nb.status, '| stake:', nb.forfeit_yocto);
if (nb.status !== 'pending') throw new Error(`minimum-stake battle should be pending, got ${nb.status}`);
if (nb.forfeit_yocto !== '100000000000000000000000') throw new Error(`minimum stake should be 0.1 NEAR, got ${nb.forfeit_yocto}`);
const aBalBefore = await acct(TRADER_A).then((a) => a.getAccountBalance());
await call(TRADER_A, NEW_ARENA_ID, 'cancel_battle', { battle_id: nextBattleId });
await sleep(2000);
nb = await view(NEW_ARENA_ID, 'get_battle', { battle_id: nextBattleId });
if (nb.status !== 'cancelled') throw new Error(`cancelled battle should read cancelled, got ${nb.status}`);
const aBalAfter = await acct(TRADER_A).then((a) => a.getAccountBalance());
console.log('  A balance before/after cancel:', (Number(aBalBefore.total) / 1e24).toFixed(4), '->', (Number(aBalAfter.total) / 1e24).toFixed(4), 'NEAR');
if (Number(aBalAfter.total) <= Number(aBalBefore.total)) throw new Error('cancel did not refund the stake');
console.log('  [ok] the minimum stake works and cancel refunds it');

console.log('\n== 8. v7 methods still work (buy accrues the trading fee)');
const poolBefore = await view(NEW_ARENA_ID, 'get_prize_pool', {});
await call(TRADER_B, NEW_ARENA_ID, 'buy', { coin_id: 0 }, '0.1');
await sleep(2000);
const poolAfter = await view(NEW_ARENA_ID, 'get_prize_pool', {});
console.log('  prize pool before/after a 0.1 NEAR buy:', poolBefore, '->', poolAfter);
if (BigInt(poolAfter) <= BigInt(poolBefore)) throw new Error('trading fee did not accrue after v7 migration');
console.log('  [ok] trading still works on v7');

console.log('\nMIGRATION TEST OK — v6 state survived migrate() on', NEW_ARENA_ID,
  'byte-for-byte, existing agents read is_agent=false, register_agent marks the caller (idempotent, caller-only), schema_version is 7, battle_min_stake_yocto is 0.1 NEAR, agent_registration_enabled is true, and the agents-decide-the-stake model works live. Safe to migrate pac-arena.testnet the same way.');
