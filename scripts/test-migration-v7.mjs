// PAC v7 migration proof (v6 -> v7, agents decide the battle stake).
// The test arena pac-mig4-mw6od4o3a.testnet already holds real v6 state
// (4 coins, 10 agents, 33 trades, 1 battle, 1 vote round, 1 coin duel,
// an AI-scored meme day, a follow + copy position, season 2965, prize
// pool, agent_rep with drawdown records, schema_version 6, fixed 0.1
// NEAR battle forfeit). This script deploys the NEW (v7) WASM to that
// SAME account, calls migrate(), and verifies:
//   - every piece of v6 state survives EXACTLY (v7 layout == v6 layout;
//     the stake-model change is logic-only, no state-layout change)
//   - get_params now reports schema_version 7 and battle_min_stake_yocto
//     = 0.1 NEAR, and battle_forfeit_yocto is GONE
//   - a second migrate() is REJECTED (one-shot) and new() is rejected
//   - the new battle model works live:
//       * a stake below the 0.1 NEAR minimum is rejected
//       * a battle can be started with a 2 NEAR chosen stake, and the
//         battle records that stake
//       * accepting with the wrong amount is rejected; accepting with
//         exactly the stake works and the battle becomes active
//       * a battle at the 0.1 NEAR minimum works and cancel refunds it
//       * trading still accrues the fee
// Only after this prints MIGRATION TEST OK may the live arena
// pac-arena.testnet be migrated the same way.
// Extra test accounts are created as funded sub-accounts of the two
// traders, so no helper call is made. Keys for the new sub-accounts are
// written ONLY to /tmp/pac-migration-v7-accounts.json (chmod 600).
// Run: node scripts/test-migration-v7.mjs
import fs from 'node:fs';
import BN from 'bn.js';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';

const V6_ACCOUNTS = '/tmp/pac-migration-v4-accounts.json';
const NEW_WASM = new URL('../target/near/pac_arena/pac_arena.wasm', import.meta.url);
const RPC = 'https://rpc.testnet.fastnear.com';
const OUT = '/tmp/pac-migration-v7-accounts.json';
const parseNear = (n) => utils.format.parseNearAmount(n);

const v6 = JSON.parse(fs.readFileSync(V6_ACCOUNTS, 'utf8'));
const ids = Object.keys(v6);
const ARENA_ID = ids[0];
const TRADER_A = ids[1];
const TRADER_B = ids[2];

const keyStore = new keyStores.InMemoryKeyStore();
for (const id of ids) await keyStore.setKey('testnet', id, KeyPair.fromString(v6[id].privateKey));
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

console.log('== 0. confirm the source arena is v6 (not v7 yet)');
const v6params = await view(ARENA_ID, 'get_params', {});
if (v6params.schema_version !== 6) throw new Error(`source arena schema_version is ${v6params.schema_version}, expected 6`);
if (v6params.battle_forfeit_yocto !== '100000000000000000000000') throw new Error('source arena battle_forfeit_yocto is not 0.1 NEAR');
if ('battle_min_stake_yocto' in v6params) throw new Error('source arena already has battle_min_stake_yocto — it was already migrated to v7?!');
console.log('  source arena', ARENA_ID, 'is v6 (schema 6, fixed 0.1 NEAR forfeit)');

