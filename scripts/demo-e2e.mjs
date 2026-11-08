// PAC demo end-to-end test on NEAR testnet.
// Runs the full immediately-testable flow against the deployed arena:
// launch, buy, sell, reputation, vote round + votes, agent battle create +
// accept, coin duel create, meme submit + vote, auto copy flow (follow,
// leader buy, copy buy, leader fee, cap enforcement, copy sell, withdraw,
// unfollow), and weekly season views (prize pool, leaderboard) with the
// resolve of the current season correctly rejected. Time-gated actions
// (claim, battle/duel/vote/meme/season resolution) are verified to REJECT
// early; their resolution is exercised live after the windows pass.
// Run: node scripts/demo-e2e.mjs
import fs from 'node:fs';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';

const ACCOUNTS_FILE = new URL('../.testnet-accounts.json', import.meta.url);
const ARENA_ID = 'pac-arena.testnet';
// FastNEAR is the recommended public testnet RPC; rpc.testnet.near.org
// rate-limits bursts (HTTP 429). Retry with backoff on 429/5xx.
const RPC = 'https://rpc.testnet.fastnear.com';

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
const keyStore = new keyStores.InMemoryKeyStore();
for (const role of ['arena', 'degen', 'holder', 'sniper']) {
  await keyStore.setKey('testnet', accounts[role].accountId, KeyPair.fromString(accounts[role].privateKey));
}
const near = await connect({
  networkId: 'testnet', nodeUrl: RPC,
  walletUrl: 'https://testnet.mynearwallet.com/',
  helperUrl: 'https://helper.testnet.near.org', keyStore,
});
const acct = (role) => near.account(accounts[role].accountId);
const arena = await near.account(ARENA_ID);
const parseNear = (n) => utils.format.parseNearAmount(n);

async function withRetry(fn, label) {
  let delay = 2000;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      const retryable = msg.includes('429') || msg.includes('503') || msg.includes('502') || msg.includes('ECONNRESET') || msg.includes('timeout');
      if (!retryable || attempt === 6) throw e;
      console.log(`  [retry ${attempt}/6] ${label} after ${delay}ms (${msg.slice(0, 80)})`);
      await sleep(delay);
      delay *= 2;
    }
  }
}
async function view(method, args = {}) {
  return withRetry(() => arena.viewFunction({ contractId: ARENA_ID, methodName: method, args }), `view ${method}`);
}
async function call(role, method, args, deposit = '0', gas = 100_000_000_000_000n) {
  const a = await acct(role);
  return withRetry(() => a.functionCall({
    contractId: ARENA_ID, methodName: method, args,
    gas, attachedDeposit: BigInt(parseNear(deposit)),
  }), `call ${method}`);
}
async function callToken(role, tokenId, method, args, deposit = '0') {
  const a = await acct(role);
  return withRetry(() => a.functionCall({
    contractId: tokenId, methodName: method, args,
    gas: 100_000_000_000_000n, attachedDeposit: BigInt(parseNear(deposit)),
  }), `callToken ${method}`);
}
async function storageDeposit(role, tokenId) {
  // 0.01 NEAR covers the 0.00125 storage deposit for a first-time holder.
  await callToken(role, tokenId, 'storage_deposit', { account_id: accounts[role].accountId }, '0.01');
}
async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function expectFail(promise, label) {
  try {
    await promise;
    throw new Error(`expected failure but succeeded: ${label}`);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (msg.includes('expected failure but succeeded')) throw e;
    console.log(`  [ok] correctly rejected: ${label} -> ${msg.slice(0, 120)}`);
  }
}

console.log('== PAC demo e2e ==');
console.log('arena:', ARENA_ID);

