// PAC v5 migration proof — RESUME for the v4 test arena.
// The full test (scripts/test-migration-v5.mjs) migrated the v4 test
// arena pac-mig4-mw6od4o3a.testnet to v5 successfully, but its first
// post-migrate view hit the new WASM against the not-yet-migrated
// state (an RPC node lagging the migrate transaction) and failed
// before the behaviour tests ran. The arena IS v5 now, so this script
// resumes from there: it verifies the v4 state survived against the
// baseline recorded before the migration, then runs the v5 behaviour
// tests (params, threshold crossing, 10-raw-holders milestone, v4
// methods). The v4 baseline values below are the exact values the
// full test snapshotted before deploying the v5 WASM.
// Run: node scripts/test-migration-v5-resume.mjs
import fs from 'node:fs';
import BN from 'bn.js';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';

const V4_ACCOUNTS = '/tmp/pac-migration-v4-accounts.json';
const RPC = 'https://rpc.testnet.fastnear.com';
const OUT = '/tmp/pac-migration-v5-accounts.json';
const parseNear = (n) => utils.format.parseNearAmount(n);

const v4 = JSON.parse(fs.readFileSync(V4_ACCOUNTS, 'utf8'));
const ids = Object.keys(v4);
const ARENA_ID = ids[0];
const TRADER_A = ids[1];
const TRADER_B = ids[2];
const TRADER_C = `c.${TRADER_A}`;
const SMALL = Array.from({ length: 7 }, (_, i) => `s${i}.${i < 4 ? TRADER_A : TRADER_B}`);

// Exact v4 baseline, snapshotted by the full test before migration.
const baseline = {
  stats: { coins: 4, agents: 2, trades: 20, battles: 1, resolved_battles: 0 },
  coin0: { sold: '1049500', holders: 2, image: null, milestones: [], burned: '0', reserve: '1086510000000000000000000' },
  coin1: { sold: '500000', holders: 1, image: null, milestones: [], burned: '0' },
  coin2: { sold: '500000', holders: 1, image: 'https://picsum.photos/seed/mig4-coin/256', milestones: [], burned: '0' },
  coin3: { sold: '500000', holders: 1, image: null, milestones: [], burned: '0' },
  agentA: { spent: '1250000000000000000000000', received: '0', sells: 0, wins: 0, launched: 2, v4score: 300, v5score: 350 },
  agentB: { spent: '1500000000000000000000000', received: '148500000000000000000000', sells: 1, wins: 0, launched: 2, v4score: 20, v5score: 365 },
  memeAiTotal: 255,
  pool: '28990000000000000000000',
  activityLen: 20,
  copyPosTokens: '49500',
};

const keyStore = new keyStores.InMemoryKeyStore();
for (const id of ids) await keyStore.setKey('testnet', id, KeyPair.fromString(v4[id].privateKey));
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
function check(label, cond, detail = '') {
  if (!cond) throw new Error(`CHECK FAILED: ${label} ${detail}`);
  console.log(`  [ok] ${label}`);
}

console.log('== 0. confirm the arena is already v5');
const params0 = await view(ARENA_ID, 'get_params', {});
if (!('min_qualified_holding_tokens' in params0)) throw new Error('arena is not v5 — run the full test instead');
console.log('  arena', ARENA_ID, 'is v5');

console.log('\n== 1. verify the v4 state survived (against the recorded baseline)');
const stats = await view(ARENA_ID, 'get_stats', {});
check('stats', JSON.stringify(stats) === JSON.stringify(baseline.stats), JSON.stringify(stats));
const coin0 = await view(ARENA_ID, 'get_coin', { coin_id: 0 });
const coin1 = await view(ARENA_ID, 'get_coin', { coin_id: 1 });
const coin2 = await view(ARENA_ID, 'get_coin', { coin_id: 2 });
const coin3 = await view(ARENA_ID, 'get_coin', { coin_id: 3 });
check('coin0 sold/holders/image/milestones/burned/qualified',
  coin0.sold_tokens === baseline.coin0.sold && coin0.holders === baseline.coin0.holders
  && coin0.image_url === baseline.coin0.image && JSON.stringify(coin0.milestones_fired) === '[]'
  && coin0.burned_tokens === baseline.coin0.burned && coin0.qualified_holders === 2
  && coin0.near_reserve_yocto === baseline.coin0.reserve,
  JSON.stringify({ sold: coin0.sold_tokens, holders: coin0.holders, qualified: coin0.qualified_holders }));
