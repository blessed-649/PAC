// PAC v3 migration proof (fresh testnet deployment).
// Deploys the OLD (v2) arena WASM to a fresh testnet account, builds
// state on it (launch, buys, sell, battle create + accept, vote round +
// votes, meme submit + vote, coin duel, follow), then deploys the NEW
// (v3) WASM to the SAME account, calls migrate(), and verifies every
// piece of old state survives AND the new v3 methods work (meme text,
// AI score recording by the judge only, score ranges, combined winner
// params, v2 copy and prize pool still working).
// Only after this prints MIGRATION TEST OK may the live arena
// pac-arena.testnet be migrated the same way.
// Keys are written ONLY to /tmp/pac-migration-v3-accounts.json (chmod 600).
// Run: node scripts/test-migration-v3.mjs
import fs from 'node:fs';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';

const OLD_WASM = '/tmp/pac-arena-v2.wasm';
const NEW_WASM = new URL('../target/near/pac_arena/pac_arena.wasm', import.meta.url);
const RPC = 'https://rpc.testnet.fastnear.com';
const HELPER = 'https://helper.testnet.near.org/account';
const OUT = '/tmp/pac-migration-v3-accounts.json';
const parseNear = (n) => utils.format.parseNearAmount(n);

const suffix = Date.now().toString(36);
const ARENA_ID = `pac-mig3-${suffix}a.testnet`;
const TRADER_A = `pac-mig3-${suffix}b.testnet`;
const TRADER_B = `pac-mig3-${suffix}c.testnet`;

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

console.log('\n== 1. deploy OLD (v2) WASM to fresh arena', ARENA_ID);
const oldWasm = fs.readFileSync(OLD_WASM);
console.log('  old wasm bytes:', oldWasm.length);
await withRetry(() => acct(ARENA_ID).then((a) => a.deployContract(oldWasm)), 'deploy old');
await call(ARENA_ID, ARENA_ID, 'new', {});
console.log('  v2 initialised');
const v2params = await view(ARENA_ID, 'get_params', {});
if (!('trading_fee_bp' in v2params)) throw new Error('old wasm has no v2 params?!');
if ('ai_weight_bp' in v2params) throw new Error('old wasm already has v3 AI params?!');
console.log('  confirmed v2 params (trading_fee_bp present, no ai_weight_bp)');

console.log('\n== 2. build v2 state: launch, buys, sell, battle, vote, meme, duel, follow');
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
if (!coin0) throw new Error('coin 0 never appeared on v2');
const token0 = coin0.token_id;
console.log('  coin 0:', token0, '| sold', coin0.sold_tokens);
await call(TRADER_B, token0, 'storage_deposit', { account_id: TRADER_B }, '0.01');
await call(TRADER_A, token0, 'storage_deposit', { account_id: TRADER_A }, '0.01');
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
// v2 submit_meme takes only (coin_id, meme_hash) — no text yet.
await call(TRADER_A, ARENA_ID, 'submit_meme', { coin_id: 0, meme_hash: 'QmMigMeme001' });
await call(TRADER_B, ARENA_ID, 'vote_meme', { coin_id: 0, day: 0, submission_index: 0 });
await sleep(2000);
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
if (!coin1) throw new Error('coin 1 never appeared on v2');
await call(TRADER_A, ARENA_ID, 'create_coin_duel', { coin_a: 0, coin_b: 1 });
await sleep(2000);
// A v2 follow, so the v2 copy state is part of the migration baseline.
await call(TRADER_B, ARENA_ID, 'follow', {
  leader: TRADER_A, amount_per_trade_yocto: parseNear('0.1'),
  max_total_yocto: parseNear('0.15'), copy_public_key: null,
});
await sleep(2000);

