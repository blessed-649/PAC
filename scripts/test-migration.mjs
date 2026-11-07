// PAC v2 migration proof (fresh testnet deployment).
// Deploys the OLD (v1) arena WASM to a fresh testnet account, builds
// state on it (launch, buys, sell, battle create + accept, vote round +
// votes, meme submit + vote, coin duel), then deploys the NEW (v2) WASM
// to the SAME account, calls migrate(), and verifies every piece of
// old state survives AND the new v2 methods work (copy flow, prize
// pool fee, season views, season resolve of an old empty season).
// Only after this prints MIGRATION TEST OK may the live arena
// pac-arena.testnet be migrated the same way.
// Keys are written ONLY to /tmp/pac-migration-accounts.json (chmod 600).
// Run: node scripts/test-migration.mjs
import fs from 'node:fs';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';

const OLD_WASM = '/tmp/pac-arena-v1.wasm';
const NEW_WASM = new URL('../target/near/pac_arena/pac_arena.wasm', import.meta.url);
const RPC = 'https://rpc.testnet.fastnear.com';
const HELPER = 'https://helper.testnet.near.org/account';
const OUT = '/tmp/pac-migration-accounts.json';
const parseNear = (n) => utils.format.parseNearAmount(n);

const suffix = Date.now().toString(36);
const ARENA_ID = `pac-mig-${suffix}a.testnet`;
const TRADER_A = `pac-mig-${suffix}b.testnet`;
const TRADER_B = `pac-mig-${suffix}c.testnet`;

async function createAccount(accountId) {
  const kp = KeyPair.fromRandom('ed25519');
  console.log(`creating ${accountId} ...`);
  const res = await fetch(HELPER, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: kp.getPublicKey().toString() }),
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`helper failed for ${accountId}: HTTP ${res.status} ${text.slice(0, 200)}`);
  console.log(`  created ${accountId}`);
  return { accountId, publicKey: kp.getPublicKey().toString(), privateKey: kp.toString() };
}

const accounts = {};
for (const id of [ARENA_ID, TRADER_A, TRADER_B]) accounts[id] = await createAccount(id);
fs.writeFileSync(OUT, JSON.stringify(accounts, null, 2) + '\n', { mode: 0o600 });
console.log('keys written to', OUT);

const keyStore = new keyStores.InMemoryKeyStore();
for (const id of [ARENA_ID, TRADER_A, TRADER_B]) {
  await keyStore.setKey('testnet', id, KeyPair.fromString(accounts[id].privateKey));
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
    console.log(`  [ok] correctly rejected: ${label} -> ${msg.slice(0, 100)}`);
  }
}

console.log('\n== 1. deploy OLD (v1) WASM to fresh arena', ARENA_ID);
const oldWasm = fs.readFileSync(OLD_WASM);
console.log('  old wasm bytes:', oldWasm.length);
await withRetry(() => acct(ARENA_ID).then((a) => a.deployContract(oldWasm)), 'deploy old');
await call(ARENA_ID, ARENA_ID, 'new', {});
console.log('  v1 initialised');
const v1params = await view(ARENA_ID, 'get_params', {});
if ('trading_fee_bp' in v1params) throw new Error('old wasm already has v2 params?!');
console.log('  confirmed v1 params (no trading_fee_bp)');