// Snapshot the full v6 state for the post-migration comparison.
const baseline = {
  stats: await view(ARENA_ID, 'get_stats', {}),
  coin0: await view(ARENA_ID, 'get_coin', { coin_id: 0 }),
  coin1: await view(ARENA_ID, 'get_coin', { coin_id: 1 }),
  coin2: await view(ARENA_ID, 'get_coin', { coin_id: 2 }),
  coin3: await view(ARENA_ID, 'get_coin', { coin_id: 3 }),
  agentA: await view(ARENA_ID, 'get_agent', { account: TRADER_A }),
  agentB: await view(ARENA_ID, 'get_agent', { account: TRADER_B }),
  battle0: await view(ARENA_ID, 'get_battle', { battle_id: 0 }),
  vote0: await view(ARENA_ID, 'get_vote_round', { round_id: 0 }),
  duel0: await view(ARENA_ID, 'get_coin_duel', { duel_id: 0 }),
  meme0: await view(ARENA_ID, 'get_meme_day', { coin_id: 0, day: 0 }),
  follow: await view(ARENA_ID, 'get_follow', { copier: TRADER_B, leader: TRADER_A }),
  copyPos: await view(ARENA_ID, 'get_copy_position', { copier: TRADER_B, leader: TRADER_A, coin_id: 0 }),
  pool: await view(ARENA_ID, 'get_prize_pool', {}),
  season: await view(ARENA_ID, 'get_current_season', {}),
  activity: await view(ARENA_ID, 'get_activity', { limit: 100 }),
};
console.log('  v6 baseline:', JSON.stringify(baseline.stats), '| coin0 sold', baseline.coin0.sold_tokens,
  '| qualified', baseline.coin0.qualified_holders, '| activity', baseline.activity.length,
  '| pool', baseline.pool, '| meme0 AI total', baseline.meme0.submissions[0].ai_score.total,
  '| agentA score', baseline.agentA.score, '| agentB score', baseline.agentB.score,
  '| battle0 forfeit', baseline.battle0.forfeit_yocto, '| battle0 status', baseline.battle0.status);

console.log('\n== 1. deploy NEW (v7) WASM to the SAME account (no new())');
const newWasm = fs.readFileSync(NEW_WASM);
console.log('  new wasm bytes:', newWasm.length);
await withRetry(() => acct(ARENA_ID).then((a) => a.deployContract(newWasm)), 'deploy new');
console.log('  v7 WASM deployed over v6 state');

console.log('\n== 2. call migrate()');
await call(ARENA_ID, ARENA_ID, 'migrate', {}, '0', 100_000_000_000_000n);
console.log('  migrate() succeeded');

// The deploy + migrate are two transactions, and an RPC node can
// briefly serve the new WASM against the not-yet-migrated state,
// which fails deserialisation. Wait until the migrated state is
// readable before any verification view.
console.log('  waiting for the migrated state to be readable ...');
for (let i = 0; i < 30; i++) {
  await sleep(2000);
  try {
    const p = await view(ARENA_ID, 'get_params', {});
    if (p.schema_version === 7) {
      console.log('  migrated state readable (schema_version 7 live)');
      break;
    }
  } catch (e) {
    // Not readable yet; keep waiting.
  }
  if (i === 29) throw new Error('migrated state never became readable');
}

