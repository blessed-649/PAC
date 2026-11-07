// PAC auto copy relayer (off-chain).
// Watches the arena activity feed for a followed leader's buy/sell
// events and submits the matching copy_buy / copy_sell for each
// registered copier, using that copier's copy key.
//
// Security model: the copier keeps funds in their own account and
// grants a function-call access key limited to the arena contract
// only, for copy_buy and copy_sell. That key can never move funds
// anywhere else: it can only copy trades on the arena, inside the
// limits the copier set with follow(). This script holds the copy
// key and nothing else. It never holds a full-access key.
//
// Setup (per copier):
//   1. Generate a fresh keypair: node -e "console.log(require('near-api-js').KeyPair.fromRandom('ed25519').toString())"
//      (or: near-api-js KeyPair.fromRandom in any script).
//   2. Add its public key to your account as a function-call access
//      key: receiver pac-arena.testnet, methods copy_buy and
//      copy_sell, no attached deposit allowance beyond the trade
//      amounts. In the Meteor wallet: account settings -> add key
//      (function call, contract pac-arena.testnet, methods
//      copy_buy, copy_sell). Or with near-cli:
//        near add-key <your-account> <public-key> \
//          --contract-id pac-arena.testnet \
//          --method-names copy_buy,copy_sell
//   3. Register the follow onchain (once, with your full key):
//        near call pac-arena.testnet follow \
//          '{"leader": "<leader>", "amount_per_trade_yocto": "<yocto>", "max_total_yocto": "<yocto>", "copy_public_key": "<public-key>"}' \
//          --accountId <your-account>
//      Per-trade amount 0.01–10 NEAR, max total at least 0.1 NEAR.
//   4. Copy scripts/copy-relayer.config.example.json to
//      scripts/copy-relayer.config.json, put the copy private key in
//      it (NEVER commit that file — it is gitignored), and run:
//        node scripts/copy-relayer.mjs --once   # single pass (test)
//        node scripts/copy-relayer.mjs          # poll loop
//
// The relayer respects the copier's limits: it reads the onchain
// follow before every copy and skips when the max total is reached.
// Copied tokens are held in the arena vault; the copier sells or
// withdraws them with copy_sell / withdraw_copy. Each copy trade
// pays 1% of its amount to the leader.
//
// Run: node scripts/copy-relayer.mjs [--once] [--config <path>] [--poll-ms <ms>]
import fs from 'node:fs';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';

const args = process.argv.slice(2);
const once = args.includes('--once');
const configIdx = args.indexOf('--config');
const pollIdx = args.indexOf('--poll-ms');
const CONFIG_PATH = configIdx >= 0 ? args[configIdx + 1] : new URL('./copy-relayer.config.json', import.meta.url).pathname;
const POLL_MS = pollIdx >= 0 ? parseInt(args[pollIdx + 1], 10) : null;

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const ARENA_ID = config.arenaId || 'pac-arena.testnet';
const RPC = config.rpcUrl || 'https://rpc.testnet.fastnear.com';
const POLL = POLL_MS || config.pollMs || 15000;
const STATE_PATH = config.stateFile
  ? new URL(config.stateFile, import.meta.url).pathname
  : new URL('./.copy-relayer-state.json', import.meta.url).pathname;
const parseNear = (n) => utils.format.parseNearAmount(n);

if (!Array.isArray(config.copiers) || config.copiers.length === 0) {
  throw new Error('config has no copiers — see copy-relayer.config.example.json');
}

const keyStore = new keyStores.InMemoryKeyStore();
for (const c of config.copiers) {
  if (!c.accountId || !c.privateKey) throw new Error('each copier needs accountId and privateKey');
  await keyStore.setKey('testnet', c.accountId, KeyPair.fromString(c.privateKey));
}
const near = await connect({
  networkId: 'testnet', nodeUrl: RPC,
  walletUrl: 'https://wallet.meteorwallet.app/',
  helperUrl: 'https://helper.testnet.near.org', keyStore,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let seen = new Set();
try {
  const saved = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  if (Array.isArray(saved.seen)) seen = new Set(saved.seen);
} catch { /* no state yet */ }
function saveState() {
  const arr = [...seen].slice(-1000);
  fs.writeFileSync(STATE_PATH, JSON.stringify({ seen: arr }, null, 2) + '\n', { mode: 0o600 });
}

async function withRetry(fn, label) {
  let delay = 2000;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try { return await fn(); } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      const retryable = msg.includes('429') || msg.includes('503') || msg.includes('502') || msg.includes('ECONNRESET') || msg.includes('timeout');
      if (!retryable || attempt === 6) throw e;
      console.log(`  [retry ${attempt}/6] ${label} after ${delay}ms`);
      await sleep(delay); delay *= 2;
    }
  }
}
async function view(method, a = {}) {
  const arena = await near.account(ARENA_ID);
  return withRetry(() => arena.viewFunction({ contractId: ARENA_ID, methodName: method, args: a }), `view ${method}`);
}
async function callAs(copierId, method, a, depositYocto = '0') {
  const acct = await near.account(copierId);
  return withRetry(() => acct.functionCall({
    contractId: ARENA_ID, methodName: method, args: a,
    gas: 100_000_000_000_000n, attachedDeposit: BigInt(depositYocto),
  }), `call ${method} as ${copierId}`);
}

