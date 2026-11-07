// Migrate the LIVE arena pac-arena.testnet from v6 to v7 in place.
// Deploys the v7 WASM (agents decide the battle stake: the challenger
// chooses the stake, minimum 0.1 NEAR, the opponent must match it,
// winner takes both; PLUS agent registration: a wallet becomes an
// agent only by calling register_agent, stored in a new
// registered_agents set appended after schema_version, schema_version
// set to 7) over the v6 contract, calls migrate() once, and verifies
// the live state survives EXACTLY (stats, 4 coins, 4 agents, battles,
// vote rounds, coin duels, meme days with their AI scores, prize pool,
// season, follows, copy positions, activity). The v7 Coin layout is
// identical to v6; the v7 Contract adds only the registered_agents
// set (starts empty), so coins and agent scores must be byte-identical
// after migration, including qualified_holders, agent scores, and
// max_drawdown_yocto. Existing agents read is_agent=false until they
// register. Existing battles keep their stored 0.1 NEAR stake.
// get_params must report schema_version 7, battle_min_stake_yocto =
// 0.1 NEAR, and agent_registration_enabled = true afterwards, and
// battle_forfeit_yocto must be gone. A second migrate() must fail.
// After the migration the three demo agents (degen, holder, sniper)
// are registered onchain (register_agent, called by each wallet
// itself), so they read is_agent=true; Isaiah's clearsite587.testnet
// never registers, so it reads is_agent=false.
// Run only after scripts/test-migration-v7-registration.mjs prints OK
// on the test arena.
// Run: node scripts/migrate-live-arena-v7.mjs
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
    agentDegen: await view('get_agent', { account: accounts.degen.accountId }),
    agentHolder: await view('get_agent', { account: accounts.holder.accountId }),
    agentSniper: await view('get_agent', { account: accounts.sniper.accountId }),
    agentIsaiah: await view('get_agent', { account: 'clearsite587.testnet' }),
    battles: await view('list_battles', { from_index: 0, limit: 10 }),
    votes: await view('list_vote_rounds', { coin_id: 0, from_index: 0, limit: 10 }),
    duels: await view('list_coin_duels', { from_index: 0, limit: 10 }),
    meme0: await view('get_meme_day', { coin_id: 0, day: 0 }),
    meme1: await view('get_meme_day', { coin_id: 1, day: 0 }),
    meme2: await view('get_meme_day', { coin_id: 2, day: 0 }),
    meme3: await view('get_meme_day', { coin_id: 3, day: 0 }),
    pool: await view('get_prize_pool', {}),
    season,
    leaderboard: await view('get_season_leaderboard', { season_id: season.id }),
    activity: await view('get_activity', { limit: 100 }),
  };
}

console.log('== live v6 to v7 migration of', ARENA_ID);
const preParams = await view('get_params', {});
if (preParams.schema_version !== 6) throw new Error(`live arena schema_version is ${preParams.schema_version}, expected 6 — it was already migrated to v7?!`);
if (preParams.battle_forfeit_yocto !== '100000000000000000000000') throw new Error('live arena is not v6 (battle_forfeit_yocto is not 0.1 NEAR)');
console.log('  confirmed live arena is v6 (schema 6, fixed 0.1 NEAR forfeit)');

console.log('snapshotting live v6 state ...');
const before = await snapshot();
console.log('  before:', JSON.stringify(before.stats), '| coin0 sold', before.coin0.sold_tokens,
  '| coin3 (Bull) sold', before.coin3.sold_tokens, '| pool', before.pool,
  '| activity', before.activity.length, 'events',
  '| scores degen', before.agentDegen.score, 'holder', before.agentHolder.score,
  'sniper', before.agentSniper.score, 'isaiah', before.agentIsaiah.score,
  '| battles', JSON.stringify(before.battles.map((b) => ({ id: b.id, status: b.status, stake: b.forfeit_yocto }))));

