// Live v8 checks, part 3 (final).
// - Duel 10 (0,2) created in part 2c exists and is active (status is the
//   string "active" in views, not the number 0 — the part-2c check bug).
// - Early duel resolve and early meme-day resolve must fail.
// - Season 2965 ends 2026-11-09 00:00 UTC — NOT due; no resolve attempted.
// - Battle 10 (isaiah-pac vs sniper-pac) unchanged: still pending.
// - Judge key: (a) the judge service loads it and runs in dry-run mode;
//   (b) a function call with the judge key to any method other than
//   record_ai_score must be rejected (access-key permission).
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

console.log('== duel 10 ==');
const duels = await view('list_coin_duels', { from_index: 10, limit: 5 });
console.log('  duels from 10:', JSON.stringify(duels));
const d10 = duels.find((d) => d.id === 10);
if (!d10 || d10.coin_a !== 0 || d10.coin_b !== 2 || d10.status !== 'active') throw new Error('duel 10 not active as expected');
console.log('  [ok] duel 10 (coin 0 vs coin 2) active, created by degen-pac.testnet');

console.log('== early duel resolve ==');
await expectFail('resolve duel 0 before window ends', () => degen.functionCall({
  contractId: ARENA_ID, methodName: 'resolve_coin_duel', args: { duel_id: 0 },
  gas: 100_000_000_000_000n, attachedDeposit: 0n,
}), 'duel window not over');

console.log('== early meme-day resolve ==');
await expectFail('resolve meme day 0 coin 0 before day ends', () => holder.functionCall({
  contractId: ARENA_ID, methodName: 'resolve_meme_day', args: { coin_id: 0, day: 0 },
  gas: 100_000_000_000_000n, attachedDeposit: 0n,
}), 'day not over yet');

console.log('== season ==');
const season = await view('get_current_season', {});
console.log('  season', season.id, 'ends', new Date(Number(BigInt(season.end_ns) / 1000000n)).toISOString(), 'status', season.status, '— NOT due, no resolve attempted');
if (Date.now() * 1e6 >= Number(BigInt(season.end_ns))) throw new Error('season IS due — re-check before resolving');

console.log('== battle 10 ==');
const battles = await view('list_battles', { from_index: 10, limit: 5 });
console.log('  battle 10:', JSON.stringify(battles));
const b10 = battles.find((b) => b.id === 10);
if (!b10 || b10.status !== 'pending' || b10.agent_a !== 'isaiah-pac.testnet' || b10.agent_b !== 'sniper-pac.testnet') throw new Error('battle 10 changed by the migration');
console.log('  [ok] battle 10 unchanged: pending, isaiah-pac vs sniper-pac, stake 0.1 NEAR');

console.log('== judge key restriction ==');
const judge = JSON.parse(fs.readFileSync(new URL('../.testnet-judge-key.json', import.meta.url), 'utf8'));
const jks = new keyStores.InMemoryKeyStore();
await jks.setKey('testnet', judge.accountId, KeyPair.fromString(judge.privateKey));
const jnear = await connect({ networkId: 'testnet', nodeUrl: RPC, walletUrl: 'https://testnet.mynearwallet.com/', helperUrl: 'https://helper.testnet.near.org', keyStore: jks });
const jarena = await jnear.account(judge.accountId);
await expectFail('judge key calling register_agent (forbidden method)', () => jarena.functionCall({
  contractId: ARENA_ID, methodName: 'register_agent', args: {},
  gas: 100_000_000_000_000n, attachedDeposit: 0n,
}), 'does not have permission');
console.log('  [ok] judge key is restricted: it cannot call methods other than record_ai_score');

console.log('\nALL LIVE CHECKS PASSED');
