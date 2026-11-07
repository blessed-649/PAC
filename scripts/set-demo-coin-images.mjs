// Set placeholder images on the two live demo coins (v4 set_coin_image).
// Coin 0 DEGEN is created by degen-pac.testnet, coin 1 HOLD by
// holder-pac.testnet. These are seeded picsum photos so the image
// feature is visible; Isaiah can replace them with real memecoin art
// from the coin page (creator only).
// Run: node scripts/set-demo-coin-images.mjs
import fs from 'node:fs';
import { connect, keyStores, KeyPair } from 'near-api-js';

const ACCOUNTS_FILE = new URL('../.testnet-accounts.json', import.meta.url);
const ARENA_ID = 'pac-arena.testnet';
const RPC = 'https://rpc.testnet.fastnear.com';

const IMAGES = [
  { coin_id: 0, creator: 'degen', image_url: 'https://picsum.photos/seed/pac-degen/512' },
  { coin_id: 1, creator: 'holder', image_url: 'https://picsum.photos/seed/pac-hold/512' },
];

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
const keyStore = new keyStores.InMemoryKeyStore();
for (const key of ['degen', 'holder']) {
  await keyStore.setKey('testnet', accounts[key].accountId, KeyPair.fromString(accounts[key].privateKey));
}
const near = await connect({
  networkId: 'testnet', nodeUrl: RPC,
  walletUrl: 'https://testnet.mynearwallet.com/',
  helperUrl: 'https://helper.testnet.near.org', keyStore,
});

for (const img of IMAGES) {
  const creator = await near.account(accounts[img.creator].accountId);
  console.log(`setting coin ${img.coin_id} image from ${accounts[img.creator].accountId} ...`);
  await creator.functionCall({
    contractId: ARENA_ID, methodName: 'set_coin_image',
    args: { coin_id: img.coin_id, image_url: img.image_url },
    gas: 100_000_000_000_000n, attachedDeposit: 0n,
  });
  const coin = await creator.viewFunction({ contractId: ARENA_ID, methodName: 'get_coin', args: { coin_id: img.coin_id } });
  if (coin.image_url !== img.image_url) throw new Error(`coin ${img.coin_id} image_url mismatch: ${JSON.stringify(coin.image_url)}`);
  console.log(`  [ok] coin ${img.coin_id} (${coin.symbol}) image_url: ${coin.image_url}`);
}
console.log('\nDemo coin images set. Both are picsum placeholders; replace with real art from the coin page.');
