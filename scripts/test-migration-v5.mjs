// PAC v5 migration proof (existing v4 test arena).
// The testnet account helper rate-limits new top-level accounts, so
// this script reuses the v4 migration test's arena, which already
// holds real v4 state (4 coins, 2 agents, 20 trades, 1 battle, 1 vote
// round, 1 coin duel, an AI-scored meme day, a follow + copy position,
// season 2965, prize pool). It deploys the NEW (v5) WASM to that SAME
// account, calls migrate(), and verifies every piece of v4 state
// survives AND the new v5 methods work:
//   - coins carry qualified_holders, computed from curve positions
//     (coin 0: creator A + buyer B qualify = 2; coins 1-3: creator only = 1)
//   - agent scores CHANGE under the v5 formula (weights and components
//     changed), so agent views are compared field by field excluding
//     score / band / max_drawdown_yocto, and the new scores are sane
//   - a small buy below the threshold does not qualify a holder, a
//     bigger buy does, selling down below the threshold unqualifies
//   - 10 raw holders with fewer than 10 qualified does NOT fire the
//     10-holder milestone (milestones count qualified holders only)
//   - the v5 params expose the threshold and the new reputation weights
// The extra test accounts (trader C + 7 small holders) are created as
// funded sub-accounts of the two v4 traders, so no helper call is made.
// Only after this prints MIGRATION TEST OK may the live arena
// pac-arena.testnet be migrated the same way.
// Keys for the new sub-accounts are written ONLY to
// /tmp/pac-migration-v5-accounts.json (chmod 600).
// Run: node scripts/test-migration-v5.mjs
import fs from 'node:fs';
import BN from 'bn.js';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';

const V4_ACCOUNTS = '/tmp/pac-migration-v4-accounts.json';
const NEW_WASM = new URL('../target/near/pac_arena/pac_arena.wasm', import.meta.url);
const RPC = 'https://rpc.testnet.fastnear.com';
const OUT = '/tmp/pac-migration-v5-accounts.json';
const parseNear = (n) => utils.format.parseNearAmount(n);

const v4 = JSON.parse(fs.readFileSync(V4_ACCOUNTS, 'utf8'));
const ids = Object.keys(v4);
const ARENA_ID = ids[0];
const TRADER_A = ids[1];
const TRADER_B = ids[2];
// Sub-accounts of the two traders (no helper call needed).
const TRADER_C = `c.${TRADER_A}`;
const SMALL = Array.from({ length: 7 }, (_, i) => `s${i}.${i < 4 ? TRADER_A : TRADER_B}`);

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

console.log('== 0. confirm the source arena is v4 (not v5 yet)');
const v4params = await view(ARENA_ID, 'get_params', {});
if (!('image_url_max_chars' in v4params)) throw new Error('source arena has no v4 image params?!');
if ('min_qualified_holding_tokens' in v4params) throw new Error('source arena already has v5 Sybil params — it was migrated already?!');
console.log('  source arena', ARENA_ID, 'is v4 (image_url_max_chars present, no min_qualified_holding_tokens)');

// Snapshot the full v4 state for the post-migration comparison.
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
console.log('  v4 baseline:', JSON.stringify(baseline.stats), '| coin0 sold', baseline.coin0.sold_tokens,
  '| activity events', baseline.activity.length, '| pool', baseline.pool,
  '| meme0 AI total', baseline.meme0.submissions[0].ai_score.total,
  '| agentA v4 score', baseline.agentA.score, '| agentB v4 score', baseline.agentB.score);

console.log('\n== 1. deploy NEW (v5) WASM to the SAME account (no new())');
const newWasm = fs.readFileSync(NEW_WASM);
console.log('  new wasm bytes:', newWasm.length);
await withRetry(() => acct(ARENA_ID).then((a) => a.deployContract(newWasm)), 'deploy new');
console.log('  v5 WASM deployed over v4 state');

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
    if ('min_qualified_holding_tokens' in p) {
      console.log('  migrated state readable (v5 params live)');
      break;
    }
  } catch (e) {
    // Not readable yet; keep waiting.
  }
  if (i === 29) throw new Error('migrated state never became readable');
}

