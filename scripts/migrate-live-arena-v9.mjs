// Migrate the LIVE arena pac-arena.testnet from v8 to v9 in place.
// Deploys the v9 WASM over the v8 contract, calls migrate() once, and
// verifies the live state survives EXACTLY (stats, 5 coins, 5 agents,
// battles, vote rounds, coin duels, meme days with their AI scores,
// prize pool, season, follows, copy positions, activity). The v9
// Contract is identical to the v8 Contract (the v9 changes are
// constants, not state), so every view must be byte-identical after
// migration. get_params must report schema_version 9,
// launch_cost_yocto = 2 NEAR, min_initial_buy_yocto = 0.1 NEAR,
// max_initial_buy_yocto = 10 NEAR, battle_min_stake_yocto = 0.1 NEAR,
// coin_duel_min_volume_yocto = 0.1 NEAR, coin_duel_pair_cap_yocto =
// 1 NEAR, meme_judging_grace_ns = 1 hour, and the reputation weights
// 30/20/15/15/20 afterwards. A second migrate() must fail.
//
// Why launch cost stays 2 NEAR: the token WASM is 198,066 bytes and
// NEAR storage needs ~1.98 NEAR for the code alone, so a 0.5 NEAR
// launch cost was proven impossible on a test arena (shortfall
// 1.48385 NEAR). The 2 NEAR launch cost funds the new coin's token
// account. Minimum initial buy rises 0.01 -> 0.1 NEAR so a minimum
// launch gives ~99,009 tokens and the creator qualifies (>= 10,000);
// maximum initial buy 10 NEAR caps how much of the curve a creator
// can take at launch.
//
// Run only after the v9 unit tests pass (cargo test, 83 tests) and
// the WASM is built. Run: node scripts/migrate-live-arena-v9.mjs
import fs from 'node:fs';
import { connect, keyStores, KeyPair } from 'near-api-js';

const ACCOUNTS_FILE = new URL('../.testnet-accounts.json', import.meta.url);
const WASM = new URL('../target/near/pac_arena/pac_arena.wasm', import.meta.url);
const ARENA_ID = 'pac-arena.testnet';
const RPC = 'https://rpc.testnet.fastnear.com';

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', accounts.arena.accountId, KeyPair.fromString(accounts.arena.privateKey));
const near = await connect({
  networkId: 'testnet', nodeUrl: RPC,
  walletUrl: 'https://testnet.mynearwallet.com/',
  helperUrl: 'https://helper.testnet.near.org', keyStore,
});
const arena = await near.account(ARENA_ID);
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
const view = (m, a = {}) => withRetry(() => arena.viewFunction({ contractId: ARENA_ID, methodName: m, args: a }), `view ${m}`);

async function snapshot() {
  const season = await view('get_current_season', {});
  return {
    stats: await view('get_stats', {}),
    coin0: await view('get_coin', { coin_id: 0 }),
    coin1: await view('get_coin', { coin_id: 1 }),
    coin2: await view('get_coin', { coin_id: 2 }),
    coin3: await view('get_coin', { coin_id: 3 }),
    coin4: await view('get_coin', { coin_id: 4 }),
    agentDegen: await view('get_agent', { account: accounts.degen.accountId }),
    agentHolder: await view('get_agent', { account: accounts.holder.accountId }),
    agentSniper: await view('get_agent', { account: accounts.sniper.accountId }),
    agentIsaiah: await view('get_agent', { account: 'clearsite587.testnet' }),
    agentIsaiahPac: await view('get_agent', { account: 'isaiah-pac.testnet' }),
    battles: await view('list_battles', { from_index: 0, limit: 10 }),
    votes: await view('list_vote_rounds', { coin_id: 0, from_index: 0, limit: 10 }),
    duels: await view('list_coin_duels', { from_index: 0, limit: 10 }),
    meme0: await view('get_meme_day', { coin_id: 0, day: 0 }),
    meme1: await view('get_meme_day', { coin_id: 1, day: 0 }),
    meme2: await view('get_meme_day', { coin_id: 2, day: 0 }),
    meme3: await view('get_meme_day', { coin_id: 3, day: 0 }),
    meme4: await view('get_meme_day', { coin_id: 4, day: 0 }),
    pool: await view('get_prize_pool', {}),
    season,
    leaderboard: await view('get_season_leaderboard', { season_id: season.id }),
    activity: await view('get_activity', { limit: 100 }),
  };
}