check('coin1 sold/holders/image/qualified',
  coin1.sold_tokens === baseline.coin1.sold && coin1.holders === baseline.coin1.holders
  && coin1.image_url === baseline.coin1.image && coin1.qualified_holders === 1);
check('coin2 sold/holders/image preserved/qualified',
  coin2.sold_tokens === baseline.coin2.sold && coin2.holders === baseline.coin2.holders
  && coin2.image_url === baseline.coin2.image && coin2.qualified_holders === 1);
check('coin3 sold/holders/image/qualified',
  coin3.sold_tokens === baseline.coin3.sold && coin3.holders === baseline.coin3.holders
  && coin3.image_url === baseline.coin3.image && coin3.qualified_holders === 1);
const agentA = await view(ARENA_ID, 'get_agent', { account: TRADER_A });
const agentB = await view(ARENA_ID, 'get_agent', { account: TRADER_B });
check('agentA fields + v5 score 350',
  agentA.total_spent_yocto === baseline.agentA.spent && agentA.total_received_yocto === baseline.agentA.received
  && agentA.sells === baseline.agentA.sells && agentA.winning_sells === baseline.agentA.wins
  && agentA.coins_launched === baseline.agentA.launched && agentA.score === baseline.agentA.v5score
  && agentA.max_drawdown_yocto === '0',
  `score ${agentA.score} (v4 was ${baseline.agentA.v4score})`);
check('agentB fields + v5 score 365',
  agentB.total_spent_yocto === baseline.agentB.spent && agentB.total_received_yocto === baseline.agentB.received
  && agentB.sells === baseline.agentB.sells && agentB.winning_sells === baseline.agentB.wins
  && agentB.coins_launched === baseline.agentB.launched && agentB.score === baseline.agentB.v5score
  && agentB.max_drawdown_yocto === '0',
  `score ${agentB.score} (v4 was ${baseline.agentB.v4score})`);
const meme0 = await view(ARENA_ID, 'get_meme_day', { coin_id: 0, day: 0 });
check('meme0 AI score survived', meme0.submissions[0].ai_score.total === baseline.memeAiTotal);
const pool = await view(ARENA_ID, 'get_prize_pool', {});
check('prize pool', pool === baseline.pool, pool);
const activity = await view(ARENA_ID, 'get_activity', { limit: 100 });
check('activity length', activity.length === baseline.activityLen, String(activity.length));
const battle0 = await view(ARENA_ID, 'get_battle', { battle_id: 0 });
check('battle0 still active', battle0.status === 'active');
const vote0 = await view(ARENA_ID, 'get_vote_round', { round_id: 0 });
check('vote0 still unexecuted', vote0.executed === false);
const duel0 = await view(ARENA_ID, 'get_coin_duel', { duel_id: 0 });
check('duel0 still active', duel0.status === 'active');
const copyPos = await view(ARENA_ID, 'get_copy_position', { copier: TRADER_B, leader: TRADER_A, coin_id: 0 });
check('copy position survived', copyPos.tokens === baseline.copyPosTokens, copyPos.tokens);
const season = await view(ARENA_ID, 'get_current_season', {});
check('season still active with the same pool', season.status === 'active' && season.pool_yocto === baseline.pool);

// migrate() must be one-shot: a second call fails (state is v5 now).
await expectFail(call(ARENA_ID, ARENA_ID, 'migrate', {}), 'second migrate()');
// new() must fail: state already exists.
await expectFail(call(ARENA_ID, ARENA_ID, 'new', {}), 'new() after migrate');

console.log('\n== 2. verify v5 params expose the Sybil threshold and the new reputation weights');
const params = await view(ARENA_ID, 'get_params', {});
console.log('  min_qualified_holding_tokens:', params.min_qualified_holding_tokens,
  '| rep weights:', params.rep_weight_pnl, params.rep_weight_win_rate, params.rep_weight_hold_time,
  params.rep_weight_trade_count, params.rep_weight_drawdown,
  '| volume_full_yocto:', params.volume_full_yocto, '| count_full:', params.count_full);
