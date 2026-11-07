// PAC v4 migration proof (fresh testnet deployment).
// Deploys the OLD (v3) arena WASM to a fresh testnet account, builds
// state on it (launch, buys, sell, battle create + accept, vote round +
// votes, meme submit WITH text + vote + an AI score recorded by the
// judge, coin duel, follow), then deploys the NEW (v4) WASM to the SAME
// account, calls migrate(), and verifies every piece of old state
// survives AND the new v4 methods work (launch with an image URL,
// set_coin_image by the creator only, URL validation, coin views carry
// image_url). The v3 meme texts and AI scores are part of the baseline:
// the v4 migrate() reuses their storage prefixes, so they must survive
// too. Only after this prints MIGRATION TEST OK may the live arena
// pac-arena.testnet be migrated the same way.
// Keys are written ONLY to /tmp/pac-migration-v4-accounts.json (chmod 600).
// Run: node scripts/test-migration-v4.mjs
import fs from 'node:fs';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';

const OLD_WASM = '/tmp/pac-arena-v3.wasm';
const NEW_WASM = new URL('../target/near/pac_arena/pac_arena.wasm', import.meta.url);
const RPC = 'https://rpc.testnet.fastnear.com';
const HELPER = 'https://helper.testnet.near.org/account';
const OUT = '/tmp/pac-migration-v4-accounts.json';
const parseNear = (n) => utils.format.parseNearAmount(n);

const suffix = Date.now().toString(36);
const ARENA_ID = `pac-mig4-${suffix}a.testnet`;
const TRADER_A = `pac-mig4-${suffix}b.testnet`;
const TRADER_B = `pac-mig4-${suffix}c.testnet`;

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

console.log('\n== 1. deploy OLD (v3) WASM to fresh arena', ARENA_ID);
const oldWasm = fs.readFileSync(OLD_WASM);
console.log('  old wasm bytes:', oldWasm.length);
await withRetry(() => acct(ARENA_ID).then((a) => a.deployContract(oldWasm)), 'deploy old');
await call(ARENA_ID, ARENA_ID, 'new', {});
console.log('  v3 initialised');
const v3params = await view(ARENA_ID, 'get_params', {});
if (!('ai_weight_bp' in v3params)) throw new Error('old wasm has no v3 AI params?!');
if ('image_url_max_chars' in v3params) throw new Error('old wasm already has v4 image params?!');
console.log('  confirmed v3 params (ai_weight_bp present, no image_url_max_chars)');

console.log('\n== 2. build v3 state: launch, buys, sell, battle, vote, meme + AI score, duel, follow');
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
if (!coin0) throw new Error('coin 0 never appeared on v3');
const token0 = coin0.token_id;
console.log('  coin 0:', token0, '| sold', coin0.sold_tokens, '| image_url', coin0.image_url);
if (coin0.image_url !== undefined && coin0.image_url !== null) throw new Error('v3 coin view should have no image_url field');
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
// v3 meme with text, plus an AI score recorded by the judge (arena).
// These live in the meme_texts / ai_scores collections, so they are
// part of the migration baseline: v4 must preserve them.
await call(TRADER_A, ARENA_ID, 'submit_meme', {
  coin_id: 0, meme_hash: 'QmMigMemeV3',
  meme_text: 'When the bonding curve goes up but your bags are still down.',
});
await call(TRADER_B, ARENA_ID, 'vote_meme', { coin_id: 0, day: 0, submission_index: 0 });
await sleep(2000);
await call(ARENA_ID, ARENA_ID, 'record_ai_score', {
  coin_id: 0, day: 0, submission_index: 0,
  humor: 85, originality: 75, relevance: 95, attestation_hash: 'c'.repeat(64),
});
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
if (!coin1) throw new Error('coin 1 never appeared on v3');
await call(TRADER_A, ARENA_ID, 'create_coin_duel', { coin_a: 0, coin_b: 1 });
await sleep(2000);
await call(TRADER_B, ARENA_ID, 'follow', {
  leader: TRADER_A, amount_per_trade_yocto: parseNear('0.1'),
  max_total_yocto: parseNear('0.15'), copy_public_key: null,
});
await sleep(2000);