// Snapshot the full v2 state for the post-migration comparison.
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
  follow: await view(ARENA_ID, 'get_follow', { copier: TRADER_B, leader: TRADER_A }),
  pool: await view(ARENA_ID, 'get_prize_pool', {}),
  activity: await view(ARENA_ID, 'get_activity', { limit: 100 }),
};
console.log('  v2 baseline:', JSON.stringify(baseline.stats), '| coin0 sold', baseline.coin0.sold_tokens,
  '| activity events', baseline.activity.length, '| pool', baseline.pool);

console.log('\n== 3. deploy NEW (v3) WASM to the SAME account (no new())');
const newWasm = fs.readFileSync(NEW_WASM);
console.log('  new wasm bytes:', newWasm.length);
await withRetry(() => acct(ARENA_ID).then((a) => a.deployContract(newWasm)), 'deploy new');
console.log('  v3 WASM deployed over v2 state');

console.log('\n== 4. call migrate()');
await call(ARENA_ID, ARENA_ID, 'migrate', {}, '0', 100_000_000_000_000n);
console.log('  migrate() succeeded');

console.log('\n== 5. verify every piece of v2 state survived');
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
  follow: await view(ARENA_ID, 'get_follow', { copier: TRADER_B, leader: TRADER_A }),
  pool: await view(ARENA_ID, 'get_prize_pool', {}),
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
// The v3 view adds meme_text and ai_score (both null for old entries);
// the v2 data itself must be identical, and the new fields must be null.
{
  const b = baseline.meme0, a = after.meme0;
  if (a.coin_id !== b.coin_id || a.day !== b.day || a.voters !== b.voters
    || a.resolved !== b.resolved || a.winner_hash !== b.winner_hash || a.winner !== b.winner) {
    throw new Error(`meme0 day fields CHANGED:\n  before: ${JSON.stringify(b)}\n  after:  ${JSON.stringify(a)}`);
  }
  if (a.submissions.length !== b.submissions.length) throw new Error('meme0 submissions count CHANGED');
  for (let i = 0; i < b.submissions.length; i++) {
    const bs = b.submissions[i], as = a.submissions[i];
    if (as.submitter !== bs.submitter || as.meme_hash !== bs.meme_hash || as.votes !== bs.votes) {
      throw new Error(`meme0 submission ${i} CHANGED`);
    }
    if (as.meme_text !== null || as.ai_score !== null) {
      throw new Error(`meme0 submission ${i} should have null text and score`);
    }
  }
  console.log('  [ok] meme0 v2 data unchanged (new meme_text and ai_score fields are null)');
}
eq('follow', baseline.follow, after.follow);
eq('pool', baseline.pool, after.pool);
eq('activity', baseline.activity, after.activity);

// migrate() must be one-shot: a second call fails (state is v3 now).
await expectFail(call(ARENA_ID, ARENA_ID, 'migrate', {}), 'second migrate()');
// new() must fail: state already exists.
await expectFail(call(ARENA_ID, ARENA_ID, 'new', {}), 'new() after migrate');

console.log('\n== 6. verify v3 AI judge methods work on the migrated state');
const params = await view(ARENA_ID, 'get_params', {});
console.log('  ai params:', JSON.stringify({
  ai_judge_account: params.ai_judge_account,
  ai_weight_bp: params.ai_weight_bp,
  community_weight_bp: params.community_weight_bp,
  meme_text_max_chars: params.meme_text_max_chars,
}));
if (params.ai_judge_account !== ARENA_ID) throw new Error('ai_judge_account is not the arena account');
if (params.ai_weight_bp !== 5000 || params.community_weight_bp !== 5000) throw new Error('AI/community weights are not 50/50');
if (params.meme_text_max_chars !== 500) throw new Error('meme_text_max_chars is not 500');