console.log('deploying v7 WASM ...');
const wasm = fs.readFileSync(WASM);
console.log('  wasm bytes:', wasm.length);
await withRetry(() => arena.deployContract(wasm), 'deploy v7');
console.log('  v7 WASM deployed over v6 state');

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
    if (p.schema_version === 7) {
      console.log('  migrated state readable (schema_version 7 live)');
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
// v7 layout adds only registered_agents (empty at migration), so every
// view must be byte-identical except AgentViews, which gain the new
// is_agent field (false until the account registers):
// coins (including qualified_holders and image_url), agents
// (including scores and drawdown), battles (existing ones keep their
// stored 0.1 NEAR stake), votes, duels, memes.
eq('stats', before.stats, after.stats);
eq('coin0', before.coin0, after.coin0);
eq('coin1', before.coin1, after.coin1);
eq('coin2', before.coin2, after.coin2);
eq('coin3', before.coin3, after.coin3);
for (const [label, beforeV, afterV] of [
  ['agentDegen', before.agentDegen, after.agentDegen],
  ['agentHolder', before.agentHolder, after.agentHolder],
  ['agentSniper', before.agentSniper, after.agentSniper],
  ['agentIsaiah', before.agentIsaiah, after.agentIsaiah],
]) {
  const { is_agent: _ia, ...beforeRest } = beforeV;
  const { is_agent, ...afterRest } = afterV;
  if (JSON.stringify(beforeRest) !== JSON.stringify(afterRest)) throw new Error(`${label} CHANGED (excluding is_agent):\n  before: ${JSON.stringify(beforeRest)}\n  after:  ${JSON.stringify(afterRest)}`);
  if (is_agent !== false) throw new Error(`${label} is_agent should be false after migration, got ${is_agent}`);
  console.log(`  [ok] ${label} unchanged except is_agent=false (never registered)`);
}
eq('battles', before.battles, after.battles);
eq('votes', before.votes, after.votes);
eq('duels', before.duels, after.duels);
eq('meme0', before.meme0, after.meme0);
eq('meme1', before.meme1, after.meme1);
eq('meme2', before.meme2, after.meme2);
eq('meme3', before.meme3, after.meme3);
eq('pool', before.pool, after.pool);
eq('season', before.season, after.season);
eq('leaderboard', before.leaderboard, after.leaderboard);
eq('activity', before.activity, after.activity);

const params = await view('get_params', {});
if (params.schema_version !== 7) throw new Error('schema_version is not 7 after live migration: ' + JSON.stringify(params.schema_version));
if (params.battle_min_stake_yocto !== '100000000000000000000000') throw new Error('battle_min_stake_yocto is not 0.1 NEAR after live migration: ' + JSON.stringify(params.battle_min_stake_yocto));
if (params.agent_registration_enabled !== true) throw new Error('agent_registration_enabled is not true after live migration: ' + JSON.stringify(params.agent_registration_enabled));
if ('battle_forfeit_yocto' in params) throw new Error('battle_forfeit_yocto must be gone in v7');
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
console.log('  [ok] v7 params live (schema_version 7; battle_min_stake_yocto 0.1 NEAR; registration enabled; threshold 10000, weights 30/20/15/15/20, volume 1 NEAR, count 10; v4 image, v3 AI judge, v2 fees intact)');

// A second migrate() must fail (state is v7 now).
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

console.log('\nregistering the three demo agents onchain (register_agent, called by each wallet itself) ...');
for (const role of ['degen', 'holder', 'sniper']) {
  const { accountId, privateKey } = accounts[role];
  await keyStore.setKey('testnet', accountId, KeyPair.fromString(privateKey));
  const agent = await near.account(accountId);
  await withRetry(() => agent.functionCall({
    contractId: ARENA_ID, methodName: 'register_agent', args: {},
    gas: 100_000_000_000_000n, attachedDeposit: 0n,
  }), `register_agent ${role}`);
  await sleep(2000);
  const v = await view('get_agent', { account: accountId });
  if (v.is_agent !== true) throw new Error(`${role} (${accountId}) is_agent should be true after registering, got ${v.is_agent}`);
  console.log(`  [ok] ${role} (${accountId}) registered, is_agent=true, score ${v.score} (unchanged)`);
}
// Isaiah's own wallet never registers, so it stays a plain wallet.
const isaiah = await view('get_agent', { account: 'clearsite587.testnet' });
if (isaiah.is_agent !== false) throw new Error('clearsite587.testnet should stay is_agent=false (never registered)');
console.log('  [ok] clearsite587.testnet (Isaiah) stays is_agent=false — a normal wallet, no badge');

console.log('\nLIVE MIGRATION OK — pac-arena.testnet is v7 (agents decide the battle stake, minimum 0.1 NEAR; agent registration live; schema_version 7) with all live state intact, and the three demo agents are registered.');
console.log('migrate tx:', migrateResult.transaction.hash);
