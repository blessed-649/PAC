// PAC v6 schema_version migration check (test arena already on old v6).
// The first v6 migration test (test-migration-v6.mjs) proved the v5->v6
// state copy is byte-exact, but the second migrate() SUCCEEDED because
// the v6 layout was identical to v5, so nothing distinguished them.
// This script proves the fix: the v6 Contract now carries a trailing
// schema_version field (set to 6 by new() and migrate()). It deploys
// the NEW v6 WASM to the already-migrated test arena
// pac-mig4-mw6od4o3a.testnet (old v6, layout-identical to v5), calls
// migrate(), and verifies:
//   - every piece of state survives exactly (same as the first test)
//   - get_params now reports schema_version 6
//   - a SECOND migrate() is REJECTED (the v6 state carries the trailing
//     schema_version bytes, which cannot deserialise as the v5
//     OldContract, so Borsh errors on the trailing bytes)
//   - new() is rejected
// Run: node scripts/test-migration-v6-version.mjs
import fs from 'node:fs';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';

const V5_ACCOUNTS = '/tmp/pac-migration-v4-accounts.json';
const NEW_WASM = new URL('../target/near/pac_arena/pac_arena.wasm', import.meta.url);
const RPC = 'https://rpc.testnet.fastnear.com';

const v5 = JSON.parse(fs.readFileSync(V5_ACCOUNTS, 'utf8'));
const ids = Object.keys(v5);
const ARENA_ID = ids[0];
const TRADER_A = ids[1];
const TRADER_B = ids[2];

const keyStore = new keyStores.InMemoryKeyStore();
for (const id of ids) await keyStore.setKey('testnet', id, KeyPair.fromString(v5[id].privateKey));
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
    contractId, methodName: method, args, gas, attachedDeposit: BigInt(utils.format.parseNearAmount(deposit)),
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
console.log('== 0. confirm the source arena is old v6 (v5 layout, no schema_version yet)');
const before = await view(ARENA_ID, 'get_params', {});
if (!('min_qualified_holding_tokens' in before)) throw new Error('source arena has no v5 params');
if ('schema_version' in before) throw new Error('source arena already reports schema_version — it was already migrated to new v6?!');
console.log('  source arena', ARENA_ID, 'is old v6 (v5 params, no schema_version in get_params)');

const baseline = {
  stats: await view(ARENA_ID, 'get_stats', {}),
  coin0: await view(ARENA_ID, 'get_coin', { coin_id: 0 }),
  coin1: await view(ARENA_ID, 'get_coin', { coin_id: 1 }),
  coin2: await view(ARENA_ID, 'get_coin', { coin_id: 2 }),
  coin3: await view(ARENA_ID, 'get_coin', { coin_id: 3 }),
  agentA: await view(ARENA_ID, 'get_agent', { account: TRADER_A }),
  agentB: await view(ARENA_ID, 'get_agent', { account: TRADER_B }),
  pool: await view(ARENA_ID, 'get_prize_pool', {}),
  season: await view(ARENA_ID, 'get_current_season', {}),
  activity: await view(ARENA_ID, 'get_activity', { limit: 100 }),
};
console.log('  baseline:', JSON.stringify(baseline.stats), '| coin0 sold', baseline.coin0.sold_tokens,
  '| agentB score', baseline.agentB.score);

console.log('\n== 1. deploy NEW (v6 + schema_version) WASM to the SAME account');
const newWasm = fs.readFileSync(NEW_WASM);
console.log('  new wasm bytes:', newWasm.length);
await withRetry(() => acct(ARENA_ID).then((a) => a.deployContract(newWasm)), 'deploy new');
console.log('  new v6 WASM deployed');

console.log('\n== 2. call migrate()');
await call(ARENA_ID, ARENA_ID, 'migrate', {}, '0', 100_000_000_000_000n);
console.log('  migrate() succeeded');

console.log('  waiting for the migrated state to be readable ...');
for (let i = 0; i < 30; i++) {
  await sleep(2000);
  try {
    const p = await view(ARENA_ID, 'get_params', {});
    if ('schema_version' in p) {
      console.log('  migrated state readable (schema_version live)');
      break;
    }
  } catch (e) { /* not readable yet */ }
  if (i === 29) throw new Error('migrated state never became readable');
}

console.log('\n== 3. verify state survived exactly and schema_version is 6');
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
eq('pool', baseline.pool, after.pool);
eq('season', baseline.season, after.season);
eq('activity', baseline.activity, after.activity);

const params = await view(ARENA_ID, 'get_params', {});
console.log('  schema_version:', params.schema_version);
if (params.schema_version !== 6) throw new Error(`schema_version should be 6, got ${params.schema_version}`);
if (params.min_qualified_holding_tokens !== '10000') throw new Error('v5 params changed');
console.log('  [ok] schema_version is 6 and all v5 params intact');

console.log('\n== 4. second migrate() must now be REJECTED (one-shot)');
await expectFail(call(ARENA_ID, ARENA_ID, 'migrate', {}), 'second migrate()');
await expectFail(call(ARENA_ID, ARENA_ID, 'new', {}), 'new() after migrate');

console.log('\nMIGRATION VERSION TEST OK — the v6 schema_version migration preserves state, reports version 6, and is one-shot. Safe to migrate pac-arena.testnet.');