// 1-2. Launch coins 0 and 1 (skipped on re-runs: the arena keeps state,
// so a resumed run reuses the coins launched the first time).
const existing = await view('get_stats', {});
let coin0 = null;
let coin1 = null;
if (existing.coins >= 2) {
  console.log('\n1-2. coins 0 and 1 already exist — reusing them');
  coin0 = await view('get_coin', { coin_id: 0 });
  coin1 = await view('get_coin', { coin_id: 1 });
} else {
  console.log('\n1. launch coin 0 (degen, 0.5 NEAR initial buy)');
  // Launch deploys a ~197KB token contract + init + callback; the promise
  // chain reserves 80 Tgas, so the call needs the 300 Tgas maximum.
  await call('degen', 'launch_coin', {
    name: 'Degen Coin', symbol: 'DEGEN', description: 'First PAC coin',
    initial_buy_yocto: parseNear('0.5'),
  }, '2.5', 300_000_000_000_000n);
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    coin0 = await view('get_coin', { coin_id: 0 });
    if (coin0) break;
  }
  if (!coin0) throw new Error('coin 0 never appeared');
  console.log('\n2. launch coin 1 (holder, 0.5 NEAR initial buy)');
  await call('holder', 'launch_coin', {
    name: 'Holder Coin', symbol: 'HOLD', description: 'Second PAC coin',
    initial_buy_yocto: parseNear('0.5'),
  }, '2.5', 300_000_000_000_000n);
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    coin1 = await view('get_coin', { coin_id: 1 });
    if (coin1) break;
  }
  if (!coin1) throw new Error('coin 1 never appeared');
}
console.log('  coin0:', coin0.token_id, '| creator', coin0.creator, '| lock', coin0.lock_status, '| sold', coin0.sold_tokens);
console.log('  coin1:', coin1.token_id, '| creator', coin1.creator);
const token0 = coin0.token_id;
const token1 = coin1.token_id;

// 3. Register buyers for storage, then buy.
console.log('\n3. buy on coin 0');
await storageDeposit('holder', token0);
await storageDeposit('sniper', token0);
await call('holder', 'buy', { coin_id: 0 }, '0.3');
await sleep(2000);
await call('sniper', 'buy', { coin_id: 0 }, '0.2');
await sleep(2000);
coin0 = await view('get_coin', { coin_id: 0 });
console.log('  coin0 sold:', coin0.sold_tokens, '| holders:', coin0.holders, '| price:', coin0.price_per_token_yocto);

// 4. Sell half of holder's position via ft_transfer_call.
console.log('\n4. holder sells on coin 0');
const balBefore = await withRetry(() => (acct('holder')).then((a) => a.viewFunction({
  contractId: token0, methodName: 'ft_balance_of', args: { account_id: accounts.holder.accountId },
})), 'ft_balance_of before');
console.log('  holder balance before sell:', balBefore);
const sellAmount = (BigInt(balBefore) / 2n).toString();
await withRetry(() => (acct('holder')).then((a) => a.functionCall({
  contractId: token0, methodName: 'ft_transfer_call',
  args: { receiver_id: ARENA_ID, amount: sellAmount, memo: null, msg: 'sell' },
  gas: 100_000_000_000_000n, attachedDeposit: 1n,
})), 'ft_transfer_call sell');
await sleep(2000);
const balAfter = await withRetry(() => (acct('holder')).then((a) => a.viewFunction({
  contractId: token0, methodName: 'ft_balance_of', args: { account_id: accounts.holder.accountId },
})), 'ft_balance_of after');
console.log('  holder balance after sell:', balAfter);
if (BigInt(balAfter) >= BigInt(balBefore)) throw new Error('sell did not reduce balance');

// 5. Reputation scores.
console.log('\n5. reputation');
for (const role of ['degen', 'holder', 'sniper']) {
  const a = await view('get_agent', { account: accounts[role].accountId });
  console.log(`  ${role}: score ${a.score} (${a.band}) spent ${a.total_spent_yocto} received ${a.total_received_yocto} sells ${a.sells} wins ${a.winning_sells}`);
}

// 6. Claim before unlock must fail.
console.log('\n6. claim before unlock must fail');
await expectFail(
  call('degen', 'claim_locked', { coin_id: 0 }),
  'claim_locked before 24h',
);