console.log('\n== 2. build v1 state: launch, buys, sell, battle, vote, meme, duel');
await call(TRADER_A, ARENA_ID, 'launch_coin', {
  name: 'Mig Coin', symbol: 'MIG', description: 'migration test coin',
  initial_buy_yocto: parseNear('0.5'),
}, '2.5', 300_000_000_000_000n);
let coin0 = null;
for (let i = 0; i < 20; i++) {
  await sleep(3000);
  coin0 = await view(ARENA_ID, 'get_coin', { coin_id: 0 });
  if (coin0) break;
}
if (!coin0) throw new Error('coin 0 never appeared on v1');
const token0 = coin0.token_id;
console.log('  coin 0:', token0, '| sold', coin0.sold_tokens);
await call(TRADER_B, token0, 'storage_deposit', { account_id: TRADER_B }, '0.01');
await call(TRADER_B, ARENA_ID, 'buy', { coin_id: 0 }, '0.3');
await sleep(2000);
await call(TRADER_A, ARENA_ID, 'buy', { coin_id: 0 }, '0.2');
await sleep(2000);
const balBefore = await withRetry(() => acct(TRADER_B).then((a) => a.viewFunction({
  contractId: token0, methodName: 'ft_balance_of', args: { account_id: TRADER_B },
})), 'ft_balance_of');
await withRetry(() => acct(TRADER_B).then((a) => a.functionCall({
  contractId: token0, methodName: 'ft_transfer_call',
  args: { receiver_id: ARENA_ID, amount: (BigInt(balBefore) / 2n).toString(), memo: null, msg: 'sell' },
  gas: 100_000_000_000_000n, attachedDeposit: 1n,
})), 'sell');
await sleep(2000);
await call(TRADER_A, ARENA_ID, 'create_battle', { coin_id: 0, opponent: TRADER_B }, '0.1');
await sleep(2000);
const battles = await view(ARENA_ID, 'list_battles', { from_index: 0, limit: 10 });
await call(TRADER_B, ARENA_ID, 'accept_battle', { battle_id: battles[battles.length - 1].id }, '0.1');
await sleep(2000);
await call(TRADER_B, ARENA_ID, 'create_vote_round', { coin_id: 0, duration_hours: 1 });
await sleep(2000);
await call(TRADER_A, ARENA_ID, 'vote', { round_id: 0, choice_index: 0 });
await call(TRADER_B, ARENA_ID, 'vote', { round_id: 0, choice_index: 2 });
await sleep(2000);
await call(TRADER_A, ARENA_ID, 'submit_meme', { coin_id: 0, meme_hash: 'QmMigMeme001' });
await call(TRADER_B, ARENA_ID, 'vote_meme', { coin_id: 0, day: 0, submission_index: 0 });
await sleep(2000);
// A duel needs two coins; launch a second coin for the duel instead.
let coin1 = await view(ARENA_ID, 'get_coin', { coin_id: 1 });
if (!coin1) {
  await call(TRADER_B, ARENA_ID, 'launch_coin', {
    name: 'Mig Two', symbol: 'MIG2', description: 'second migration test coin',
    initial_buy_yocto: parseNear('0.5'),
  }, '2.5', 300_000_000_000_000n);
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    coin1 = await view(ARENA_ID, 'get_coin', { coin_id: 1 });
    if (coin1) break;
  }
}
if (!coin1) throw new Error('coin 1 never appeared on v1');
await call(TRADER_A, ARENA_ID, 'create_coin_duel', { coin_a: 0, coin_b: 1 });
await sleep(2000);

// Snapshot the full v1 state for the post-migration comparison.
const baseline = {
  stats: await view(ARENA_ID, 'get_stats', {}),
  coin0: await view(ARENA_ID, 'get_coin', { coin_id: 0 }),
  coin1: await view(ARENA_ID, 'get_coin', { coin_id: 1 }),
  agentA: await view(ARENA_ID, 'get_agent', { account: TRADER_A }),
  agentB: await view(ARENA_ID, 'get_agent', { account: TRADER_B }),
  battle0: await view(ARENA_ID, 'get_battle', { battle_id: 0 }),
  vote0: await view(ARENA_ID, 'get_vote_round', { round_id: 0 }),
  duel0: await view(ARENA_ID, 'get_coin_duel', { duel_id: 0 }),
  meme0: await view(ARENA_ID, 'get_meme_day', { coin_id: 0, day: 0 }),
  activity: await view(ARENA_ID, 'get_activity', { limit: 100 }),
};
console.log('  v1 baseline:', JSON.stringify(baseline.stats), '| coin0 sold', baseline.coin0.sold_tokens,
  '| activity events', baseline.activity.length);

console.log('\n== 3. deploy NEW (v2) WASM to the SAME account (no new())');
const newWasm = fs.readFileSync(NEW_WASM);
console.log('  new wasm bytes:', newWasm.length);
await withRetry(() => acct(ARENA_ID).then((a) => a.deployContract(newWasm)), 'deploy new');
console.log('  v2 WASM deployed over v1 state');