// Snapshot the full v3 state for the post-migration comparison.
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
console.log('  v3 baseline:', JSON.stringify(baseline.stats), '| coin0 sold', baseline.coin0.sold_tokens,
  '| activity events', baseline.activity.length, '| pool', baseline.pool,
  '| meme0 AI total', baseline.meme0.submissions[0].ai_score.total);

console.log('\n== 3. deploy NEW (v4) WASM to the SAME account (no new())');
const newWasm = fs.readFileSync(NEW_WASM);
console.log('  new wasm bytes:', newWasm.length);
await withRetry(() => acct(ARENA_ID).then((a) => a.deployContract(newWasm)), 'deploy new');
console.log('  v4 WASM deployed over v3 state');

console.log('\n== 4. call migrate()');
await call(ARENA_ID, ARENA_ID, 'migrate', {}, '0', 100_000_000_000_000n);
console.log('  migrate() succeeded');

console.log('\n== 5. verify every piece of v3 state survived');
function eq(label, a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} CHANGED:\n  before: ${JSON.stringify(a)}\n  after:  ${JSON.stringify(b)}`);
  console.log(`  [ok] ${label} unchanged`);
}
// Coin views gain exactly one new field (image_url, null for v3 coins);
// every other field must be identical.
function eqCoin(label, before, after) {
  const b = { ...before };
  const a = { ...after };
  if (a.image_url !== null) throw new Error(`${label} image_url should be null after migration, got ${JSON.stringify(a.image_url)}`);
  delete a.image_url;
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} CHANGED:\n  before: ${JSON.stringify(b)}\n  after:  ${JSON.stringify(a)}`);
  console.log(`  [ok] ${label} unchanged (image_url null as expected)`);
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
eqCoin('coin0', baseline.coin0, after.coin0);
eqCoin('coin1', baseline.coin1, after.coin1);
eq('agentA', baseline.agentA, after.agentA);
eq('agentB', baseline.agentB, after.agentB);
eq('battle0', baseline.battle0, after.battle0);
eq('vote0', baseline.vote0, after.vote0);
eq('duel0', baseline.duel0, after.duel0);
// The v3 meme day must survive whole: text and AI score included,
// because v4 reuses the meme_texts / ai_scores storage prefixes.
eq('meme0', baseline.meme0, after.meme0);
eq('follow', baseline.follow, after.follow);
eq('pool', baseline.pool, after.pool);
eq('activity', baseline.activity, after.activity);

// migrate() must be one-shot: a second call fails (state is v4 now).
await expectFail(call(ARENA_ID, ARENA_ID, 'migrate', {}), 'second migrate()');
// new() must fail: state already exists.
await expectFail(call(ARENA_ID, ARENA_ID, 'new', {}), 'new() after migrate');

console.log('\n== 6. verify v4 coin image methods work on the migrated state');
const params = await view(ARENA_ID, 'get_params', {});
console.log('  image_url_max_chars:', params.image_url_max_chars);
if (params.image_url_max_chars !== 500) throw new Error('image_url_max_chars is not 500');
if (params.ai_judge_account !== ARENA_ID || params.ai_weight_bp !== 5000) throw new Error('v3 AI judge params changed by the v4 migration');

// A launch WITH an image URL (v4 signature) stores it on the coin.
const imgUrl = 'https://picsum.photos/seed/mig4-coin/256';
await call(TRADER_B, ARENA_ID, 'launch_coin', {
  name: 'Mig Three', symbol: 'MIG3', description: 'third migration test coin',
  initial_buy_yocto: parseNear('0.5'), image_url: imgUrl,
}, '2.5', 300_000_000_000_000n);
let coin2 = null;
for (let i = 0; i < 20; i++) {
  await sleep(3000);
  coin2 = await view(ARENA_ID, 'get_coin', { coin_id: 2 });
  if (coin2) break;
}
if (!coin2) throw new Error('coin 2 never appeared on v4');
console.log('  coin 2 image_url:', coin2.image_url);
if (coin2.image_url !== imgUrl) throw new Error('launch image_url was not stored');
// A launch with no image reads back null.
await call(TRADER_A, ARENA_ID, 'launch_coin', {
  name: 'Mig Four', symbol: 'MIG4', description: 'fourth migration test coin',
  initial_buy_yocto: parseNear('0.5'), image_url: null,
}, '2.5', 300_000_000_000_000n);
let coin3 = null;
for (let i = 0; i < 20; i++) {
  await sleep(3000);
  coin3 = await view(ARENA_ID, 'get_coin', { coin_id: 3 });
  if (coin3) break;
}
if (!coin3) throw new Error('coin 3 never appeared on v4');
if (coin3.image_url !== null) throw new Error('launch with null image_url should read back null');
console.log('  [ok] launch with and without an image URL both store correctly');

