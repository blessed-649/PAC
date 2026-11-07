// PAC AI meme judge service.
//
// For a given coin and day, fetches the day's meme submissions from the
// arena, scores each meme's text with NEAR AI Cloud (z-ai/glm-5.3-flash)
// on humor, originality and relevance, fetches the TEE attestation
// evidence for the call, and records each score onchain with
// record_ai_score, signed by the arena account (the judge).
//
// The AI score is stored onchain and combines 50/50 with the community
// vote to pick the daily winner. The attestation reference stored
// onchain is the SHA-256 hex digest of the NEAR AI attestation evidence
// for that scoring call.
//
// API key: read ONLY from the PAC_NEAR_AI_API_KEY environment variable.
// If it is missing the service exits non-zero and does nothing (fail
// closed). The key is never printed, never written to a file, and never
// committed. Get a key at https://cloud.near.ai (NEAR AI Cloud).
//
// Usage:
//   PAC_NEAR_AI_API_KEY=... node scripts/ai-meme-judge.mjs --coin 0 --day 0
//   PAC_NEAR_AI_API_KEY=... node scripts/ai-meme-judge.mjs --coin 0 --day 0 --dry-run
//   PAC_NEAR_AI_API_KEY=... node scripts/ai-meme-judge.mjs --coin 0 --day 0 --force
//   PAC_NEAR_AI_MODEL=z-ai/glm-5.3-flash node scripts/ai-meme-judge.mjs --coin 0
// --day defaults to the current day for the coin (days since the coin
// was created). --dry-run prints the scores and never submits them
// onchain. --force re-scores submissions that already have an AI score.
//
// The exact judging prompt (reproducible; the model must reply with
// JSON only):
//   SYSTEM: You are a meme judge for a memecoin arena. Score the meme
//   text on three dimensions, each 0 to 100: humor (how funny is it),
//   originality (how fresh and unexpected is it), relevance (how well
//   does it fit the coin and its community). Reply with ONLY a JSON
//   object: {"humor": <0-100>, "originality": <0-100>, "relevance":
//   <0-100>}. No other text.
//   USER: Coin: <name> ($<symbol>)
//         Meme text: <text>
//         Score it.
//
// Submissions with no meme_text are skipped: the AI judges the text,
// not the hash. A submission that already has an AI score is skipped
// unless --force is passed.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';

const ARENA_ID = 'pac-arena.testnet';
const ACCOUNTS_FILE = new URL('../.testnet-accounts.json', import.meta.url);
const RPC = 'https://rpc.testnet.fastnear.com';
const NEAR_AI_BASE = 'https://cloud-api.near.ai/v1';
const DEFAULT_MODEL = 'z-ai/glm-5.3-flash';
const MEME_DAY_MS = 24 * 60 * 60 * 1000;

const API_KEY = process.env.PAC_NEAR_AI_API_KEY;
if (!API_KEY) {
  console.error('ai-meme-judge: PAC_NEAR_AI_API_KEY is not set. Refusing to run (fail closed).');
  console.error('Get a NEAR AI Cloud key at https://cloud.near.ai and set PAC_NEAR_AI_API_KEY.');
  process.exit(1);
}
const MODEL = process.env.PAC_NEAR_AI_MODEL || DEFAULT_MODEL;

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const COIN_ID = Number(arg('--coin', '0'));
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
let dayArg = arg('--day', null);
if (Number.isNaN(COIN_ID) || COIN_ID < 0) {
  console.error('ai-meme-judge: --coin must be a non-negative integer');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- NEAR AI Cloud -------------------------------------------------------
async function attestationHash() {
  // Preflight: fetch the TEE attestation evidence with a fresh nonce,
  // trusted only when the gateway or model report echoes that nonce.
  // Returns the SHA-256 hex digest of the evidence (the reference
  // stored onchain), or null if the evidence could not be verified.
  const nonce = crypto.randomBytes(32).toString('hex');
  const url = `${NEAR_AI_BASE}/attestation/report?model=${encodeURIComponent(MODEL)}&signing_algo=ecdsa&nonce=${nonce}`;
  const res = await fetch(url, { headers: { 'x-no-aliasing': 'true', Authorization: `Bearer ${API_KEY}` } });
  if (!res.ok) throw new Error(`attestation report failed: HTTP ${res.status}`);
  const ev = await res.json();
  const gateway = ev.gateway_attestation || {};
  const models = ev.model_attestations || [];
  const firstModel = models[0] || {};
  if (gateway.request_nonce !== nonce && firstModel.request_nonce !== nonce) {
    console.error('ai-meme-judge: attestation nonce mismatch, evidence not trusted');
    return null;
  }
  const digest = crypto.createHash('sha256').update(JSON.stringify(ev)).digest('hex');
  return digest;
}

const JUDGE_SYSTEM_PROMPT = 'You are a meme judge for a memecoin arena. Score the meme text on three dimensions, each 0 to 100: humor (how funny is it), originality (how fresh and unexpected is it), relevance (how well does it fit the coin and its community). Reply with ONLY a JSON object: {"humor": <0-100>, "originality": <0-100>, "relevance": <0-100>}. No other text.';

async function scoreMeme(coinName, coinSymbol, memeText) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: JUDGE_SYSTEM_PROMPT },
      { role: 'user', content: `Coin: ${coinName} ($${coinSymbol})\nMeme text: ${memeText}\nScore it.` },
    ],
    temperature: 0.3,
    max_tokens: 800,
  };
  const res = await fetch(`${NEAR_AI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-no-aliasing': 'true',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`chat completion failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const result = await res.json();
  const content = (((result.choices || [])[0] || {}).message || {}).content || '';
  const match = content.match(/\{[^}]*\}/);
  if (!match) throw new Error(`model did not return JSON: ${content.slice(0, 200)}`);
  const parsed = JSON.parse(match[0]);
  const clamp = (v) => Math.max(0, Math.min(100, Math.round(Number(v))));
  const humor = clamp(parsed.humor);
  const originality = clamp(parsed.originality);
  const relevance = clamp(parsed.relevance);
  if (!Number.isFinite(humor) || !Number.isFinite(originality) || !Number.isFinite(relevance)) {
    throw new Error(`model returned non-numeric scores: ${content.slice(0, 200)}`);
  }
  return { humor, originality, relevance, total: humor + originality + relevance };
}

