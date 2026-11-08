// Rejection checks against the already-deployed v9 test arena pac-v9l-a505fa.testnet.
// Keys in /tmp/pac-v9launch-accounts.json (chmod 600).
import fs from 'node:fs';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';
const RPC = 'https://rpc.testnet.fastnear.com';
const ARENA_ID = 'pac-v9l-a505fa.testnet';
const TRADER_A = 'pac-v9l-trader-1b9099.testnet';
const TRADER_B = 'trader-b.pac-v9l-a505fa.testnet';
const parseNear = (n) => utils.format.parseNearAmount(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keys = JSON.parse(fs.readFileSync('/tmp/pac-v9launch-accounts.json', 'utf8'));
const keyStore = new keyStores.InMemoryKeyStore();
for (const [id, k] of Object.entries(keys)) await keyStore.setKey('testnet', id, KeyPair.fromString(k));
const near = await connect({ networkId: 'testnet', nodeUrl: RPC, keyStore });
const acct = (id) => near.account(id);
async function tryLaunch(from, buyNear, attachNear) {
  try {
    const tx = await (await acct(from)).functionCall({ contractId: ARENA_ID, methodName: 'launch_coin', args: { name: 'X', symbol: 'X', description: 'reject test', initial_buy_yocto: parseNear(buyNear), image_url: null }, gas: 300_000_000_000_000n, attachedDeposit: BigInt(parseNear(attachNear)) });
    const failed = (tx.receipts_outcome || []).find(r => r.outcome && r.outcome.status && r.outcome.status.Failure);
    if (failed) return { ok: false, error: JSON.stringify(failed.outcome.status.Failure).slice(0, 300) };
    return { ok: true, tx: tx.transaction.hash };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 300) }; }
}
console.log('--- (c) 0.09 NEAR buy (must fail: below minimum) ---');
console.log(await tryLaunch(TRADER_B, '0.09', '2.09'));
console.log('--- (d) 10.1 NEAR buy (must fail: above maximum) ---');
console.log(await tryLaunch(TRADER_A, '10.1', '12.1'));
// Confirm no coin was created by the failed launches.
await sleep(2000);
const coin0 = await (await acct(ARENA_ID)).viewFunction({ contractId: ARENA_ID, methodName: 'get_coin', args: { coin_id: 0 } });
console.log('get_coin(0) after failed launches:', coin0);