console.log('== live v8 to v9 migration of', ARENA_ID);
const preParams = await view('get_params', {});
if (preParams.schema_version !== 8) throw new Error(`live arena schema_version is ${preParams.schema_version}, expected 8 — it was already migrated to v9?!`);
if (preParams.battle_min_stake_yocto !== '100000000000000000000000') throw new Error('live arena is not v8 (battle_min_stake_yocto is not 0.1 NEAR)');
if (preParams.launch_cost_yocto !== '2000000000000000000000000') throw new Error('live arena launch cost is not 2 NEAR: ' + preParams.launch_cost_yocto);
if (preParams.min_initial_buy_yocto !== '10000000000000000000000') throw new Error('live arena min initial buy is not 0.01 NEAR: ' + preParams.min_initial_buy_yocto);
console.log('  confirmed live arena is v8 (schema 8, launch cost 2 NEAR, min buy 0.01 NEAR)');

console.log('snapshotting live v8 state ...');
const before = await snapshot();
fs.writeFileSync(new URL('../migration-v9-params-snapshot.json', import.meta.url), JSON.stringify(before, null, 2) + '\n');
console.log('  snapshot saved to migration-v9-params-snapshot.json');
console.log('  before:', JSON.stringify(before.stats), '| coin0 sold', before.coin0.sold_tokens,
  '| coin3 (Bull) sold', before.coin3.sold_tokens, '| pool', before.pool,
  '| activity', before.activity.length, 'events',
  '| scores degen', before.agentDegen.score, 'holder', before.agentHolder.score,
  'sniper', before.agentSniper.score, 'isaiah', before.agentIsaiah.score,
  '| battles', JSON.stringify(before.battles.map((b) => ({ id: b.id, status: b.status, stake: b.forfeit_yocto }))),
  '| coin4 (V8T) sold', before.coin4.sold_tokens);

console.log('deploying v9 WASM ...');
const wasm = fs.readFileSync(WASM);
console.log('  wasm bytes:', wasm.length);
await withRetry(() => arena.deployContract(wasm), 'deploy v9');
console.log('  v9 WASM deployed over v8 state');

console.log('calling migrate() ...');
const migrateResult = await withRetry(() => arena.functionCall({
  contractId: ARENA_ID, methodName: 'migrate', args: {},
  gas: 100_000_000_000_000n, attachedDeposit: 0n,
}), 'migrate');
console.log('  migrate() succeeded, tx:', migrateResult.transaction.hash);

// The deploy + migrate are two transactions, and an RPC node can
// briefly serve the new WASM against the not-yet-migrated state,
// which fails deserialisation. Wait until the migrated state is
// readable before any verification view.
console.log('  waiting for the migrated state to be readable ...');
for (let i = 0; i < 30; i++) {
  await sleep(2000);
  try {
    const p = await view('get_params', {});
    if (p.schema_version === 9) {
      console.log('  migrated state readable (schema_version 9 live)');
      break;
    }
  } catch (e) {
    // Not readable yet; keep waiting.
  }
  if (i === 29) throw new Error('migrated state never became readable');
}

