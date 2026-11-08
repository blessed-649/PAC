// Live v8 checks, part 2 (coin 4 already launched by holder in part 1).
// 1. Degen (not the creator, so no lock) buys 0.05 NEAR of V8T (coin 4)
//    and sells the ENTIRE position back — the true H-01 sole-buyer
//    round-trip: under v7 the sell would revert (reserve short by the fee).
// 2. Duel: create (0,1) must FAIL; create (0,2) as degen must SUCCEED.
// 3. Resolve duel 0 now must FAIL (window ends 13:53 UTC).
// 4. Resolve meme day 0 coin 0 now must FAIL (day ends 13:45 UTC).
// 5. Season 2965 ends 2026-11-09 00:00 UTC — NOT due; no resolve attempted.
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
const view = (m, a = {}) => holder.viewFunction({ contractId: ARENA_ID, methodName: m, args: a });
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

console.log('== 1. sole-buyer round-trip (degen, coin 4 V8T) ==');
const balBefore = await degen.getAccountBalance();
console.log('  degen NEAR before:', fmt(balBefore.available));
const buy = await degen.functionCall({
  contractId: ARENA_ID, methodName: 'buy', args: { coin_id: 4 },
  gas: 150_000_000_000_000n, attachedDeposit: utils.format.parseNearAmount('0.05'),
});
console.log('  buy tx:', buy.transaction.hash);
const tokenId = 'c4.pac-arena.testnet';
const bal = await degen.viewFunction({ contractId: tokenId, methodName: 'ft_balance_of', args: { account_id: accounts.degen.accountId } });
const coinMid = await view('get_coin', { coin_id: 4 });
console.log('  degen token balance:', bal, '(whole:', BigInt(bal) / 10n ** 18n, ') | sold', coinMid.sold_tokens, '| reserve', fmt(coinMid.near_reserve_yocto));
const sell = await degen.functionCall({
  contractId: tokenId, methodName: 'ft_transfer_call',
  args: { receiver_id: ARENA_ID, amount: bal, msg: 'sell' },
  gas: 100_000_000_000_000n, attachedDeposit: 1n,
});
console.log('  sell-all tx:', sell.transaction.hash);
const balAfter = await degen.viewFunction({ contractId: tokenId, methodName: 'ft_balance_of', args: { account_id: accounts.degen.accountId } });
const coinAfter = await view('get_coin', { coin_id: 4 });
const balAfterNear = await degen.getAccountBalance();
console.log('  after sell: token balance', balAfter, '| sold', coinAfter.sold_tokens, '| reserve', fmt(coinAfter.near_reserve_yocto), '| degen NEAR', fmt(balAfterNear.available));
if (BigInt(balAfter) >= 10n ** 18n) throw new Error('degen still holds >= 1 whole token after selling all');
console.log('  [ok] SOLE-BUYER ROUND-TRIP WORKS under v8 (v7 rejected this sell)');

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

console.log('== 3. early duel resolve ==');
await expectFail('resolve duel 0 before window ends', () => degen.functionCall({
  contractId: ARENA_ID, methodName: 'resolve_coin_duel', args: { duel_id: 0 },
  gas: 100_000_000_000_000n, attachedDeposit: 0n,
}), 'duel window not over');

console.log('== 4. early meme-day resolve ==');
await expectFail('resolve meme day 0 coin 0 before day ends', () => holder.functionCall({
  contractId: ARENA_ID, methodName: 'resolve_meme_day', args: { coin_id: 0, day: 0 },
  gas: 100_000_000_000_000n, attachedDeposit: 0n,
}), 'day not over yet');

console.log('== 5. season ==');
const season = await view('get_current_season', {});
console.log('  season', season.id, 'ends', new Date(Number(BigInt(season.end_ns) / 1000000n)).toISOString(), 'status', season.status, '— NOT due, no resolve attempted');
if (Date.now() * 1e6 >= Number(BigInt(season.end_ns))) throw new Error('season IS due — re-check before resolving');

console.log('\nALL LIVE CHECKS PASSED');
console.log('buy tx:', buy.transaction.hash);
console.log('sell tx:', sell.transaction.hash);
console.log('duel create tx:', duel.transaction.hash);
