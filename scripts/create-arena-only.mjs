// One-off: create ONLY the pac-arena.testnet account (pac.testnet was taken).
// Verifies the key is onchain, then replaces the stale arena entry in
// .testnet-accounts.json (chmod 600).
import fs from 'node:fs';
import { KeyPair } from 'near-api-js';

const RPC = 'https://rpc.testnet.fastnear.com';
const HELPER = 'https://helper.testnet.near.org/account';
const OUT = new URL('/home/hatch/workspace/pac/.testnet-accounts.json', import.meta.url);
const accountId = 'pac-arena.testnet';

const keyPair = KeyPair.fromRandom('ed25519');
const publicKey = keyPair.getPublicKey().toString();
console.log(`creating ${accountId} with ${publicKey} ...`);
const res = await fetch(HELPER, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
});
console.log(`helper HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
const check = await (await fetch(RPC, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 'k', method: 'query', params: { request_type: 'view_access_key_list', account_id: accountId, finality: 'final' } }),
})).json();
const keys = check.result ? check.result.keys.map(k => k.public_key) : [];
console.log('onchain keys:', JSON.stringify(keys));
if (!keys.includes(publicKey)) throw new Error('OUR KEY IS NOT ONCHAIN — account may already exist');
const accounts = JSON.parse(fs.readFileSync(OUT, 'utf8'));
accounts.arena = { accountId, publicKey, privateKey: keyPair.toString() };
fs.writeFileSync(OUT, JSON.stringify(accounts, null, 2) + '\n', { mode: 0o600 });
console.log('arena account replaced in .testnet-accounts.json (chmod 600)');