// Bad image URLs are rejected at launch.
await expectFail(call(TRADER_A, ARENA_ID, 'launch_coin', {
  name: 'Bad Url', symbol: 'BAD', description: 'bad url coin',
  initial_buy_yocto: parseNear('0.5'), image_url: 'ftp://example.com/coin.png',
}, '2.5', 300_000_000_000_000n), 'launch with an ftp:// image URL');
await expectFail(call(TRADER_A, ARENA_ID, 'launch_coin', {
  name: 'Long Url', symbol: 'LONG', description: 'long url coin',
  initial_buy_yocto: parseNear('0.5'), image_url: 'https://example.com/' + 'a'.repeat(500),
}, '2.5', 300_000_000_000_000n), 'launch with an over-long image URL');

// set_coin_image: the creator (TRADER_A launched coin 0) can set it,
// anyone else cannot, and bad URLs are rejected.
const creatorImg = 'https://picsum.photos/seed/mig4-creator/256';
await call(TRADER_A, ARENA_ID, 'set_coin_image', { coin_id: 0, image_url: creatorImg });
await sleep(2000);
coin0 = await view(ARENA_ID, 'get_coin', { coin_id: 0 });
console.log('  coin 0 image_url after set_coin_image:', coin0.image_url);
if (coin0.image_url !== creatorImg) throw new Error('set_coin_image did not store the URL');
await expectFail(call(TRADER_B, ARENA_ID, 'set_coin_image', {
  coin_id: 0, image_url: 'https://picsum.photos/seed/mig4-other/256',
}), 'set_coin_image by a non-creator');
await expectFail(call(TRADER_A, ARENA_ID, 'set_coin_image', {
  coin_id: 0, image_url: 'ipfs://QmHash',
}), 'set_coin_image with an ipfs:// URL');
// Clearing with null works.
await call(TRADER_A, ARENA_ID, 'set_coin_image', { coin_id: 0, image_url: null });
await sleep(2000);
coin0 = await view(ARENA_ID, 'get_coin', { coin_id: 0 });
if (coin0.image_url !== null) throw new Error('clearing the image with null did not work');
console.log('  [ok] set_coin_image: creator only, URL validated, null clears');

// v3 methods still work after the v4 migration: a buy still accrues
// the 1% trading fee, and the pre-migration follow still copy-buys.
const poolBefore = await view(ARENA_ID, 'get_prize_pool', {});
await call(TRADER_B, ARENA_ID, 'buy', { coin_id: 0 }, '0.1');
await sleep(2000);
const poolAfter = await view(ARENA_ID, 'get_prize_pool', {});
console.log('  prize pool before/after a 0.1 NEAR buy:', poolBefore, '->', poolAfter);
if (BigInt(poolAfter) <= BigInt(poolBefore)) throw new Error('trading fee did not accrue after v4 migration');
await call(TRADER_A, token0, 'storage_deposit', { account_id: TRADER_A }, '0.01');
await call(TRADER_A, ARENA_ID, 'buy', { coin_id: 0 }, '0.05');
await sleep(2000);
await call(TRADER_B, ARENA_ID, 'copy_buy', { coin_id: 0, leader: TRADER_A }, '0.1');
await sleep(2000);
const copyPos = await view(ARENA_ID, 'get_copy_position', { copier: TRADER_B, leader: TRADER_A, coin_id: 0 });
console.log('  copy position after copy_buy:', copyPos.tokens);
if (BigInt(copyPos.tokens) <= 0n) throw new Error('copy_buy did not work after v4 migration');

console.log('\nMIGRATION TEST OK — v3 state survived migrate() on', ARENA_ID,
  'and all v4 coin image methods work. Safe to migrate pac-arena.testnet the same way.');