check('threshold 10000', params.min_qualified_holding_tokens === '10000');
check('weights 30/20/15/15/20',
  params.rep_weight_pnl === 30 && params.rep_weight_win_rate === 20 && params.rep_weight_hold_time === 15
  && params.rep_weight_trade_count === 15 && params.rep_weight_drawdown === 20);
check('volume_full 1 NEAR', params.volume_full_yocto === '1000000000000000000000000');
check('count_full 10', params.count_full === 10);
check('v4 image params intact', params.image_url_max_chars === 500);
check('v3 AI judge params intact', params.ai_judge_account === ARENA_ID && params.ai_weight_bp === 5000);

console.log('\n== 3. create the extra test accounts as funded sub-accounts (no helper call)');
const newAccounts = {};
async function createSub(parentId, subId, nearAmount) {
  const kp = KeyPair.fromRandom('ed25519');
  console.log(`  creating ${subId} under ${parentId} with ${nearAmount} NEAR ...`);
  await withRetry(() => acct(parentId).then((a) => a.createAccount(
    subId, kp.getPublicKey(), new BN(parseNear(nearAmount)),
  )), `create ${subId}`);
  await keyStore.setKey('testnet', subId, kp);
  newAccounts[subId] = { accountId: subId, publicKey: kp.getPublicKey().toString(), privateKey: kp.toString() };
  console.log(`  created ${subId}`);
}
await createSub(TRADER_A, TRADER_C, '0.5');
for (let i = 0; i < 4; i++) await createSub(TRADER_A, SMALL[i], '0.3');
for (let i = 4; i < 7; i++) await createSub(TRADER_B, SMALL[i], '0.3');
fs.writeFileSync(OUT, JSON.stringify(newAccounts, null, 2) + '\n', { mode: 0o600 });
console.log('  new sub-account keys written to', OUT);

const token0 = coin0.token_id;
console.log('\n== 4. threshold crossing: a small buy does not qualify, a bigger buy does, selling down unqualifies');
await call(TRADER_C, token0, 'storage_deposit', { account_id: TRADER_C }, '0.01');
let c0 = await view(ARENA_ID, 'get_coin', { coin_id: 0 });
console.log('  coin0 qualified_holders before C buys:', c0.qualified_holders);
check('coin0 has 2 qualified before C buys', c0.qualified_holders === 2);
// Coin 0 sold is ~1,049,500, so the price is 2e18 per token: 0.001 NEAR
// buys 500 tokens, below the 10,000 threshold.
await call(TRADER_C, ARENA_ID, 'buy', { coin_id: 0 }, '0.001');
await sleep(2000);
c0 = await view(ARENA_ID, 'get_coin', { coin_id: 0 });
console.log('  after C buys 0.001 NEAR: holders', c0.holders, 'qualified', c0.qualified_holders);
check('below-threshold buy does not qualify', c0.qualified_holders === 2);
check('raw holder count is 3 after C buys', c0.holders === 3);
// 0.02 NEAR more buys 10,000 tokens, taking C to ~10,500: above the threshold.
await call(TRADER_C, ARENA_ID, 'buy', { coin_id: 0 }, '0.02');
await sleep(2000);
c0 = await view(ARENA_ID, 'get_coin', { coin_id: 0 });
console.log('  after C buys 0.02 NEAR more: qualified', c0.qualified_holders);
check('crossing the threshold upward qualifies', c0.qualified_holders === 3);
// Sell down to ~5,000 tokens held: below the threshold again.
const balC = await withRetry(() => acct(TRADER_C).then((a) => a.viewFunction({
  contractId: token0, methodName: 'ft_balance_of', args: { account_id: TRADER_C },
})), 'ft_balance_of C');
const sellC = BigInt(balC) - 5000n * 1_000_000_000_000_000_000n;
if (sellC <= 0n) throw new Error(`C balance ${balC} is too small to sell down to 5000 tokens`);
await withRetry(() => acct(TRADER_C).then((a) => a.functionCall({
  contractId: token0, methodName: 'ft_transfer_call',
  args: { receiver_id: ARENA_ID, amount: sellC.toString(), memo: null, msg: 'sell' },
  gas: 100_000_000_000_000n, attachedDeposit: 1n,
})), 'sell C down');
await sleep(2000);
c0 = await view(ARENA_ID, 'get_coin', { coin_id: 0 });
console.log('  after C sells down to ~5,000 tokens: holders', c0.holders, 'qualified', c0.qualified_holders);
check('selling down below the threshold unqualifies', c0.qualified_holders === 2);
check('raw holder count stays 3 after C sells', c0.holders === 3);
// C sold at a small loss (the 1% trading fee), so C's v5 drawdown
// record is now positive: the drawdown tracker works on live sells.
const agentC = await view(ARENA_ID, 'get_agent', { account: TRADER_C });
console.log('  agentC after the losing sell: score', agentC.score, 'max_drawdown_yocto', agentC.max_drawdown_yocto);
check('C drawdown is positive after a losing sell', BigInt(agentC.max_drawdown_yocto) > 0n);

