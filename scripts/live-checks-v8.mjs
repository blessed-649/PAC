// Live v8 checks on testnet (small amounts, demo wallets only).
// 1. Launch a fresh test coin as holder (2 NEAR launch + 0.01 initial buy)
//    and sell the ENTIRE initial-buy position back — the H-01 sole-buyer
//    round-trip, which v7 rejected.
// 2. Duel: create for pair (0,1) must FAIL (active duels exist);
//    create for pair (0,2) as degen (DEGEN holder) must SUCCEED.
// 3. Resolve duel 0 now must FAIL (window not over, ends 13:53 UTC).
// 4. Resolve meme day 0 coin 0 now must FAIL (day not over, ends 13:45 UTC).
// 5. Season 2965 ends 2026-11-09 00:00 UTC — NOT due; no resolve attempted.
// Every call result and tx hash is printed. Any unexpected success/failure
// throws and stops the script.
import fs from 'node:fs';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';

const ACCOUNTS_FILE = new URL('../.testnet-accounts.json', import.meta.url);
const ARENA_ID = 'pac-arena.testnet';
const RPC = 'https://rpc.testnet.fastnear.com';
const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));

async function acct(role) {
  const ks = new keyStores.InMemoryKeyStore();
  await ks.setKey('testnet', accounts[role].accountId, KeyPair.fromString(accounts[role].privateKey));
  const near = await connect({ networkId: 'testnet', nodeUrl: RPC, walletUrl: 'https://testnet.mynearwallet.com/', helperUrl: 'https://helper.testnet.near.org', keyStore: ks });
  return near.account(accounts[role].accountId);
}
const holder = await acct('holder');
const degen = await acct('degen');
const arena = holder; // view calls via any account
const view = (m, a = {}) => arena.viewFunction({ contractId: ARENA_ID, methodName: m, args: a });
const fmt = (y) => utils.format.formatNearAmount(String(y));

async function expectFail(label, fn, needle) {
  try {
    const r = await fn();
    throw new Error(`${label}: UNEXPECTED SUCCESS (tx ${r?.transaction?.hash})`);
  } catch (e) {
    const msg = String(e.message || e);
    if (needle && !msg.includes(needle)) throw new Error(`${label}: failed but with unexpected error: ${msg.slice(0, 300)}`);
    console.log(`  [ok] ${label} failed as expected: ${msg.slice(0, 180)}`);
  }
}

// --- 1. Launch test coin as holder ---
console.log('== 1. launch + sole-buyer round-trip ==');
const beforeStats = await view('get_stats', {});
const newCoinId = beforeStats.coins;
console.log('  next coin id:', newCoinId);
const launch = await holder.functionCall({
  contractId: ARENA_ID, methodName: 'launch_coin',
  args: { name: 'V8 Test Coin', symbol: 'V8T', description: 'Migration v8 sole-buyer round-trip test coin', initial_buy_yocto: utils.format.parseNearAmount('0.01'), image_url: null },
  gas: 200_000_000_000_000n, attachedDeposit: utils.format.parseNearAmount('2.01'),
});
console.log('  launch tx:', launch.transaction.hash);
const coin = await view('get_coin', { coin_id: newCoinId });
console.log('  coin:', coin.name, coin.symbol, 'sold', coin.sold_tokens, 'reserve', fmt(coin.near_reserve_yocto), 'creator', coin.creator);
const tokenId = `c${newCoinId}.${ARENA_ID}`;
const bal = await holder.viewFunction({ contractId: tokenId, methodName: 'ft_balance_of', args: { account_id: accounts.holder.accountId } });
console.log('  holder token balance:', bal, '(whole tokens:', BigInt(bal) / 10n ** 18n, ')');
// New coin must run the NEW token WASM (transfer sync): compare code hashes with coin 0's old token.
const provider = holder.connection.provider;
const codeNew = await provider.query({ request_type: 'view_code', account_id: tokenId, finality: 'final' });
const codeOld = await provider.query({ request_type: 'view_code', account_id: `c0.${ARENA_ID}`, finality: 'final' });
console.log('  new token code hash:', codeNew.hash, '| old coin0 token code hash:', codeOld.hash);
if (codeNew.hash === codeOld.hash) throw new Error('new coin token WASM is identical to the old one — transfer sync NOT deployed');
console.log('  [ok] new coin runs the new token WASM');