console.log('\n== 4. call migrate()');
await call(ARENA_ID, ARENA_ID, 'migrate', {}, '0', 100_000_000_000_000n);
console.log('  migrate() succeeded');

console.log('\n== 5. verify every piece of v1 state survived');
function eq(label, a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} CHANGED:\n  before: ${JSON.stringify(a)}\n  after:  ${JSON.stringify(b)}`);
  console.log(`  [ok] ${label} unchanged`);
}
const after = {
  stats: await view(ARENA_ID, 'get_stats', {}),
  coin0: await view(ARENA_ID, 'get_coin', { coin_id: 0 }),
  coin1: await view(ARENA_ID, 'get_coin', { coin_id: 1 }),
  agentA: await view(ARENA_ID, 'get_agent', { account: TRADER_A }),
  agentB: await view(ARENA_ID, 'get_agent', { account: TRADER_B }),
  battle0: await view(ARENA_ID, 'get_battle', { battle_id: 0 }),
  vote0: await view(ARENA_ID, 'get_vote_round', { round_id: 0 }),
  duel0: await view(ARENA_ID, 'get_coin_duel', { duel_id: 0 }),
  meme0: await view(ARENA_ID, 'get_meme_day', { coin_id: 0, day: 0 }),
  activity: await view(ARENA_ID, 'get_activity', { limit: 100 }),
};
eq('stats', baseline.stats, after.stats);
eq('coin0', baseline.coin0, after.coin0);
eq('coin1', baseline.coin1, after.coin1);
eq('agentA', baseline.agentA, after.agentA);
eq('agentB', baseline.agentB, after.agentB);
eq('battle0', baseline.battle0, after.battle0);
eq('vote0', baseline.vote0, after.vote0);
eq('duel0', baseline.duel0, after.duel0);
eq('meme0', baseline.meme0, after.meme0);
eq('activity', baseline.activity, after.activity);

// migrate() must be one-shot: a second call fails (state is v2 now).
await expectFail(call(ARENA_ID, ARENA_ID, 'migrate', {}), 'second migrate()');
// new() must fail: state already exists.
await expectFail(call(ARENA_ID, ARENA_ID, 'new', {}), 'new() after migrate');

console.log('\n== 6. verify v2 methods work on the migrated state');
const params = await view(ARENA_ID, 'get_params', {});
console.log('  params trading_fee_bp:', params.trading_fee_bp, 'copy_fee_bp:', params.copy_fee_bp,
  'season_days:', params.season_duration_days, 'split:', JSON.stringify(params.season_top_shares_bp));
if (params.trading_fee_bp !== 100 || params.copy_fee_bp !== 100) throw new Error('v2 params mismatch');
let pool = await view(ARENA_ID, 'get_prize_pool', {});
console.log('  prize pool after migrate:', pool);
if (pool !== '0') throw new Error('expected empty prize pool after migrate');

// A buy accrues the 1% trading fee to the pool.
const coinBefore = await view(ARENA_ID, 'get_coin', { coin_id: 0 });
await call(TRADER_B, ARENA_ID, 'buy', { coin_id: 0 }, '0.1');
await sleep(2000);
pool = await view(ARENA_ID, 'get_prize_pool', {});
console.log('  prize pool after a 0.1 NEAR buy:', pool);
if (BigInt(pool) <= 0n) throw new Error('trading fee did not accrue to the pool');
const coinAfterBuy = await view(ARENA_ID, 'get_coin', { coin_id: 0 });
console.log('  coin0 reserve before/after buy:', coinBefore.near_reserve_yocto, '->', coinAfterBuy.near_reserve_yocto);

// Full copy flow: follow, leader buys, copier copy_buys, fee to leader,
// cap enforced, copy_sell from the vault, unfollow.
await call(TRADER_B, ARENA_ID, 'follow', {
  leader: TRADER_A, amount_per_trade_yocto: parseNear('0.1'),
  max_total_yocto: parseNear('0.15'), copy_public_key: null,
});
await sleep(2000);
let follow = await view(ARENA_ID, 'get_follow', { copier: TRADER_B, leader: TRADER_A });
console.log('  follow:', JSON.stringify(follow));
if (!follow || follow.amount_per_trade_yocto !== parseNear('0.1')) throw new Error('follow not stored');
await call(TRADER_A, token0, 'storage_deposit', { account_id: TRADER_A }, '0.01');
await call(TRADER_A, ARENA_ID, 'buy', { coin_id: 0 }, '0.05');
await sleep(2000);
await call(TRADER_B, ARENA_ID, 'copy_buy', { coin_id: 0, leader: TRADER_A }, '0.1');
await sleep(2000);
follow = await view(ARENA_ID, 'get_follow', { copier: TRADER_B, leader: TRADER_A });
const copyStats = await view(ARENA_ID, 'get_copy_stats', { leader: TRADER_A });
const copyPos = await view(ARENA_ID, 'get_copy_position', { copier: TRADER_B, leader: TRADER_A, coin_id: 0 });
console.log('  after copy_buy: follow total_copied', follow.total_copied_yocto,
  '| leader fees', copyStats.total_fees_earned_yocto, '| copiers', copyStats.copier_count,
  '| copy position tokens', copyPos.tokens);
if (follow.total_copied_yocto !== parseNear('0.1')) throw new Error('total_copied mismatch');
if (BigInt(copyStats.total_fees_earned_yocto) <= 0n) throw new Error('leader earned no copy fee');
if (BigInt(copyPos.tokens) <= 0n) throw new Error('copy position empty');
// Second copy would exceed the 0.15 NEAR max total -> must fail.
await expectFail(
  call(TRADER_B, ARENA_ID, 'copy_buy', { coin_id: 0, leader: TRADER_A }, '0.1'),
  'copy_buy over max total',
);
// Copy sell half the vaulted position.
const halfPos = (BigInt(copyPos.tokens) / 2n).toString();
await call(TRADER_B, ARENA_ID, 'copy_sell', { coin_id: 0, leader: TRADER_A, tokens: halfPos });
await sleep(2000);
const posAfterSell = await view(ARENA_ID, 'get_copy_position', { copier: TRADER_B, leader: TRADER_A, coin_id: 0 });
console.log('  copy position after copy_sell:', posAfterSell.tokens, '(was', copyPos.tokens + ')');
if (BigInt(posAfterSell.tokens) >= BigInt(copyPos.tokens)) throw new Error('copy_sell did not reduce position');
// Withdraw the rest to the copier wallet.
await call(TRADER_B, ARENA_ID, 'withdraw_copy', { coin_id: 0, leader: TRADER_A, tokens: posAfterSell.tokens });
await sleep(2000);
const posAfterWithdraw = await view(ARENA_ID, 'get_copy_position', { copier: TRADER_B, leader: TRADER_A, coin_id: 0 });
console.log('  copy position after withdraw_copy:', posAfterWithdraw.tokens);
if (posAfterWithdraw.tokens !== '0') throw new Error('withdraw did not empty position');
await call(TRADER_B, ARENA_ID, 'unfollow', { leader: TRADER_A });
await sleep(3000);
const followAfter = await view(ARENA_ID, 'get_follow', { copier: TRADER_B, leader: TRADER_A });
console.log('  follow after unfollow:', JSON.stringify(followAfter));
if (followAfter !== null) throw new Error('unfollow did not remove the follow');

// Season views + resolve: current season must reject, an old empty
// season (id 0, long ended, no trades) resolves with no winners.
const season = await view(ARENA_ID, 'get_current_season', {});
console.log('  current season:', JSON.stringify(season));
await expectFail(call(ARENA_ID, ARENA_ID, 'resolve_season', { season_id: season.id }), 'resolve current season');
await call(ARENA_ID, ARENA_ID, 'resolve_season', { season_id: 0 });
const season0 = await view(ARENA_ID, 'get_season', { season_id: 0 });
console.log('  season 0 after resolve:', JSON.stringify(season0));
if (season0.status !== 'resolved') throw new Error('season 0 did not resolve');
const board = await view(ARENA_ID, 'get_season_leaderboard', { season_id: season.id });
console.log('  current season leaderboard:', JSON.stringify(board));
if (!board.length) throw new Error('season leaderboard empty after trades');

console.log('\nMIGRATION TEST OK — v1 state survived migrate() on', ARENA_ID,
  'and all v2 methods work. Safe to migrate pac-arena.testnet the same way.');
