// Create a function-call access key for the PAC AI meme judge.
//
// The judge service (scripts/ai-meme-judge.mjs) signs record_ai_score
// with this key, not with the arena's full-access key. The key lives
// on the pac-arena.testnet account and is restricted to the arena
// contract and the single method record_ai_score, with a 0.5 NEAR
// allowance for gas. It can mint, burn, transfer, deploy, or call any
// other method — it cannot. The full-access arena key is NOT rotated
// or deleted by this script; it stays in .testnet-accounts.json.
//
// This is a ONE-TIME live step: it adds a key to the live arena
// account on testnet (a small gas cost). Run it once, then the judge
// service reads .testnet-judge-key.json and never loads the arena key.
// If the file already exists, this script refuses to run: delete the
// key onchain first (near account delete-key) if you ever need to
// recreate it.
//
// Run: node scripts/create-judge-key.mjs
import fs from 'node:fs';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';

const ARENA_ID = 'pac-arena.testnet';
const ACCOUNTS_FILE = new URL('../.testnet-accounts.json', import.meta.url);
const JUDGE_KEY_FILE = new URL('../.testnet-judge-key.json', import.meta.url);
const RPC = 'https://rpc.testnet.fastnear.com';
const ALLOWANCE_NEAR = '0.5';

if (fs.existsSync(JUDGE_KEY_FILE)) {
  console.error('create-judge-key: .testnet-judge-key.json already exists. Refusing to create a second judge key.');
  console.error('To recreate it, delete the old key onchain first (near account delete-key), then delete the file and re-run.');
  process.exit(1);
}

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
if (!accounts.arena) throw new Error('arena account missing in .testnet-accounts.json');

const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', accounts.arena.accountId, KeyPair.fromString(accounts.arena.privateKey));
const near = await connect({
  networkId: 'testnet', nodeUrl: RPC,
  walletUrl: 'https://testnet.mynearwallet.com/',
  helperUrl: 'https://helper.testnet.near.org', keyStore,
});
const arena = await near.account(ARENA_ID);

const judgeKey = KeyPair.fromRandom('ed25519');
const publicKey = judgeKey.getPublicKey();
console.log(`adding function-call key ${publicKey.toString()} to ${ARENA_ID} (contract ${ARENA_ID}, method record_ai_score only, ${ALLOWANCE_NEAR} NEAR allowance) ...`);
await arena.addKey(
  publicKey,
  ARENA_ID,
  ['record_ai_score'],
  utils.format.parseNearAmount(ALLOWANCE_NEAR),
);
console.log('key added onchain');

fs.writeFileSync(
  JUDGE_KEY_FILE,
  JSON.stringify(
    { accountId: ARENA_ID, publicKey: publicKey.toString(), privateKey: judgeKey.toString() },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log('judge key saved to .testnet-judge-key.json (chmod 600, gitignored).');
console.log('The judge service now signs record_ai_score with this key only; the full-access arena key is no longer loaded by it.');
