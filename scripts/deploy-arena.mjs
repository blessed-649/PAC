// Deploy the PAC arena contract to NEAR testnet.
// Uses ONLY the fresh PAC arena account (pac-arena.testnet). No Genesis or
// VeilProof wallets. Deploys the WASM, calls new(), verifies get_params.
// Run: node scripts/deploy-arena.mjs
import fs from 'node:fs';
import { connect, keyStores, KeyPair } from 'near-api-js';

const ACCOUNTS_FILE = new URL('../.testnet-accounts.json', import.meta.url);
const WASM = new URL('../target/near/pac_arena/pac_arena.wasm', import.meta.url);
const ARENA_ID = 'pac-arena.testnet';

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
const arena = accounts.arena;
if (!arena) throw new Error('arena account missing in .testnet-accounts.json');

const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', arena.accountId, KeyPair.fromString(arena.privateKey));

const near = await connect({
  networkId: 'testnet',
  nodeUrl: 'https://rpc.testnet.fastnear.com',
  walletUrl: 'https://testnet.mynearwallet.com/',
  helperUrl: 'https://helper.testnet.near.org',
  keyStore,
});
const account = await near.account(arena.accountId);

const wasm = fs.readFileSync(WASM);
console.log(`deploying ${wasm.length} bytes to ${ARENA_ID} ...`);
await account.deployContract(wasm);
console.log('WASM deployed');

console.log('calling new() ...');
await account.functionCall({
  contractId: ARENA_ID,
  methodName: 'new',
  args: {},
  gas: 100_000_000_000_000n,
  attachedDeposit: 0n,
});
console.log('initialized');

// Verify: params are readable and match the fixed launch values.
const params = await account.viewFunction({
  contractId: ARENA_ID,
  methodName: 'get_params',
  args: {},
});
console.log('get_params:', JSON.stringify(params, null, 2));
if (params.lock_duration_hours !== 24) throw new Error('lock duration mismatch');
if (params.battle_duration_hours !== 24) throw new Error('battle duration mismatch');
if (params.battle_forfeit_yocto !== '100000000000000000000000') throw new Error('forfeit mismatch');
if (params.rep_weight_pnl !== 40 || params.rep_weight_win_rate !== 30 || params.rep_weight_hold_time !== 30) {
  throw new Error('reputation weights mismatch');
}
if (params.milestone_holders.join(',') !== '10,50,100') throw new Error('milestone holders mismatch');
if (params.vote_choices.length !== 3) throw new Error('vote choices mismatch');
if (params.coin_duel_treasury_bp !== 500) throw new Error('coin duel percent mismatch');
if (params.meme_reward_yocto !== '10000000000000000000000') throw new Error('meme reward mismatch');
const stats = await account.viewFunction({
  contractId: ARENA_ID,
  methodName: 'get_stats',
  args: {},
});
console.log('get_stats:', JSON.stringify(stats));
if (stats.coins !== 0) throw new Error('expected zero coins at deploy');
console.log('DEPLOY OK:', ARENA_ID);