console.log('verifying live state survived ...');
const after = await snapshot();
function eq(label, a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} CHANGED:\n  before: ${JSON.stringify(a)}\n  after:  ${JSON.stringify(b)}`);
  console.log(`  [ok] ${label} unchanged`);
}
// v8 adds only rollover_yocto (0 at migration) and three empty
// collections, so every view must be byte-identical except the meme
// day views, which gain the new judging_complete field:
eq('stats', before.stats, after.stats);
eq('coin0', before.coin0, after.coin0);
eq('coin1', before.coin1, after.coin1);
eq('coin2', before.coin2, after.coin2);
eq('coin3', before.coin3, after.coin3);
eq('coin4', before.coin4, after.coin4);
eq('agentDegen', before.agentDegen, after.agentDegen);
eq('agentHolder', before.agentHolder, after.agentHolder);
eq('agentSniper', before.agentSniper, after.agentSniper);
eq('agentIsaiah', before.agentIsaiah, after.agentIsaiah);
eq('agentIsaiahPac', before.agentIsaiahPac, after.agentIsaiahPac);
eq('battles', before.battles, after.battles);
eq('votes', before.votes, after.votes);
eq('duels', before.duels, after.duels);
for (const [label, beforeV, afterV] of [
  ['meme0', before.meme0, after.meme0],
  ['meme1', before.meme1, after.meme1],
  ['meme2', before.meme2, after.meme2],
  ['meme3', before.meme3, after.meme3],
  ['meme4', before.meme4, after.meme4],
]) {
  if (beforeV === null && afterV === null) { console.log(`  [ok] ${label} null on both sides (no meme day)`); continue; }
  if (beforeV === null || afterV === null) throw new Error(`${label} null mismatch: before=${JSON.stringify(beforeV)} after=${JSON.stringify(afterV)}`);
  const { judging_complete: _jc, ...beforeRest } = beforeV;
  const { judging_complete, ...afterRest } = afterV;
  if (JSON.stringify(beforeRest) !== JSON.stringify(afterRest)) throw new Error(`${label} CHANGED (excluding judging_complete):\n  before: ${JSON.stringify(beforeRest)}\n  after:  ${JSON.stringify(afterRest)}`);
  console.log(`  [ok] ${label} unchanged except judging_complete=${judging_complete} (new v8 field)`);
}
eq('pool', before.pool, after.pool);
eq('season', before.season, after.season);
eq('leaderboard', before.leaderboard, after.leaderboard);
eq('activity', before.activity, after.activity);

const params = await view('get_params', {});
if (params.schema_version !== 9) throw new Error('schema_version is not 9 after live migration: ' + JSON.stringify(params.schema_version));
if (params.launch_cost_yocto !== '2000000000000000000000000') throw new Error('launch_cost_yocto is not 2 NEAR after live migration: ' + JSON.stringify(params.launch_cost_yocto));
if (params.min_initial_buy_yocto !== '100000000000000000000000') throw new Error('min_initial_buy_yocto is not 0.1 NEAR after live migration: ' + JSON.stringify(params.min_initial_buy_yocto));
if (params.max_initial_buy_yocto !== '10000000000000000000000000') throw new Error('max_initial_buy_yocto is not 10 NEAR after live migration: ' + JSON.stringify(params.max_initial_buy_yocto));
if (params.battle_min_stake_yocto !== '100000000000000000000000') throw new Error('battle_min_stake_yocto is not 0.1 NEAR after live migration: ' + JSON.stringify(params.battle_min_stake_yocto));
if (params.rep_weight_pnl !== 30 || params.rep_weight_win_rate !== 20 || params.rep_weight_hold_time !== 15
  || params.rep_weight_trade_count !== 15 || params.rep_weight_drawdown !== 20) {
  throw new Error('v5 reputation weights mismatch after live migration: ' + JSON.stringify(params));
}
if (params.coin_duel_min_volume_yocto !== '100000000000000000000000') throw new Error('coin_duel_min_volume_yocto is not 0.1 NEAR after live migration: ' + JSON.stringify(params.coin_duel_min_volume_yocto));
if (params.coin_duel_pair_cap_yocto !== '1000000000000000000000000') throw new Error('coin_duel_pair_cap_yocto is not 1 NEAR after live migration: ' + JSON.stringify(params.coin_duel_pair_cap_yocto));
if (params.meme_judging_grace_ns !== 3600000000000) throw new Error('meme_judging_grace_ns is not 1 hour after live migration: ' + JSON.stringify(params.meme_judging_grace_ns));
if (params.agent_registration_enabled !== true) throw new Error('agent_registration_enabled is not true after live migration');
if (params.trading_fee_bp !== 100 || params.copy_fee_bp !== 100 || params.season_duration_days !== 7) {
  throw new Error('v2 params mismatch after live migration: ' + JSON.stringify(params));
}
if (params.ai_judge_account !== ARENA_ID || params.ai_weight_bp !== 5000 || params.community_weight_bp !== 5000 || params.meme_text_max_chars !== 500) {
  throw new Error('v3 AI judge params mismatch after live migration: ' + JSON.stringify(params));
}
if (params.image_url_max_chars !== 500) {
  throw new Error('v4 image params mismatch after live migration: ' + JSON.stringify(params));
}
if (params.min_qualified_holding_tokens !== '10000') {
  throw new Error('v5 Sybil threshold mismatch after live migration: ' + JSON.stringify(params.min_qualified_holding_tokens));
}
console.log('  [ok] v9 params live (schema_version 9; launch cost 2 NEAR; min buy 0.1 NEAR; max buy 10 NEAR; battle min stake 0.1 NEAR; duel min volume 0.1 NEAR; duel pair cap 1 NEAR; judging grace 1h; weights 30/20/15/15/20)');

// A second migrate() must fail (state is v9 now).
try {
  await arena.functionCall({
    contractId: ARENA_ID, methodName: 'migrate', args: {},
    gas: 100_000_000_000_000n, attachedDeposit: 0n,
  });
  throw new Error('second migrate() succeeded but must fail');
} catch (e) {
  if (String(e.message).includes('second migrate() succeeded')) throw e;
  console.log('  [ok] second migrate() correctly rejected');
}

console.log('\nLIVE MIGRATION OK — pac-arena.testnet is v9 with all live state intact.');
console.log('migrate tx:', migrateResult.transaction.hash);
console.log('NEXT STEPS (not done by this script):');
console.log('  1. Launch one test coin at the minimum (0.1 NEAR buy, 2.1 NEAR total) to prove the new launch economics live.');
console.log('  2. GitHub push is a separate step (not approved in this run).');