console.log('\n== 3. verify every piece of v4 state survived');
function eq(label, a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} CHANGED:\n  before: ${JSON.stringify(a)}\n  after:  ${JSON.stringify(b)}`);
  console.log(`  [ok] ${label} unchanged`);
}
// Coin views gain exactly one new field (qualified_holders); every
// other field must be identical. Expected qualified counts, computed
// from the v4 flow: coin 0 has creator A (~700k tokens) and buyer B
// (~150k after selling half) qualifying, so 2. Coins 1-3 have only
// their creator (500k each), so 1.
function eqCoin(label, before, after, expectedQualified) {
  const b = { ...before };
  const a = { ...after };
  if (a.qualified_holders !== expectedQualified) {
    throw new Error(`${label} qualified_holders is ${a.qualified_holders}, expected ${expectedQualified}`);
  }
  delete a.qualified_holders;
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} CHANGED:\n  before: ${JSON.stringify(b)}\n  after:  ${JSON.stringify(a)}`);
  console.log(`  [ok] ${label} unchanged, qualified_holders ${expectedQualified} as expected`);
}
// Agent views gain max_drawdown_yocto and the score / band CHANGE
// under the v5 formula (new weights and components), so those three
// fields are excluded from the equality check and verified separately.
function eqAgent(label, before, after) {
  const b = { ...before };
  const a = { ...after };
  const { score: bs, band: bb, max_drawdown_yocto: _bd, ...bRest } = b;
  const { score: as, band: ab, max_drawdown_yocto: ad, ...aRest } = a;
  if (JSON.stringify(aRest) !== JSON.stringify(bRest)) {
    throw new Error(`${label} CHANGED (excluding score/band/drawdown):\n  before: ${JSON.stringify(bRest)}\n  after:  ${JSON.stringify(aRest)}`);
  }
  console.log(`  [ok] ${label} fields unchanged; v4 score ${bs} (${bb}) -> v5 score ${as} (${ab}), max_drawdown_yocto ${ad}`);
  return { beforeScore: bs, afterScore: as, drawdown: ad };
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
eqCoin('coin0', baseline.coin0, after.coin0, 2);
eqCoin('coin1', baseline.coin1, after.coin1, 1);
eqCoin('coin2', baseline.coin2, after.coin2, 1);
eqCoin('coin3', baseline.coin3, after.coin3, 1);
eqAgent('agentA', baseline.agentA, after.agentA);
eqAgent('agentB', baseline.agentB, after.agentB);
// A spent 1.25 NEAR and never sold, so the v5 score is 350, not the
// neutral 500: the realised-PnL part is 0 (received 0, spent 1.25
// NEAR) while the win / hold / count / drawdown parts are neutral
// (500) with no sells. The PnL part measures realised cash flow
// only, so an agent holding unsold tokens scores low on PnL until
// they sell — the same realised-only behaviour the v4 formula had.
// B sold once at a loss under v4, so the v5 score is 365, below
// solid. Both agents' drawdown is 0 right after migration: the v5
// AgentRep collection starts empty and drawdown is measured from v5
// onward only, so a pre-v5 sell does not count toward it (documented
// migration limit).
if (after.agentA.score !== 350) throw new Error(`agentA (spent, never sold) should score 350 under v5, got ${after.agentA.score}`);
if (after.agentA.max_drawdown_yocto !== '0') throw new Error(`agentA drawdown should be 0 (rep starts empty), got ${after.agentA.max_drawdown_yocto}`);
if (after.agentB.score !== 365) throw new Error(`agentB (one losing sell) should score 365 under v5, got ${after.agentB.score}`);
if (after.agentB.max_drawdown_yocto !== '0') throw new Error(`agentB drawdown should be 0 right after migration (rep starts empty), got ${after.agentB.max_drawdown_yocto}`);
if (after.agentB.score >= 600) throw new Error(`agentB (one losing sell) must stay below solid under v5, got ${after.agentB.score}`);
console.log('  [ok] v5 scores sane: A 350 (spent, never sold), B 365 (one losing sell); both drawdowns 0 (rep starts empty at v5)');
eq('battle0', baseline.battle0, after.battle0);
eq('vote0', baseline.vote0, after.vote0);
eq('duel0', baseline.duel0, after.duel0);
// The v4 meme day must survive whole: text and AI score included,
// because v5 reuses the meme_texts / ai_scores storage prefixes.
eq('meme0', baseline.meme0, after.meme0);
eq('follow', baseline.follow, after.follow);
eq('copyPos', baseline.copyPos, after.copyPos);
eq('pool', baseline.pool, after.pool);
eq('season', baseline.season, after.season);
eq('activity', baseline.activity, after.activity);

// migrate() must be one-shot: a second call fails (state is v5 now).
await expectFail(call(ARENA_ID, ARENA_ID, 'migrate', {}), 'second migrate()');
// new() must fail: state already exists.
await expectFail(call(ARENA_ID, ARENA_ID, 'new', {}), 'new() after migrate');

console.log('\n== 4. verify v5 params expose the Sybil threshold and the new reputation weights');
const params = await view(ARENA_ID, 'get_params', {});
console.log('  min_qualified_holding_tokens:', params.min_qualified_holding_tokens,
  '| rep weights:', params.rep_weight_pnl, params.rep_weight_win_rate, params.rep_weight_hold_time,
  params.rep_weight_trade_count, params.rep_weight_drawdown,
  '| volume_full_yocto:', params.volume_full_yocto, '| count_full:', params.count_full);
if (params.min_qualified_holding_tokens !== '10000') throw new Error('min_qualified_holding_tokens is not 10000');
if (params.rep_weight_pnl !== 30 || params.rep_weight_win_rate !== 20 || params.rep_weight_hold_time !== 15
  || params.rep_weight_trade_count !== 15 || params.rep_weight_drawdown !== 20) {
  throw new Error('v5 reputation weights are not 30/20/15/15/20');
}
if (params.volume_full_yocto !== '1000000000000000000000000') throw new Error('volume_full_yocto is not 1 NEAR');
if (params.count_full !== 10) throw new Error('count_full is not 10');
if (params.image_url_max_chars !== 500) throw new Error('v4 image params changed by the v5 migration');
if (params.ai_judge_account !== ARENA_ID || params.ai_weight_bp !== 5000) throw new Error('v3 AI judge params changed by the v5 migration');
console.log('  [ok] v5 params live (threshold 10000, weights 30/20/15/15/20, volume 1 NEAR, count 10)');

console.log('\n== 5. create the extra test accounts as funded sub-accounts (no helper call)');
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

const token0 = baseline.coin0.token_id;
console.log('\n== 6. threshold crossing: a small buy does not qualify, a bigger buy does, selling down unqualifies');
await call(TRADER_C, token0, 'storage_deposit', { account_id: TRADER_C }, '0.01');
let c0 = await view(ARENA_ID, 'get_coin', { coin_id: 0 });
console.log('  coin0 qualified_holders before C buys:', c0.qualified_holders);
if (c0.qualified_holders !== 2) throw new Error('coin0 should have 2 qualified holders before C buys');
// Coin 0 sold is ~1,049,500, so the price is 2e18 per token: 0.001 NEAR
// buys 500 tokens, below the 10,000 threshold.
await call(TRADER_C, ARENA_ID, 'buy', { coin_id: 0 }, '0.001');
await sleep(2000);
c0 = await view(ARENA_ID, 'get_coin', { coin_id: 0 });
console.log('  after C buys 0.001 NEAR: holders', c0.holders, 'qualified', c0.qualified_holders);
if (c0.qualified_holders !== 2) throw new Error('a below-threshold buy must not qualify a holder');
if (c0.holders !== 3) throw new Error('raw holder count should be 3 after C buys');
// 0.02 NEAR more buys 10,000 tokens, taking C to ~10,500: above the threshold.
await call(TRADER_C, ARENA_ID, 'buy', { coin_id: 0 }, '0.02');
await sleep(2000);
c0 = await view(ARENA_ID, 'get_coin', { coin_id: 0 });
console.log('  after C buys 0.02 NEAR more: qualified', c0.qualified_holders);
if (c0.qualified_holders !== 3) throw new Error('crossing the threshold upward must qualify the holder');
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
if (c0.qualified_holders !== 2) throw new Error('selling down below the threshold must unqualify the holder');
if (c0.holders !== 3) throw new Error('raw holder count must stay 3 after C sells (holders are never removed)');
// C sold at a small loss (the 1% trading fee), so C's v5 drawdown
// record is now positive: the drawdown tracker works on live sells.
const agentC = await view(ARENA_ID, 'get_agent', { account: TRADER_C });
console.log('  agentC after the losing sell: score', agentC.score, 'max_drawdown_yocto', agentC.max_drawdown_yocto);
if (BigInt(agentC.max_drawdown_yocto) <= 0n) throw new Error('C sold at a loss, so max_drawdown_yocto must be positive');
console.log('  [ok] threshold crossing works both ways; raw holder count and qualified count diverge as designed');

console.log('\n== 7. milestones count qualified holders, not raw wallets');
console.log('  coin0 has 3 raw holders and 2 qualified; adding 7 small holders takes it to 10 raw, still 2 qualified.');
for (const s of SMALL) {
  await call(s, token0, 'storage_deposit', { account_id: s }, '0.01');
  await call(s, ARENA_ID, 'buy', { coin_id: 0 }, '0.001');
  await sleep(1500);
}
c0 = await view(ARENA_ID, 'get_coin', { coin_id: 0 });
console.log('  coin0 holders:', c0.holders, 'qualified:', c0.qualified_holders,
  '| milestones_fired:', JSON.stringify(c0.milestones_fired), '| burned_tokens:', c0.burned_tokens);
if (c0.holders !== 10) throw new Error(`expected 10 raw holders, got ${c0.holders}`);
if (c0.qualified_holders !== 2) throw new Error(`expected 2 qualified holders, got ${c0.qualified_holders}`);
if (c0.milestones_fired.length !== 0) throw new Error('the 10-holder milestone must NOT fire with only 2 qualified holders');
if (c0.burned_tokens !== '0') throw new Error('no burn should have happened with only 2 qualified holders');
console.log('  [ok] 10 raw holders, 2 qualified: the 10-holder milestone did not fire — a Sybil farm of empty wallets cannot trigger it');

console.log('\n== 8. v4 methods still work after the v5 migration');
const poolBefore = await view(ARENA_ID, 'get_prize_pool', {});
await call(TRADER_B, ARENA_ID, 'buy', { coin_id: 0 }, '0.1');
await sleep(2000);
const poolAfter = await view(ARENA_ID, 'get_prize_pool', {});
console.log('  prize pool before/after a 0.1 NEAR buy:', poolBefore, '->', poolAfter);
if (BigInt(poolAfter) <= BigInt(poolBefore)) throw new Error('trading fee did not accrue after v5 migration');
// The v4 follow's max total (0.15 NEAR) is already 0.1 NEAR used, so
// a second 0.1 NEAR copy_buy would exceed the cap (correct
// enforcement, not a v5 bug). Prove the copy path with a copy_sell
// instead, which also exercises the v5 drawdown recording on copy sells.
const copyBefore = await view(ARENA_ID, 'get_copy_position', { copier: TRADER_B, leader: TRADER_A, coin_id: 0 });
await call(TRADER_B, ARENA_ID, 'copy_sell', { coin_id: 0, leader: TRADER_A, tokens: '10000' });
await sleep(2000);
const copyPos = await view(ARENA_ID, 'get_copy_position', { copier: TRADER_B, leader: TRADER_A, coin_id: 0 });
console.log('  copy position after copy_sell:', copyPos.tokens, '(was', copyBefore.tokens, ')');
if (BigInt(copyPos.tokens) !== BigInt(copyBefore.tokens) - 10000n) throw new Error('copy_sell did not work after v5 migration');
const agentB2 = await view(ARENA_ID, 'get_agent', { account: TRADER_B });
console.log('  agentB after v5 trades: score', agentB2.score, 'max_drawdown_yocto', agentB2.max_drawdown_yocto);

console.log('\nMIGRATION TEST OK — v4 state survived migrate() on', ARENA_ID,
  'and all v5 Sybil + reputation behaviour works. Safe to migrate pac-arena.testnet the same way.');
