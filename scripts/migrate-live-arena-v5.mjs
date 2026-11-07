// Migrate the LIVE arena pac-arena.testnet from v4 to v5 in place.
// Deploys the v5 WASM (Sybil-resistant qualified holders + improved
// reputation) over the v4 contract, calls migrate() once, and verifies
// the demo state survives (stats, coins, agents, battles, vote rounds,
// coin duels, meme days with their AI scores, prize pool, season,
// follows, copy positions, activity). The coin view gains the new
// qualified_holders field, so coins are compared field by field on
// the v4 data. Agent scores CHANGE under the v5 formula (new weights
// and components), so agents are compared field by field excluding
// score / band / max_drawdown_yocto, and the new scores are logged.
// The drawdown record starts empty at v5 (pre-v5 sells do not count
// toward it), so every agent's max_drawdown_yocto is 0 right after
// migration. Expected qualified_holders, computed from the live
// positions: coin 0 (DEGEN) has 3 holders, all big buyers, so 3;
// coin 1 (HOLD) and coin 2 (TBULL) have only their creator, so 1 each.
// Run only after scripts/test-migration-v5.mjs prints MIGRATION TEST
// OK on the v4 test arena.
// Run: node scripts/migrate-live-arena-v5.mjs
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
    agentDegen: await view('get_agent', { account: accounts.degen.accountId }),
    agentHolder: await view('get_agent', { account: accounts.holder.accountId }),
    agentSniper: await view('get_agent', { account: accounts.sniper.accountId }),
    battles: await view('list_battles', { from_index: 0, limit: 10 }),
    votes: await view('list_vote_rounds', { coin_id: 0, from_index: 0, limit: 10 }),
    duels: await view('list_coin_duels', { from_index: 0, limit: 10 }),
    meme0: await view('get_meme_day', { coin_id: 0, day: 0 }),
    meme1: await view('get_meme_day', { coin_id: 1, day: 0 }),
    meme2: await view('get_meme_day', { coin_id: 2, day: 0 }),
    pool: await view('get_prize_pool', {}),
    season,
    leaderboard: await view('get_season_leaderboard', { season_id: season.id }),
    activity: await view('get_activity', { limit: 100 }),
  };
}

console.log('== live v4 to v5 migration of', ARENA_ID);
console.log('snapshotting live v4 state ...');
const before = await snapshot();
console.log('  before:', JSON.stringify(before.stats), '| coin0 sold', before.coin0.sold_tokens,
  '| pool', before.pool, '| activity', before.activity.length, 'events',
  '| scores degen', before.agentDegen.score, 'holder', before.agentHolder.score, 'sniper', before.agentSniper.score);

console.log('deploying v5 WASM ...');
const wasm = fs.readFileSync(WASM);
console.log('  wasm bytes:', wasm.length);
await withRetry(() => arena.deployContract(wasm), 'deploy v5');
console.log('  v5 WASM deployed over v4 state');

console.log('calling migrate() ...');
await withRetry(() => arena.functionCall({
  contractId: ARENA_ID, methodName: 'migrate', args: {},
  gas: 100_000_000_000_000n, attachedDeposit: 0n,
}), 'migrate');
console.log('  migrate() succeeded');

// The deploy + migrate are two transactions, and an RPC node can
// briefly serve the new WASM against the not-yet-migrated state,
// which fails deserialisation. Wait until the migrated state is
// readable before any verification view.
console.log('  waiting for the migrated state to be readable ...');
for (let i = 0; i < 30; i++) {
  await sleep(2000);
  try {
    const p = await view('get_params', {});
    if (p.min_qualified_holding_tokens === '10000') {
      console.log('  migrated state readable (v5 params live)');
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
// Coins: v4 data identical, new qualified_holders field must match
// the expected count, image_url preserved.
function eqCoin(label, before, after, expectedQualified) {
  const b = { ...before };
  const a = { ...after };
  if (a.qualified_holders !== expectedQualified) {
    throw new Error(`${label} qualified_holders is ${a.qualified_holders}, expected ${expectedQualified}`);
  }
  delete a.qualified_holders;
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${label} v4 fields CHANGED:\n  before: ${JSON.stringify(b)}\n  after:  ${JSON.stringify(a)}`);
  }
  console.log(`  [ok] ${label} v4 fields unchanged (qualified_holders ${expectedQualified}, image_url ${JSON.stringify(a.image_url)})`);
}
// Agents: the score / band CHANGE under the v5 formula and the new
// max_drawdown_yocto field appears (0 right after migration, because
// the v5 drawdown record starts empty); every other field must be
// identical.
function eqAgent(label, before, after) {
  const b = { ...before };
  const a = { ...after };
  const { score: bs, band: bb, max_drawdown_yocto: _bd, ...bRest } = b;
  const { score: as, band: ab, max_drawdown_yocto: ad, ...aRest } = a;
  if (JSON.stringify(aRest) !== JSON.stringify(bRest)) {
    throw new Error(`${label} CHANGED (excluding score/band/drawdown):\n  before: ${JSON.stringify(bRest)}\n  after:  ${JSON.stringify(aRest)}`);
  }
  if (ad !== '0') throw new Error(`${label} max_drawdown_yocto should be 0 right after migration, got ${ad}`);
  console.log(`  [ok] ${label} fields unchanged; v4 score ${bs} (${bb}) -> v5 score ${as} (${ab}), max_drawdown_yocto 0`);
}
eq('stats', before.stats, after.stats);
eqCoin('coin0', before.coin0, after.coin0, 3);
eqCoin('coin1', before.coin1, after.coin1, 1);
eqCoin('coin2', before.coin2, after.coin2, 1);
eqAgent('agentDegen', before.agentDegen, after.agentDegen);
eqAgent('agentHolder', before.agentHolder, after.agentHolder);
eqAgent('agentSniper', before.agentSniper, after.agentSniper);
eq('battles', before.battles, after.battles);
eq('votes', before.votes, after.votes);
eq('duels', before.duels, after.duels);
eq('meme0', before.meme0, after.meme0);
eq('meme1', before.meme1, after.meme1);
eq('meme2', before.meme2, after.meme2);
eq('pool', before.pool, after.pool);
eq('season', before.season, after.season);
eq('leaderboard', before.leaderboard, after.leaderboard);
eq('activity', before.activity, after.activity);

const params = await view('get_params', {});
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
if (params.rep_weight_pnl !== 30 || params.rep_weight_win_rate !== 20 || params.rep_weight_hold_time !== 15
  || params.rep_weight_trade_count !== 15 || params.rep_weight_drawdown !== 20) {
  throw new Error('v5 reputation weights mismatch after live migration: ' + JSON.stringify(params));
}
if (params.volume_full_yocto !== '1000000000000000000000000' || params.count_full !== 10) {
  throw new Error('v5 reputation scaling params mismatch after live migration: ' + JSON.stringify(params));
}
console.log('  [ok] v5 params live (threshold 10000, weights 30/20/15/15/20, volume 1 NEAR, count 10; v4 image, v3 AI judge, v2 fees intact)');

// A second migrate() must fail (state is v5 now).
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

console.log('\nLIVE MIGRATION OK — pac-arena.testnet is v5 (Sybil-resistant qualified holders + improved reputation) with all demo state intact.');