// A new meme submission WITH text (v3 signature) stores the text.
await call(TRADER_B, ARENA_ID, 'submit_meme', {
  coin_id: 0, meme_hash: 'QmMigMemeText002',
  meme_text: 'When the bonding curve goes up but your bags are still down.',
});
await sleep(2000);
let day0 = await view(ARENA_ID, 'get_meme_day', { coin_id: 0, day: 0 });
const textSub = day0.submissions.find((s) => s.meme_hash === 'QmMigMemeText002');
console.log('  submission with text:', JSON.stringify(textSub));
if (!textSub || textSub.meme_text !== 'When the bonding curve goes up but your bags are still down.') {
  throw new Error('meme_text was not stored on the new submission');
}
// The old v2 submission (no text) still reads fine, with null text.
const oldSub = day0.submissions.find((s) => s.meme_hash === 'QmMigMeme001');
if (!oldSub || oldSub.meme_text !== null) throw new Error('old v2 submission text should be null');
console.log('  [ok] old v2 submission reads with null text, new one carries its text');

// Only the arena account (the judge) can record AI scores.
await expectFail(
  call(TRADER_A, ARENA_ID, 'record_ai_score', {
    coin_id: 0, day: 0, submission_index: 0,
    humor: 80, originality: 70, relevance: 90,
    attestation_hash: 'aa'.repeat(32),
  }),
  'record_ai_score from a non-judge account',
);
// Out-of-range scores fail even from the judge.
await expectFail(
  call(ARENA_ID, ARENA_ID, 'record_ai_score', {
    coin_id: 0, day: 0, submission_index: 0,
    humor: 101, originality: 70, relevance: 90,
    attestation_hash: 'aa'.repeat(32),
  }),
  'record_ai_score with humor 101',
);
// The judge (arena account) records a score for the text submission.
const attHash = 'b'.repeat(64);
await call(ARENA_ID, ARENA_ID, 'record_ai_score', {
  coin_id: 0, day: 0, submission_index: 1,
  humor: 85, originality: 75, relevance: 95, attestation_hash: attHash,
});
await sleep(2000);
day0 = await view(ARENA_ID, 'get_meme_day', { coin_id: 0, day: 0 });
const scored = day0.submissions[1];
console.log('  scored submission:', JSON.stringify(scored.ai_score));
if (!scored.ai_score || scored.ai_score.total !== 255) throw new Error('AI total should be 85+75+95 = 255');
if (scored.ai_score.attestation_hash !== attHash) throw new Error('attestation hash mismatch');
// The unscored submission has no AI score.
if (day0.submissions[0].ai_score !== null) throw new Error('unscored submission should have null ai_score');
console.log('  [ok] AI score recorded by the judge only, total 255, attestation hash stored');

// v2 methods still work after the v3 migration: a buy still accrues
// the 1% trading fee, and the pre-migration follow still copy-buys.
const poolBefore = await view(ARENA_ID, 'get_prize_pool', {});
await call(TRADER_B, ARENA_ID, 'buy', { coin_id: 0 }, '0.1');
await sleep(2000);
const poolAfter = await view(ARENA_ID, 'get_prize_pool', {});
console.log('  prize pool before/after a 0.1 NEAR buy:', poolBefore, '->', poolAfter);
if (BigInt(poolAfter) <= BigInt(poolBefore)) throw new Error('trading fee did not accrue after v3 migration');
await call(TRADER_A, token0, 'storage_deposit', { account_id: TRADER_A }, '0.01');
await call(TRADER_A, ARENA_ID, 'buy', { coin_id: 0 }, '0.05');
await sleep(2000);
await call(TRADER_B, ARENA_ID, 'copy_buy', { coin_id: 0, leader: TRADER_A }, '0.1');
await sleep(2000);
const copyPos = await view(ARENA_ID, 'get_copy_position', { copier: TRADER_B, leader: TRADER_A, coin_id: 0 });
console.log('  copy position after copy_buy:', copyPos.tokens);
if (BigInt(copyPos.tokens) <= 0n) throw new Error('copy_buy did not work after v3 migration');

console.log('\nMIGRATION TEST OK — v2 state survived migrate() on', ARENA_ID,
  'and all v3 AI judge methods work. Safe to migrate pac-arena.testnet the same way.');