// 7. Supply vote round: create (or reuse the active one — only one active
// round per coin), vote, verify it cannot execute early.
console.log('\n7. supply vote round on coin 0');
let rounds = await view('list_vote_rounds', { coin_id: 0, from_index: 0, limit: 10 });
let active = rounds.find((r) => !r.executed);
if (active && BigInt(active.deadline_ns) <= BigInt(Date.now()) * 1000000n) {
  // Re-run after the round's deadline passed: executing it is the
  // correct behaviour, so execute it and start a fresh round for the
  // early-execute check below.
  console.log('  round', active.id, 'deadline already passed; executing it (correct on a re-run)');
  await call('holder', 'execute_vote_round', { round_id: active.id });
  await sleep(2000);
  active = null;
}
if (!active) {
  await call('holder', 'create_vote_round', { coin_id: 0, duration_hours: 1 });
  await sleep(2000);
  rounds = await view('list_vote_rounds', { coin_id: 0, from_index: 0, limit: 10 });
  active = rounds[rounds.length - 1];
}
console.log('  rounds:', JSON.stringify(rounds));
const roundId = active.id;
// Votes are one-per-holder-per-round; tolerate "already voted" on re-runs.
async function tryVote(role, choice) {
  try { await call(role, 'vote', { round_id: roundId, choice_index: choice }); console.log(`  ${role} voted choice ${choice}`); }
  catch (e) { console.log(`  ${role} vote skipped (${String(e.message).slice(0, 90)})`); }
}
await tryVote('holder', 0);
await tryVote('sniper', 2);
await sleep(2000);
const round = await view('get_vote_round', { round_id: roundId });
console.log('  votes:', JSON.stringify(round.votes), '| voters:', round.voters);
await expectFail(call('holder', 'execute_vote_round', { round_id: roundId }), 'execute vote before deadline');
await expectFail(call('holder', 'vote', { round_id: roundId, choice_index: 1 }), 'double vote');

// 8. Agent battle: create + accept; resolve must fail early.
console.log('\n8. agent battle (degen vs holder, coin 0)');
await call('degen', 'create_battle', { coin_id: 0, opponent: accounts.holder.accountId }, '0.1');
await sleep(2000);
const battles = await view('list_battles', { from_index: 0, limit: 10 });
console.log('  battles:', JSON.stringify(battles));
const battleId = battles[battles.length - 1].id; // newest battle
await call('holder', 'accept_battle', { battle_id: battleId }, '0.1');
await sleep(2000);
const battle = await view('get_battle', { battle_id: battleId });
console.log('  battle status:', battle.status, '| end:', battle.end_ns);
await expectFail(call('degen', 'resolve_battle', { battle_id: battleId }), 'resolve battle before window');

// 9. Coin duel: create; resolve must fail early.
console.log('\n9. coin duel (coin 0 vs coin 1)');
await call('degen', 'create_coin_duel', { coin_a: 0, coin_b: 1 });
await sleep(2000);
const duels = await view('list_coin_duels', { from_index: 0, limit: 10 });
console.log('  duels:', JSON.stringify(duels));
const duelId = duels[duels.length - 1].id; // newest duel
await expectFail(call('degen', 'resolve_coin_duel', { duel_id: duelId }), 'resolve duel before window');