// Deterministic rejections: the copy is correctly skipped, not retried.
const SKIP_REASONS = [
  'no active follow', 'copy max total reached', 'no copy position',
  'amount buys zero tokens', 'curve sold out', 'copy position smaller',
];
function isSkipError(e) {
  const msg = String(e && e.message ? e.message : e);
  return SKIP_REASONS.some((s) => msg.includes(s));
}

async function processEvent(event, copier) {
  // Returns 'copied' when a copy trade was submitted, 'skipped' when
  // the event was correctly ignored (no follow, cap reached, no
  // vaulted position). Throws on transient errors (retried next pass).
  const leader = event.agent;
  const coinId = event.coin_id;
  if (event.kind === 'buy') {
    const follow = await view('get_follow', { copier: copier.accountId, leader });
    if (!follow) {
      console.log(`  skip: ${copier.accountId} no longer follows ${leader}`);
      return 'skipped';
    }
    const amount = BigInt(follow.amount_per_trade_yocto);
    const total = BigInt(follow.total_copied_yocto);
    const max = BigInt(follow.max_total_yocto);
    if (total + amount > max) {
      console.log(`  skip: ${copier.accountId} max total reached for ${leader} (${total}/${max})`);
      return 'skipped';
    }
    console.log(`  copy buy: ${copier.accountId} copies ${leader} on coin ${coinId} for ${amount} yocto`);
    await callAs(copier.accountId, 'copy_buy', { coin_id: coinId, leader }, amount.toString());
    console.log(`  copied buy done (leader fee 1% to ${leader})`);
    return 'copied';
  }
  if (event.kind === 'sell') {
    const follow = await view('get_follow', { copier: copier.accountId, leader });
    if (!follow) {
      console.log(`  skip: ${copier.accountId} no longer follows ${leader}`);
      return 'skipped';
    }
    const pos = await view('get_copy_position', { copier: copier.accountId, leader, coin_id: coinId });
    if (!pos || BigInt(pos.tokens) === 0n) {
      console.log(`  skip: ${copier.accountId} has no vaulted copy position on coin ${coinId}`);
      return 'skipped';
    }
    const leaderTokens = BigInt(event.tokens);
    const sellTokens = leaderTokens < BigInt(pos.tokens) ? leaderTokens : BigInt(pos.tokens);
    if (sellTokens === 0n) return 'skipped';
    console.log(`  copy sell: ${copier.accountId} copies ${leader} sell on coin ${coinId}: ${sellTokens} tokens`);
    await callAs(copier.accountId, 'copy_sell', { coin_id: coinId, leader, tokens: sellTokens.toString() });
    console.log(`  copied sell done (leader fee 1% to ${leader})`);
    return 'copied';
  }
  return 'skipped';
}

async function pass() {
  const activity = await view('get_activity', { limit: 100 });
  // Oldest first so copies happen in trade order.
  const events = [...activity].reverse();
  let acted = 0;
  // Two identical leader trades in one block share a timestamp, so
  // count occurrences within this batch to keep their keys distinct.
  const occurrences = new Map();
  for (const event of events) {
    if (event.kind !== 'buy' && event.kind !== 'sell') continue;
    const baseKey = `${event.kind}:${event.agent}:${event.coin_id}:${event.tokens}:${event.near_yocto}:${event.timestamp_ns}`;
    const n = (occurrences.get(baseKey) || 0) + 1;
    occurrences.set(baseKey, n);
    const key = n > 1 ? `${baseKey}#${n}` : baseKey;
    if (seen.has(key)) continue;
    const followers = config.copiers.filter((c) => (c.leaders || []).includes(event.agent));
    if (!followers.length) {
      // Nobody follows this agent: mark seen so the relayer does not
      // rescan the event forever.
      seen.add(key);
      continue;
    }
    let allHandled = true;
    for (const copier of followers) {
      try {
        const result = await processEvent(event, copier);
        if (result === 'copied') acted += 1;
      } catch (e) {
        if (isSkipError(e)) {
          console.log(`  skip (onchain rule): ${String(e.message).slice(0, 120)}`);
        } else {
          console.log(`  ERROR copying ${key} for ${copier.accountId}: ${String(e && e.message ? e.message : e).slice(0, 160)} (will retry next pass)`);
          allHandled = false;
        }
      }
    }
    // Only mark seen once every following copier handled it (or was
    // correctly skipped); a transient failure retries next pass.
    if (allHandled) seen.add(key);
  }
  saveState();
  return acted;
}

console.log(`PAC copy relayer — arena ${ARENA_ID}, ${config.copiers.length} copier(s), poll ${POLL}ms`);
for (const c of config.copiers) {
  console.log(`  copier ${c.accountId} follows ${(c.leaders || []).join(', ') || '(none)'}`);
}
if (once) {
  const acted = await pass();
  console.log(`single pass done, ${acted} copy trade(s) submitted`);
} else {
  for (;;) {
    try {
      const acted = await pass();
      if (acted > 0) console.log(`pass done: ${acted} copy trade(s)`);
    } catch (e) {
      console.log('pass failed:', String(e && e.message ? e.message : e).slice(0, 200));
    }
    await sleep(POLL);
  }
}