// Sell the entire position back.
const sell = await holder.functionCall({
  contractId: tokenId, methodName: 'ft_transfer_call',
  args: { receiver_id: ARENA_ID, amount: bal, msg: 'sell' },
  gas: 100_000_000_000_000n, attachedDeposit: 1n,
});
console.log('  sell-all tx:', sell.transaction.hash);
const coinAfter = await view('get_coin', { coin_id: newCoinId });
const balAfter = await holder.viewFunction({ contractId: tokenId, methodName: 'ft_balance_of', args: { account_id: accounts.holder.accountId } });
console.log('  after sell: sold', coinAfter.sold_tokens, 'reserve', fmt(coinAfter.near_reserve_yocto), 'holder balance', balAfter);
if (balAfter !== '0' && BigInt(balAfter) >= 10n ** 18n) throw new Error('holder still holds >= 1 whole token after selling all');
console.log('  [ok] SOLE-BUYER ROUND-TRIP WORKS — full position sold back under v8 (v7 rejected this)');

// --- 2. Duels ---
console.log('== 2. coin duels ==');
await expectFail('create duel (0,1) with active duels', () => degen.functionCall({
  contractId: ARENA_ID, methodName: 'create_coin_duel', args: { coin_a: 0, coin_b: 1 },
  gas: 100_000_000_000_000n, attachedDeposit: 0n,
}), 'an active duel already exists');
const duel = await degen.functionCall({
  contractId: ARENA_ID, methodName: 'create_coin_duel', args: { coin_a: 0, coin_b: 2 },
  gas: 100_000_000_000_000n, attachedDeposit: 0n,
});
console.log('  create duel (0,2) tx:', duel.transaction.hash);
const duels = await view('list_coin_duels', { from_index: 10, limit: 5 });
console.log('  new duel:', JSON.stringify(duels));
if (!duels.some((d) => d.coin_a === 0 && d.coin_b === 2 && d.status === 0)) throw new Error('new duel (0,2) not found/active');
console.log('  [ok] one duel per pair enforced, new pair allowed');

// --- 3. Early duel resolve must fail ---
console.log('== 3. early duel resolve ==');
await expectFail('resolve duel 0 before window ends', () => degen.functionCall({
  contractId: ARENA_ID, methodName: 'resolve_coin_duel', args: { duel_id: 0 },
  gas: 100_000_000_000_000n, attachedDeposit: 0n,
}), 'duel window not over');

// --- 4. Early meme-day resolve must fail ---
console.log('== 4. early meme-day resolve ==');
await expectFail('resolve meme day 0 coin 0 before day ends', () => holder.functionCall({
  contractId: ARENA_ID, methodName: 'resolve_meme_day', args: { coin_id: 0, day: 0 },
  gas: 100_000_000_000_000n, attachedDeposit: 0n,
}), 'day not over yet');

// --- 5. Season not due ---
console.log('== 5. season ==');
const season = await view('get_current_season', {});
console.log('  season', season.id, 'ends', new Date(Number(BigInt(season.end_ns) / 1000000n)).toISOString(), 'status', season.status, '— NOT due, no resolve attempted');
if (Date.now() * 1e6 >= Number(BigInt(season.end_ns))) throw new Error('season IS due — re-check before resolving');

console.log('\nALL LIVE CHECKS PASSED');
console.log('launch tx:', launch.transaction.hash);
console.log('sell tx:', sell.transaction.hash);
console.log('duel create tx:', duel.transaction.hash);