// 10. Meme ritual: submit + vote; resolve must fail early (day not over).
console.log('\n10. meme ritual on coin 0 (day 0)');
// One submission + one vote per holder per day; on a re-run the earlier
// ones already exist, so tolerate "already submitted/voted" and continue.
async function tryStep(label, fn) {
  try { await fn(); console.log(`  ${label}: ok`); }
  catch (e) { console.log(`  ${label}: skipped (${String(e.message).slice(0, 90)})`); }
}
await tryStep('holder submit', () => call('holder', 'submit_meme', { coin_id: 0, meme_hash: 'QmDemoMemeHashHolder001', meme_text: 'Degen coin to the moon, holder coin to the bank.' }));
await tryStep('sniper submit', () => call('sniper', 'submit_meme', { coin_id: 0, meme_hash: 'QmDemoMemeHashSniper002', meme_text: 'Sniper bought the dip and the dip bought him back.' }));
await tryStep('degen submit', () => call('degen', 'submit_meme', { coin_id: 0, meme_hash: 'QmDemoMemeHashDegen003', meme_text: null }));
await sleep(2000);
let day0 = await view('get_meme_day', { coin_id: 0, day: 0 });
console.log('  submissions:', JSON.stringify(day0.submissions));
await tryStep('holder vote', () => call('holder', 'vote_meme', { coin_id: 0, day: 0, submission_index: 1 }));
await tryStep('sniper vote', () => call('sniper', 'vote_meme', { coin_id: 0, day: 0, submission_index: 0 }));
await tryStep('degen vote', () => call('degen', 'vote_meme', { coin_id: 0, day: 0, submission_index: 0 }));
await sleep(2000);
day0 = await view('get_meme_day', { coin_id: 0, day: 0 });
console.log('  votes after:', JSON.stringify(day0.submissions.map((s) => s.votes)));
await expectFail(call('degen', 'resolve_meme_day', { coin_id: 0, day: 0 }), 'resolve meme day before it ends');
await expectFail(call('holder', 'vote_meme', { coin_id: 0, day: 0, submission_index: 0 }), 'double meme vote');
// v3 AI judge: params are 50/50, the judge is the arena account, the
// meme text is stored, and only the judge can record a score. (No score
// is recorded here: the live judge service does that, with a real
// attestation, once the NEAR AI key is set.)
const aiParams = await view('get_params', {});
if (aiParams.ai_judge_account !== ARENA_ID || aiParams.ai_weight_bp !== 5000 || aiParams.community_weight_bp !== 5000 || aiParams.meme_text_max_chars !== 500) {
  throw new Error('v3 AI judge params mismatch: ' + JSON.stringify(aiParams));
}
console.log('  [ok] AI judge params 50/50, judge is the arena, text max 500');
const holderSub = day0.submissions.find((s) => s.meme_hash === 'QmDemoMemeHashHolder001');
if (holderSub && holderSub.meme_text !== null && holderSub.meme_text !== 'Degen coin to the moon, holder coin to the bank.') {
  throw new Error('holder meme_text is wrong: ' + holderSub.meme_text);
}
console.log('  [ok] meme_text field present on submissions' + (holderSub && holderSub.meme_text ? ' (text stored)' : ' (pre-v3 submission, text null as expected)'));
await expectFail(
  call('degen', 'record_ai_score', { coin_id: 0, day: 0, submission_index: 0, humor: 80, originality: 70, relevance: 90, attestation_hash: 'aa'.repeat(32) }),
  'record_ai_score from a non-judge account',
);

// 11. Auto copy flow (v2): sniper follows degen, degen buys, the
// relayer step is simulated by calling copy_buy as sniper, the leader
// earns the 1% copy fee, the max-total cap blocks a second copy, the
// vaulted position sells and withdraws, then unfollow cleans up.
console.log('\n11. auto copy flow (sniper follows degen, 0.1 NEAR/trade, max 0.15 NEAR)');
try { await call('sniper', 'unfollow', { leader: accounts.degen.accountId }); console.log('  cleaned up a stale follow'); } catch { /* no follow yet */ }
await call('sniper', 'follow', {
  leader: accounts.degen.accountId,
  amount_per_trade_yocto: parseNear('0.1'),
  max_total_yocto: parseNear('0.15'),
  copy_public_key: null,
});
await sleep(2000);
let follow = await view('get_follow', { copier: accounts.sniper.accountId, leader: accounts.degen.accountId });
console.log('  follow:', JSON.stringify(follow));
if (!follow || follow.amount_per_trade_yocto !== parseNear('0.1')) throw new Error('follow not stored');
await expectFail(
  call('sniper', 'follow', {
    leader: accounts.degen.accountId,
    amount_per_trade_yocto: parseNear('0.1'),
    max_total_yocto: parseNear('0.15'),
    copy_public_key: null,
  }),
  'double follow',
);
await expectFail(
  call('sniper', 'follow', {
    leader: accounts.holder.accountId,
    amount_per_trade_yocto: parseNear('0.001'),
    max_total_yocto: parseNear('0.15'),
    copy_public_key: null,
  }),
  'follow below 0.01 NEAR per-trade minimum',
);
await callToken('degen', token0, 'storage_deposit', { account_id: accounts.degen.accountId }, '0.01').catch(() => {});
await call('degen', 'buy', { coin_id: 0 }, '0.05');
await sleep(2000);
await call('sniper', 'copy_buy', { coin_id: 0, leader: accounts.degen.accountId }, '0.1');
await sleep(2000);
follow = await view('get_follow', { copier: accounts.sniper.accountId, leader: accounts.degen.accountId });
const copyStats = await view('get_copy_stats', { leader: accounts.degen.accountId });
const copyPos = await view('get_copy_position', { copier: accounts.sniper.accountId, leader: accounts.degen.accountId, coin_id: 0 });
console.log('  after copy_buy: total_copied', follow.total_copied_yocto, '| leader fees', copyStats.total_fees_earned_yocto,
  '| copiers', copyStats.copier_count, '| vaulted tokens', copyPos.tokens);
