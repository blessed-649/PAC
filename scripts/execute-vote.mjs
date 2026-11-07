// Execute vote round 0 after its deadline (2026-11-07 14:52:06 UTC) and
// verify the outcome onchain. Round 0 votes: Burn 2% = 225,000 weight,
// Mint 2% = 0, Do nothing = 300,000 — so the expected outcome is
// "Do nothing" and coin 0 total supply must be unchanged.
// Run: node scripts/execute-vote.mjs   (call after the deadline)
import fs from 'node:fs';
import { connect, keyStores, KeyPair } from 'near-api-js';

const ACCOUNTS_FILE = new URL('../.testnet-accounts.json', import.meta.url);
const ARENA_ID = 'pac-arena.testnet';
const RPC = 'https://rpc.testnet.fastnear.com';

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', accounts.holder.accountId, KeyPair.fromString(accounts.holder.privateKey));
const near = await connect({
  networkId: 'testnet', nodeUrl: RPC,
  walletUrl: 'https://testnet.mynearwallet.com/',
  helperUrl: 'https://helper.testnet.near.org', keyStore,
});
const arena = await near.account(ARENA_ID);
const view = (m, a = {}) => arena.viewFunction({ contractId: ARENA_ID, methodName: m, args: a });

const before = await view('get_vote_round', { round_id: 0 });
const coinBefore = await view('get_coin', { coin_id: 0 });
console.log('round 0 before:', JSON.stringify(before));
console.log('coin 0 total supply before:', coinBefore.total_supply_tokens);
if (Date.now() < Number(BigInt(before.deadline_ns) / 1000000n)) {
  throw new Error('deadline has not passed yet: ' + new Date(Number(BigInt(before.deadline_ns) / 1000000n)).toISOString());
}
const holder = await near.account(accounts.holder.accountId);
await holder.functionCall({
  contractId: ARENA_ID, methodName: 'execute_vote_round', args: { round_id: 0 },
  gas: 100_000_000_000_000n, attachedDeposit: 0n,
});
console.log('execute_vote_round sent');
const after = await view('get_vote_round', { round_id: 0 });
const coinAfter = await view('get_coin', { coin_id: 0 });
console.log('round 0 after:', JSON.stringify(after));
console.log('coin 0 total supply after:', coinAfter.total_supply_tokens);
if (!after.executed) throw new Error('round was not marked executed');
if (after.outcome !== 'Do nothing') throw new Error('unexpected outcome: ' + after.outcome);
if (coinAfter.total_supply_tokens !== coinBefore.total_supply_tokens) {
  throw new Error('supply changed on a Do-nothing outcome');
}
console.log('VOTE EXECUTION OK — outcome "Do nothing", supply unchanged, as voted.');