console.log('\n== 5. milestones count qualified holders, not raw wallets');
console.log('  coin0 has 3 raw holders and 2 qualified; adding 7 small holders takes it to 10 raw, still 2 qualified.');
for (const s of SMALL) {
  await call(s, token0, 'storage_deposit', { account_id: s }, '0.01');
  await call(s, ARENA_ID, 'buy', { coin_id: 0 }, '0.001');
  await sleep(1500);
}
c0 = await view(ARENA_ID, 'get_coin', { coin_id: 0 });
console.log('  coin0 holders:', c0.holders, 'qualified:', c0.qualified_holders,
  '| milestones_fired:', JSON.stringify(c0.milestones_fired), '| burned_tokens:', c0.burned_tokens);
check('10 raw holders', c0.holders === 10);
check('still 2 qualified', c0.qualified_holders === 2);
check('10-holder milestone did NOT fire', c0.milestones_fired.length === 0);
check('no burn happened', c0.burned_tokens === '0');
console.log('  [ok] 10 raw holders, 2 qualified: the 10-holder milestone did not fire — a Sybil farm of empty wallets cannot trigger it');

console.log('\n== 6. v4 methods still work after the v5 migration');
const poolBefore = await view(ARENA_ID, 'get_prize_pool', {});
await call(TRADER_B, ARENA_ID, 'buy', { coin_id: 0 }, '0.1');
await sleep(2000);
const poolAfter = await view(ARENA_ID, 'get_prize_pool', {});
console.log('  prize pool before/after a 0.1 NEAR buy:', poolBefore, '->', poolAfter);
check('trading fee accrues after v5 migration', BigInt(poolAfter) > BigInt(poolBefore));
// The v4 follow's max total (0.15 NEAR) is already 0.1 NEAR used, so
// a second 0.1 NEAR copy_buy would exceed the cap (correct
// enforcement, not a v5 bug). Prove the copy path with a copy_sell
// instead, which also exercises the v5 drawdown recording on copy sells.
const copyBefore = await view(ARENA_ID, 'get_copy_position', { copier: TRADER_B, leader: TRADER_A, coin_id: 0 });
await call(TRADER_B, ARENA_ID, 'copy_sell', { coin_id: 0, leader: TRADER_A, tokens: '10000' });
await sleep(2000);
const copyPos2 = await view(ARENA_ID, 'get_copy_position', { copier: TRADER_B, leader: TRADER_A, coin_id: 0 });
console.log('  copy position after copy_sell:', copyPos2.tokens, '(was', copyBefore.tokens, ')');
check('copy_sell works after v5 migration', BigInt(copyPos2.tokens) === BigInt(copyBefore.tokens) - 10000n);
const agentB2 = await view(ARENA_ID, 'get_agent', { account: TRADER_B });
console.log('  agentB after v5 trades: score', agentB2.score, 'max_drawdown_yocto', agentB2.max_drawdown_yocto);

console.log('\nMIGRATION TEST OK — v4 state survived migrate() on', ARENA_ID,
  'and all v5 Sybil + reputation behaviour works. Safe to migrate pac-arena.testnet the same way.');