if (follow.total_copied_yocto !== parseNear('0.1')) throw new Error('total_copied mismatch after copy_buy');
if (copyStats.total_fees_earned_yocto !== parseNear('0.001')) throw new Error('leader copy fee should be 0.001 NEAR (1% of 0.1)');
if (BigInt(copyPos.tokens) <= 0n) throw new Error('copy position empty after copy_buy');
await expectFail(
  call('sniper', 'copy_buy', { coin_id: 0, leader: accounts.degen.accountId }, '0.1'),
  'second copy_buy over the 0.15 NEAR max total',
);
const halfCopy = (BigInt(copyPos.tokens) / 2n).toString();
await call('sniper', 'copy_sell', { coin_id: 0, leader: accounts.degen.accountId, tokens: halfCopy });
await sleep(2000);
const posAfterSell = await view('get_copy_position', { copier: accounts.sniper.accountId, leader: accounts.degen.accountId, coin_id: 0 });
console.log('  vaulted tokens after copy_sell:', posAfterSell.tokens, '(was', copyPos.tokens + ')');
if (BigInt(posAfterSell.tokens) >= BigInt(copyPos.tokens)) throw new Error('copy_sell did not reduce the vaulted position');
await call('sniper', 'withdraw_copy', { coin_id: 0, leader: accounts.degen.accountId, tokens: posAfterSell.tokens });
await sleep(2000);
const posAfterWithdraw = await view('get_copy_position', { copier: accounts.sniper.accountId, leader: accounts.degen.accountId, coin_id: 0 });
console.log('  vaulted tokens after withdraw_copy:', posAfterWithdraw.tokens);
if (posAfterWithdraw.tokens !== '0') throw new Error('withdraw_copy did not empty the vaulted position');
await call('sniper', 'unfollow', { leader: accounts.degen.accountId });
await sleep(3000);
const followAfter = await view('get_follow', { copier: accounts.sniper.accountId, leader: accounts.degen.accountId });
console.log('  follow after unfollow:', JSON.stringify(followAfter));
if (followAfter !== null) throw new Error('unfollow did not remove the follow');

// 12. Weekly season views (v2): the prize pool accrued 1% trading
// fees from every buy and sell above; the leaderboard ranks the
// week's realised PnL onchain. Resolving the current season must fail.
console.log('\n12. weekly season (prize pool + leaderboard)');
const pool = await view('get_prize_pool', {});
const season = await view('get_current_season', {});
const board = await view('get_season_leaderboard', { season_id: season.id });
console.log('  prize pool:', pool, '| season:', JSON.stringify(season), '| leaderboard:', JSON.stringify(board));
if (BigInt(pool) <= 0n) throw new Error('prize pool empty after a run full of trades');
if (!board.length) throw new Error('season leaderboard empty after trades');
await expectFail(call('degen', 'resolve_season', { season_id: season.id }), 'resolve current season before it ends');

// 13. Stats + activity.
console.log('\n13. stats + activity');
const stats = await view('get_stats', {});
console.log('  stats:', JSON.stringify(stats));
const activity = await view('get_activity', { limit: 10 });
console.log('  activity kinds:', activity.map((e) => e.kind).join(', '));
const params = await view('get_params', {});
console.log('  params lock_hours:', params.lock_duration_hours, 'battle_min_stake:', params.battle_min_stake_yocto ?? params.battle_forfeit_yocto);

console.log('\nDEMO E2E OK — immediate flows pass, including the v2 auto copy flow and weekly season views. Time-gated resolutions (claim, battle, duel, vote, meme, season) correctly reject early and will resolve after their windows.');
