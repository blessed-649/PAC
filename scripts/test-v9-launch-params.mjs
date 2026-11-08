// PAC v9 launch-economics proof on a FRESH test arena (NOT the live arena).
// 1. Creates a fresh testnet arena account via the helper faucet.
// 2. Deploys the v9 arena WASM and calls new(); checks schema 9 and
//    get_params (launch cost 2 NEAR, min initial buy 0.1, max 10).
// 3. Boundary launches (trader A, top-level helper account + top-up):
//    a. 0.1 NEAR initial buy, 2.1 attached -> must SUCCEED, ~99,009
//       tokens, creator qualified (qualified_holders 1).
//    b. 10 NEAR initial buy, 12 attached -> must SUCCEED, 3,975,247 tokens.
//    c. 0.09 NEAR initial buy, 2.09 attached -> must FAIL "initial buy below minimum".
//    d. 10.1 NEAR initial buy -> must FAIL "initial buy above maximum".
//    The 2 NEAR launch cost also funds the new token subaccount: if a
//    launch fails for lack of storage, this script reports it as the
//    blocker (token WASM is 198,066 bytes; NEAR storage is 1e19 yocto
//    per byte, so code alone needs ~1.98 NEAR).
// Keys are written ONLY to /tmp/pac-v9launch-accounts.json (chmod 600).
// Run: node scripts/test-v9-launch-params.mjs
import fs from 'node:fs';
import crypto from 'node:crypto';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';

const RPC = 'https://rpc.testnet.fastnear.com';
const HELPER = 'https://helper.testnet.near.org/account';
const ARENA_WASM = new URL('../target/near/pac_arena/pac_arena.wasm', import.meta.url);
const TOKEN_WASM = new URL('../contracts/arena/token.wasm', import.meta.url);
const OUT = '/tmp/pac-v9launch-accounts.json';
const parseNear = (n) => utils.format.parseNearAmount(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const suffix = crypto.randomBytes(3).toString('hex');
const ARENA_ID = `pac-v9l-${suffix}.testnet`;
const TRADER_A = `pac-v9l-trader-${suffix}.testnet`;
const FUND_ID = `pac-v9l-fund-${suffix}.testnet`;
const FUND2_ID = `pac-v9l-fund2-${suffix}.testnet`;
const TRADER_B = `trader-b.${ARENA_ID}`;

function base58Sha256(buf) {
  const hash = crypto.createHash('sha256').update(buf).digest();
  const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + hash.toString('hex'));
  let out = '';
  while (n > 0n) { out = ALPH[Number(n % 58n)] + out; n /= 58n; }
  for (const b of hash) { if (b === 0) out = '1' + out; else break; }
  return out;
}
async function rpcQuery(params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'query', params }) });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}
async function codeHash(accountId) {
  return (await rpcQuery({ request_type: 'view_account', account_id: accountId, finality: 'final' })).code_hash;
}
async function accountBalance(accountId) {
  const v = await rpcQuery({ request_type: 'view_account', account_id: accountId, finality: 'final' });
  return BigInt(v.amount);
}

console.log('== v9 launch-params proof, test arena', ARENA_ID);
const keys = {};
async function createViaHelper(accountId) {
  const kp = KeyPair.fromRandom('ed25519');
  const res = await fetch(HELPER, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: kp.getPublicKey().toString() }) });
  console.log('helper', accountId, 'HTTP', res.status, (await res.text()).slice(0, 120));
  keys[accountId] = kp.toString();
  return kp;
}
const arenaKey = await createViaHelper(ARENA_ID);
const traderAKey = await createViaHelper(TRADER_A);
const fundKey = await createViaHelper(FUND_ID);
const fund2Key = await createViaHelper(FUND2_ID);

const keyStore = new keyStores.InMemoryKeyStore();
for (const [id, k] of Object.entries(keys)) await keyStore.setKey('testnet', id, KeyPair.fromString(k));
const near = await connect({ networkId: 'testnet', nodeUrl: RPC, walletUrl: 'https://testnet.mynearwallet.com/', helperUrl: 'https://helper.testnet.near.org', keyStore });
const arena = await near.account(ARENA_ID);
const acct = (id) => near.account(id);
// Top trader A up with 9.9 NEAR from the funder, and the arena with 9.9 NEAR.
await (await acct(FUND_ID)).sendMoney(TRADER_A, BigInt(parseNear('9.9')));
await (await acct(FUND2_ID)).sendMoney(ARENA_ID, BigInt(parseNear('9.9')));
console.log('topped up trader A (+9.9) and arena (+9.9)');
// Trader B: subaccount of the arena, 2 NEAR.
const traderBKey = KeyPair.fromRandom('ed25519');
await keyStore.setKey('testnet', TRADER_B, traderBKey);
keys[TRADER_B] = traderBKey.toString();
await arena.createAccount(TRADER_B, traderBKey.getPublicKey(), BigInt(parseNear('2')));
console.log('created subaccount', TRADER_B);
fs.writeFileSync(OUT, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });

async function withRetry(fn, label) {
  let delay = 2000;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try { return await fn(); } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      if (!/429|503|502|ECONNRESET|timeout|not initialized/.test(msg) || attempt === 6) throw e;
      console.log(`  [retry ${attempt}/6] ${label}`);
      await sleep(delay); delay *= 2;
    }
  }
}
const view = (contractId, m, a = {}) => withRetry(async () => (await acct(ARENA_ID)).viewFunction({ contractId, methodName: m, args: a }), `view ${m}`);
const call = (from, contractId, m, a, deposit = '0', gas = 300_000_000_000_000n) =>
  withRetry(async () => (await acct(from)).functionCall({ contractId, methodName: m, args: a, gas, attachedDeposit: BigInt(parseNear(deposit)) }), `call ${m}`);

