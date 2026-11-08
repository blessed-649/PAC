// Redeploy the arena WASM to the existing pac-arena.testnet WITHOUT
// re-initialising (state is preserved: coins, agents, battles stay).
// Run: node scripts/redeploy-arena.mjs
import fs from 'node:fs';
import { connect, keyStores, KeyPair } from 'near-api-js';

const ACCOUNTS_FILE = new URL('../.testnet-accounts.json', import.meta.url);
const WASM = new URL('../target/near/pac_arena/pac_arena.wasm', import.meta.url);
const ARENA_ID = 'pac-arena.testnet';

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
const arena = accounts.arena;
const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', arena.accountId, KeyPair.fromString(arena.privateKey));
const near = await connect({
  networkId: 'testnet', nodeUrl: 'https://rpc.testnet.fastnear.com',
  walletUrl: 'https://testnet.mynearwallet.com/', helperUrl: 'https://helper.testnet.near.org', keyStore,
});
const account = await near.account(arena.accountId);
const wasm = fs.readFileSync(WASM);
console.log(`redeploying ${wasm.length} bytes to ${ARENA_ID} ...`);
await account.deployContract(wasm);
console.log('WASM redeployed (state preserved)');
const params = await account.viewFunction({ contractId: ARENA_ID, methodName: 'get_params', args: {} });
if (params.lock_duration_hours !== 24 || params.battle_min_stake_yocto !== '100000000000000000000000') {
  throw new Error('params mismatch after redeploy');
}
console.log('schema_version after redeploy:', params.schema_version);
const stats = await account.viewFunction({ contractId: ARENA_ID, methodName: 'get_stats', args: {} });
console.log('get_stats after redeploy:', JSON.stringify(stats));
console.log('REDEPLOY OK:', ARENA_ID);