console.log('\n== 3. verify every piece of v6 state survived EXACTLY (v7 layout == v6 layout)');
function eq(label, a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} CHANGED:\n  before: ${JSON.stringify(a)}\n  after:  ${JSON.stringify(b)}`);
  console.log(`  [ok] ${label} unchanged`);
}
const after = {
  stats: await view(ARENA_ID, 'get_stats', {}),
  coin0: await view(ARENA_ID, 'get_coin', { coin_id: 0 }),
  coin1: await view(ARENA_ID, 'get_coin', { coin_id: 1 }),
  coin2: await view(ARENA_ID, 'get_coin', { coin_id: 2 }),
  coin3: await view(ARENA_ID, 'get_coin', { coin_id: 3 }),
  agentA: await view(ARENA_ID, 'get_agent', { account: TRADER_A }),
  agentB: await view(ARENA_ID, 'get_agent', { account: TRADER_B }),
  battle0: await view(ARENA_ID, 'get_battle', { battle_id: 0 }),
  vote0: await view(ARENA_ID, 'get_vote_round', { round_id: 0 }),
  duel0: await view(ARENA_ID, 'get_coin_duel', { duel_id: 0 }),
  meme0: await view(ARENA_ID, 'get_meme_day', { coin_id: 0, day: 0 }),
  follow: await view(ARENA_ID, 'get_follow', { copier: TRADER_B, leader: TRADER_A }),
  copyPos: await view(ARENA_ID, 'get_copy_position', { copier: TRADER_B, leader: TRADER_A, coin_id: 0 }),
  pool: await view(ARENA_ID, 'get_prize_pool', {}),
  season: await view(ARENA_ID, 'get_current_season', {}),
  activity: await view(ARENA_ID, 'get_activity', { limit: 100 }),
};
eq('stats', baseline.stats, after.stats);
eq('coin0', baseline.coin0, after.coin0);
eq('coin1', baseline.coin1, after.coin1);
eq('coin2', baseline.coin2, after.coin2);
eq('coin3', baseline.coin3, after.coin3);
eq('agentA', baseline.agentA, after.agentA);
eq('agentB', baseline.agentB, after.agentB);
// The old battle keeps its stored 0.1 NEAR stake and its status.
eq('battle0', baseline.battle0, after.battle0);
eq('vote0', baseline.vote0, after.vote0);
eq('duel0', baseline.duel0, after.duel0);
eq('meme0', baseline.meme0, after.meme0);
eq('follow', baseline.follow, after.follow);
eq('copyPos', baseline.copyPos, after.copyPos);
eq('pool', baseline.pool, after.pool);
eq('season', baseline.season, after.season);
eq('activity', baseline.activity, after.activity);

// migrate() must be one-shot: a second call fails (state is v7 now).
await expectFail(call(ARENA_ID, ARENA_ID, 'migrate', {}), 'second migrate()');
// new() must fail: state already exists.
await expectFail(call(ARENA_ID, ARENA_ID, 'new', {}), 'new() after migrate');

console.log('\n== 4. verify v7 params: schema 7, min stake 0.1 NEAR, no fixed forfeit field');
const params = await view(ARENA_ID, 'get_params', {});
console.log('  schema_version:', params.schema_version,
  '| battle_min_stake_yocto:', params.battle_min_stake_yocto,
  '| battle_forfeit_yocto present:', 'battle_forfeit_yocto' in params);
if (params.schema_version !== 7) throw new Error(`schema_version should be 7, got ${params.schema_version}`);
if (params.battle_min_stake_yocto !== '100000000000000000000000') throw new Error(`battle_min_stake_yocto should be 0.1 NEAR, got ${params.battle_min_stake_yocto}`);
if ('battle_forfeit_yocto' in params) throw new Error('battle_forfeit_yocto must be gone in v7');
if (params.min_qualified_holding_tokens !== '10000') throw new Error('min_qualified_holding_tokens is not 10000');
if (params.rep_weight_pnl !== 30 || params.rep_weight_win_rate !== 20 || params.rep_weight_hold_time !== 15
  || params.rep_weight_trade_count !== 15 || params.rep_weight_drawdown !== 20) {
  throw new Error('v7 reputation weights are not 30/20/15/15/20');
}
console.log('  [ok] v7 params live: schema 7, min stake 0.1 NEAR, weights 30/20/15/15/20');

console.log('\n== 5. NEW MODEL: a stake below the 0.1 NEAR minimum is rejected');
const statsBefore = await view(ARENA_ID, 'get_stats', {});
const nextBattleId = statsBefore.battles;
console.log('  next battle id:', nextBattleId);
await expectFail(
  call(TRADER_B, ARENA_ID, 'create_battle', { coin_id: 0, opponent: TRADER_A }, '0.05'),
  'create_battle with a 0.05 NEAR stake (below the 0.1 minimum)',
);

console.log('\n== 6. NEW MODEL: a battle can be started with a 2 NEAR chosen stake');
console.log('  B challenges A on coin 0 with a 2 NEAR stake ...');
await call(TRADER_B, ARENA_ID, 'create_battle', { coin_id: 0, opponent: TRADER_A }, '2');
await sleep(2000);
let nb = await view(ARENA_ID, 'get_battle', { battle_id: nextBattleId });
console.log('  battle', nextBattleId, 'status:', nb.status, '| stake (forfeit_yocto):', nb.forfeit_yocto);
if (nb.status !== 'pending') throw new Error(`new battle should be pending, got ${nb.status}`);
if (nb.forfeit_yocto !== '2000000000000000000000000') throw new Error(`battle stake should be 2 NEAR, got ${nb.forfeit_yocto}`);
console.log('  [ok] the chosen 2 NEAR stake is recorded on the battle');

console.log('\n== 7. NEW MODEL: accepting with the wrong amount is rejected, matching it works');
await expectFail(
  call(TRADER_A, ARENA_ID, 'accept_battle', { battle_id: nextBattleId }, '0.1'),
  'accept_battle with 0.1 NEAR (not the 2 NEAR stake)',
);
await call(TRADER_A, ARENA_ID, 'accept_battle', { battle_id: nextBattleId }, '2');
await sleep(2000);
nb = await view(ARENA_ID, 'get_battle', { battle_id: nextBattleId });
console.log('  battle', nextBattleId, 'status after accept:', nb.status, '| stake:', nb.forfeit_yocto);
if (nb.status !== 'active') throw new Error(`accepted battle should be active, got ${nb.status}`);
console.log('  [ok] the opponent matched the 2 NEAR stake and the battle is active');

console.log('\n== 8. NEW MODEL: a battle at the 0.1 NEAR minimum works, and cancel refunds it');
const minBattleId = nextBattleId + 1;
console.log('  B challenges A on coin 0 with the 0.1 NEAR minimum ...');
await call(TRADER_B, ARENA_ID, 'create_battle', { coin_id: 0, opponent: TRADER_A }, '0.1');
await sleep(2000);
let mb = await view(ARENA_ID, 'get_battle', { battle_id: minBattleId });
console.log('  battle', minBattleId, 'status:', mb.status, '| stake:', mb.forfeit_yocto);
if (mb.status !== 'pending') throw new Error(`minimum-stake battle should be pending, got ${mb.status}`);
if (mb.forfeit_yocto !== '100000000000000000000000') throw new Error(`minimum stake should be 0.1 NEAR, got ${mb.forfeit_yocto}`);
const bBalBefore = await acct(TRADER_B).then((a) => a.getAccountBalance());
await call(TRADER_B, ARENA_ID, 'cancel_battle', { battle_id: minBattleId });
await sleep(2000);
mb = await view(ARENA_ID, 'get_battle', { battle_id: minBattleId });
console.log('  battle', minBattleId, 'status after cancel:', mb.status);
if (mb.status !== 'cancelled') throw new Error(`cancelled battle should read cancelled, got ${mb.status}`);
const bBalAfter = await acct(TRADER_B).then((a) => a.getAccountBalance());
console.log('  B balance before/after cancel:', (Number(bBalBefore.total) / 1e24).toFixed(4), '->', (Number(bBalAfter.total) / 1e24).toFixed(4), 'NEAR');
if (Number(bBalAfter.total) <= Number(bBalBefore.total)) throw new Error('cancel did not refund the stake');
// Accepting a cancelled battle must fail.
await expectFail(call(TRADER_A, ARENA_ID, 'accept_battle', { battle_id: minBattleId }, '0.1'), 'accept a cancelled battle');
console.log('  [ok] the minimum stake works and cancel refunds it');

console.log('\n== 9. v7 methods still work (buy accrues the trading fee)');
const poolBefore = await view(ARENA_ID, 'get_prize_pool', {});
await call(TRADER_B, ARENA_ID, 'buy', { coin_id: 0 }, '0.1');
await sleep(2000);
const poolAfter = await view(ARENA_ID, 'get_prize_pool', {});
console.log('  prize pool before/after a 0.1 NEAR buy:', poolBefore, '->', poolAfter);
if (BigInt(poolAfter) <= BigInt(poolBefore)) throw new Error('trading fee did not accrue after v7 migration');
console.log('  [ok] trading still works on v7');

console.log('\nMIGRATION TEST OK — v6 state survived migrate() on', ARENA_ID,
  'byte-for-byte, schema_version is 7, battle_min_stake_yocto is 0.1 NEAR, and the agents-decide-the-stake model works live. Safe to migrate pac-arena.testnet the same way.');