const wasm = fs.readFileSync(ARENA_WASM);
const tokenWasm = fs.readFileSync(TOKEN_WASM);
console.log('deploying test arena WASM', wasm.length, 'bytes; token WASM', tokenWasm.length, 'bytes');
console.log('token code storage need ~', (tokenWasm.length * 1e19 / 1e24).toFixed(3), 'NEAR (1e19 yocto/byte); launch cost funds 2 NEAR');
await withRetry(() => arena.deployContract(wasm), 'deploy test arena');
await call(ARENA_ID, ARENA_ID, 'new', {});
await sleep(5000);
const params = await view(ARENA_ID, 'get_params', {});
console.log('schema:', params.schema_version, '| launch_cost:', params.launch_cost_yocto, '| min:', params.min_initial_buy_yocto, '| max:', params.max_initial_buy_yocto);
if (params.schema_version !== 9) throw new Error('test arena is not schema 9');
if (params.launch_cost_yocto !== '2000000000000000000000000') throw new Error('launch cost is not 2 NEAR');
if (params.min_initial_buy_yocto !== '100000000000000000000000') throw new Error('min initial buy is not 0.1 NEAR');
if (params.max_initial_buy_yocto !== '10000000000000000000000000') throw new Error('max initial buy is not 10 NEAR');
console.log('PARAMS OK');

async function tryLaunch(from, name, symbol, buyNear, attachNear) {
  try {
    const tx = await call(from, ARENA_ID, 'launch_coin', { name, symbol, description: 'v9 launch-params proof coin', initial_buy_yocto: parseNear(buyNear), image_url: null }, attachNear);
    return { ok: true, tx: tx.transaction.hash };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// (a) minimum launch: 0.1 NEAR buy, 2.1 attached.
console.log('--- (a) launch 0.1 NEAR buy, 2.1 attached ---');
let r = await tryLaunch(TRADER_A, 'Min Coin', 'MINC', '0.1', '2.1');
console.log(JSON.stringify(r).slice(0, 400));
if (!r.ok) {
  console.log('MINIMUM LAUNCH FAILED — this is the storage question. Error above.');
  console.log('BLOCKER: 2 NEAR launch cost does not fund the token subaccount.');
  process.exit(3);
}
await sleep(3000);
let coin0 = await view(ARENA_ID, 'get_coin', { coin_id: 0 });
console.log('coin 0:', coin0.name, '| sold_tokens:', coin0.sold_tokens, '| qualified_holders:', coin0.qualified_holders, '| reserve:', coin0.near_reserve_yocto);
console.log('token code hash:', await codeHash(coin0.token_id), '| expected:', base58Sha256(tokenWasm));
console.log('token account balance (NEAR):', Number(await accountBalance(coin0.token_id)) / 1e24);
if (Number(coin0.sold_tokens) !== 99009) throw new Error(`min launch tokens ${coin0.sold_tokens} != 99009`);
if (Number(coin0.qualified_holders) < 1) throw new Error('min-launch creator did not qualify');
console.log('(a) OK: 99,009 tokens, creator qualified');

// (b) maximum launch: 10 NEAR buy, 12 attached.
console.log('--- (b) launch 10 NEAR buy, 12 attached ---');
r = await tryLaunch(TRADER_A, 'Max Coin', 'MAXC', '10', '12');
console.log(JSON.stringify(r).slice(0, 400));
if (!r.ok) throw new Error('MAXIMUM LAUNCH FAILED: ' + r.error);
await sleep(3000);
let coin1 = await view(ARENA_ID, 'get_coin', { coin_id: 1 });
console.log('coin 1:', coin1.name, '| sold_tokens:', coin1.sold_tokens, '| qualified_holders:', coin1.qualified_holders);
if (Number(coin1.sold_tokens) !== 3975247) throw new Error(`max launch tokens ${coin1.sold_tokens} != 3975247`);
console.log('(b) OK: 3,975,247 tokens');

// (c) below minimum: 0.09 NEAR buy.
console.log('--- (c) launch 0.09 NEAR buy (must fail) ---');
r = await tryLaunch(TRADER_B, 'Low Coin', 'LOWC', '0.09', '2.09');
console.log(JSON.stringify(r).slice(0, 300));
if (r.ok) throw new Error('BELOW-MINIMUM LAUNCH SUCCEEDED — validation missing!');
if (!r.error.includes('initial buy below minimum')) throw new Error('wrong failure for below-minimum: ' + r.error);
console.log('(c) OK: rejected with "initial buy below minimum"');

// (d) above maximum: 10.1 NEAR buy.
console.log('--- (d) launch 10.1 NEAR buy (must fail) ---');
r = await tryLaunch(TRADER_A, 'Big Coin', 'BIGC', '10.1', '12.1');
console.log(JSON.stringify(r).slice(0, 300));
if (r.ok) throw new Error('ABOVE-MAXIMUM LAUNCH SUCCEEDED — validation missing!');
if (!r.error.includes('initial buy above maximum')) throw new Error('wrong failure for above-maximum: ' + r.error);
console.log('(d) OK: rejected with "initial buy above maximum"');

console.log('V9 LAUNCH-PARAMS PROOF: ALL OK');
console.log('test arena:', ARENA_ID);