// --- NEAR ---------------------------------------------------------------
const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', accounts.arena.accountId, KeyPair.fromString(accounts.arena.privateKey));
const near = await connect({
  networkId: 'testnet', nodeUrl: RPC,
  walletUrl: 'https://testnet.mynearwallet.com/',
  helperUrl: 'https://helper.testnet.near.org', keyStore,
});
const arena = await near.account(ARENA_ID);
const parseNear = (n) => utils.format.parseNearAmount(n);
async function view(method, argsObj = {}) {
  let delay = 2000;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return await arena.viewFunction({ contractId: ARENA_ID, methodName: method, args: argsObj });
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      if ((!msg.includes('429') && !msg.includes('503') && !msg.includes('502')) || attempt === 6) throw e;
      await sleep(delay); delay *= 2;
    }
  }
}

// --- main ---------------------------------------------------------------
const coin = await view('get_coin', { coin_id: COIN_ID });
if (!coin) {
  console.error(`ai-meme-judge: coin ${COIN_ID} does not exist on ${ARENA_ID}`);
  process.exit(1);
}
const createdMs = Number(BigInt(coin.created_at_ns) / 1000000n);
const today = Math.floor((Date.now() - createdMs) / MEME_DAY_MS);
const day = dayArg === null ? today : Number(dayArg);
if (Number.isNaN(day) || day < 0) {
  console.error('ai-meme-judge: --day must be a non-negative integer');
  process.exit(1);
}
const memeDay = await view('get_meme_day', { coin_id: COIN_ID, day });
if (!memeDay || !memeDay.submissions || memeDay.submissions.length === 0) {
  console.log(`ai-meme-judge: coin ${COIN_ID} day ${day} has no meme submissions. Nothing to score.`);
  process.exit(0);
}
console.log(`ai-meme-judge: coin ${COIN_ID} (${coin.name} $${coin.symbol}) day ${day}, ${memeDay.submissions.length} submission(s), model ${MODEL}${DRY_RUN ? ' (dry run)' : ''}`);

let scored = 0;
let skipped = 0;
for (let i = 0; i < memeDay.submissions.length; i++) {
  const sub = memeDay.submissions[i];
  if (!sub.meme_text) {
    console.log(`  [${i}] ${sub.submitter}: no meme text, skipped (the AI judges the text, not the hash)`);
    skipped++;
    continue;
  }
  if (sub.ai_score && !FORCE) {
    console.log(`  [${i}] ${sub.submitter}: already scored (total ${sub.ai_score.total}), skipped (use --force to re-score)`);
    skipped++;
    continue;
  }
  console.log(`  [${i}] ${sub.submitter}: scoring "${sub.meme_text.slice(0, 80)}${sub.meme_text.length > 80 ? '...' : ''}"`);
  const attHash = await attestationHash();
  if (!attHash) {
    console.error(`  [${i}] attestation could not be verified, refusing to record a score`);
    process.exit(1);
  }
  const score = await scoreMeme(coin.name, coin.symbol, sub.meme_text);
  console.log(`  [${i}] AI score: humor ${score.humor}, originality ${score.originality}, relevance ${score.relevance}, total ${score.total}/300, attestation ${attHash.slice(0, 16)}...`);
  if (DRY_RUN) {
    console.log(`  [${i}] dry run: not submitted onchain`);
    scored++;
    continue;
  }
  await arena.functionCall({
    contractId: ARENA_ID,
    methodName: 'record_ai_score',
    args: {
      coin_id: COIN_ID, day, submission_index: i,
      humor: score.humor, originality: score.originality, relevance: score.relevance,
      attestation_hash: attHash,
    },
    gas: 100_000_000_000_000n,
    attachedDeposit: BigInt(parseNear('0')),
  });
  console.log(`  [${i}] recorded onchain via record_ai_score`);
  scored++;
  await sleep(2000);
}
console.log(`ai-meme-judge: done. Scored ${scored}, skipped ${skipped}, day ${day}, coin ${COIN_ID}.`);
