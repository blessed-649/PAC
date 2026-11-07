// Migrate the LIVE arena pac-arena.testnet from v2 to v3 in place.
// Deploys the v3 WASM (AI meme judge) over the v2 contract, calls
// migrate() once, and verifies the demo state survives (stats, coins,
// agents, battles, vote rounds, coin duels, meme days, prize pool,
// season, follows, activity). The meme day view gains the new
// meme_text and ai_score fields (both null for pre-v3 submissions),
// so the meme day is compared field by field on the v2 data.
// Run only after scripts/test-migration-v3.mjs prints MIGRATION TEST
// OK on a fresh account.
// Run: node scripts/migrate-live-arena-v3.mjs
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
  return {
    stats: await view('get_stats', {}),
    coin0: await view('get_coin', { coin_id: 0 }),
    coin1: await view('get_coin', { coin_id: 1 }),
    agentDegen: await view('get_agent', { account: accounts.degen.accountId }),
    agentHolder: await view('get_agent', { account: accounts.holder.accountId }),
    agentSniper: await view('get_agent', { account: accounts.sniper.accountId }),
    battles: await view('list_battles', { from_index: 0, limit: 10 }),
    votes: await view('list_vote_rounds', { coin_id: 0, from_index: 0, limit: 10 }),
    duels: await view('list_coin_duels', { from_index: 0, limit: 10 }),
    meme0: await view('get_meme_day', { coin_id: 0, day: 0 }),
    meme1: await view('get_meme_day', { coin_id: 1, day: 0 }),
    pool: await view('get_prize_pool', {}),
    season: await view('get_current_season', {}),
    leaderboard: await view('get_season_leaderboard', { season_id: 2965 }),
    activity: await view('get_activity', { limit: 100 }),
  };
}

console.log('== live v2 to v3 migration of', ARENA_ID);
console.log('snapshotting live v2 state ...');
const before = await snapshot();
console.log('  before:', JSON.stringify(before.stats), '| coin0 sold', before.coin0.sold_tokens,
  '| pool', before.pool, '| activity', before.activity.length, 'events');

console.log('deploying v3 WASM ...');
const wasm = fs.readFileSync(WASM);
console.log('  wasm bytes:', wasm.length, '| sha256 differs from v2 (see build log)');
await withRetry(() => arena.deployContract(wasm), 'deploy v3');
console.log('  v3 WASM deployed over v2 state');

console.log('calling migrate() ...');
await withRetry(() => arena.functionCall({
  contractId: ARENA_ID, methodName: 'migrate', args: {},
  gas: 100_000_000_000_000n, attachedDeposit: 0n,
}), 'migrate');
console.log('  migrate() succeeded');

console.log('verifying live state survived ...');
const after = await snapshot();
function eq(label, a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} CHANGED:\n  before: ${JSON.stringify(a)}\n  after:  ${JSON.stringify(b)}`);
  console.log(`  [ok] ${label} unchanged`);
}
eq('stats', before.stats, after.stats);
eq('coin0', before.coin0, after.coin0);
eq('coin1', before.coin1, after.coin1);
eq('agentDegen', before.agentDegen, after.agentDegen);
eq('agentHolder', before.agentHolder, after.agentHolder);
eq('agentSniper', before.agentSniper, after.agentSniper);
eq('battles', before.battles, after.battles);
eq('votes', before.votes, after.votes);
eq('duels', before.duels, after.duels);
eq('pool', before.pool, after.pool);
eq('season', before.season, after.season);
eq('leaderboard', before.leaderboard, after.leaderboard);
eq('activity', before.activity, after.activity);
// Meme days: v2 data identical, new fields null for pre-v3 submissions.
for (const label of ['meme0', 'meme1']) {
  const b = before[label], a = after[label];
  if (b === null && a === null) { console.log(`  [ok] ${label} still null`); continue; }
  if (b === null || a === null) throw new Error(`${label} CHANGED from ${JSON.stringify(b)} to ${JSON.stringify(a)}`);
  if (a.coin_id !== b.coin_id || a.day !== b.day || a.voters !== b.voters
    || a.resolved !== b.resolved || a.winner_hash !== b.winner_hash || a.winner !== b.winner) {
    throw new Error(`${label} day fields CHANGED`);
  }
  if (a.submissions.length !== b.submissions.length) throw new Error(`${label} submissions count CHANGED`);
  for (let i = 0; i < b.submissions.length; i++) {
    const bs = b.submissions[i], as = a.submissions[i];
    if (as.submitter !== bs.submitter || as.meme_hash !== bs.meme_hash || as.votes !== bs.votes) {
      throw new Error(`${label} submission ${i} CHANGED`);
    }
    if (as.meme_text !== null || as.ai_score !== null) {
      throw new Error(`${label} submission ${i} should have null text and score`);
    }
  }
  console.log(`  [ok] ${label} v2 data unchanged (new meme_text and ai_score fields are null)`);
}

const params = await view('get_params', {});
if (params.trading_fee_bp !== 100 || params.copy_fee_bp !== 100 || params.season_duration_days !== 7) {
  throw new Error('v2 params mismatch after live migration: ' + JSON.stringify(params));
}
if (params.ai_judge_account !== ARENA_ID || params.ai_weight_bp !== 5000 || params.community_weight_bp !== 5000 || params.meme_text_max_chars !== 500) {
  throw new Error('v3 AI judge params mismatch after live migration: ' + JSON.stringify(params));
}
console.log('  [ok] v3 params live (AI judge is the arena, 50/50, text max 500; v2 fees and season intact)');

// A second migrate() must fail (state is v3 now).
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

console.log('\nLIVE MIGRATION OK — pac-arena.testnet is v3 (AI meme judge) with all demo state intact.');
