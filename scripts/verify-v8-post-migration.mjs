// Finish the v8 post-migration verification that migrate-live-arena-v8.mjs
// could not complete: it crashed destructuring a null meme day (coin 2
// day 0 has no meme day at all, so get_meme_day returns null). Read-only
// except the final second-migrate check, which must fail. Compares the
// live v8 state against migration-v8-snapshot.json.
import fs from 'node:fs';
import { connect, keyStores, KeyPair } from 'near-api-js';

const ACCOUNTS_FILE = new URL('../.testnet-accounts.json', import.meta.url);
const SNAP = JSON.parse(fs.readFileSync(new URL('../migration-v8-snapshot.json', import.meta.url), 'utf8'));
const ARENA_ID = 'pac-arena.testnet';
const RPC = 'https://rpc.testnet.fastnear.com';

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', accounts.arena.accountId, KeyPair.fromString(accounts.arena.privateKey));
const near = await connect({ networkId: 'testnet', nodeUrl: RPC, walletUrl: 'https://testnet.mynearwallet.com/', helperUrl: 'https://helper.testnet.near.org', keyStore });
const arena = await near.account(ARENA_ID);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function view(m, a = {}) {
  for (let i = 1; i <= 6; i++) {
    try { return await arena.viewFunction({ contractId: ARENA_ID, methodName: m, args: a }); }
    catch (e) { if (i === 6) throw e; await sleep(2000 * i); }
  }
}
function eq(label, a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} CHANGED:\n  snapshot: ${JSON.stringify(a)}\n  live:     ${JSON.stringify(b)}`);
  console.log(`  [ok] ${label} unchanged`);
}

const params = await view('get_params', {});
console.log('live schema_version:', params.schema_version);
if (params.schema_version !== 8) throw new Error('schema is not 8');

const season = await view('get_current_season', {});
const after = {
  stats: await view('get_stats', {}),
  coins: [await view('get_coin', { coin_id: 0 }), await view('get_coin', { coin_id: 1 }), await view('get_coin', { coin_id: 2 }), await view('get_coin', { coin_id: 3 })],
  agents: {
    degen: await view('get_agent', { account: accounts.degen.accountId }),
    holder: await view('get_agent', { account: accounts.holder.accountId }),
    sniper: await view('get_agent', { account: accounts.sniper.accountId }),
    isaiah_pac: await view('get_agent', { account: 'isaiah-pac.testnet' }),
    clearsite587: await view('get_agent', { account: 'clearsite587.testnet' }),
  },
  battles: await view('list_battles', { from_index: 0, limit: 20 }),
  votes: await view('list_vote_rounds', { coin_id: 0, from_index: 0, limit: 10 }),
  duels: await view('list_coin_duels', { from_index: 0, limit: 10 }),
  meme_days: [await view('get_meme_day', { coin_id: 0, day: 0 }), await view('get_meme_day', { coin_id: 1, day: 0 }), await view('get_meme_day', { coin_id: 2, day: 0 }), await view('get_meme_day', { coin_id: 3, day: 0 })],
  pool: await view('get_prize_pool', {}),
  season,
  leaderboard: await view('get_season_leaderboard', { season_id: season.id }),
  activity: await view('get_activity', { limit: 100 }),
};

eq('stats', SNAP.stats, after.stats);
after.coins.forEach((c, i) => eq(`coin${i}`, SNAP.coins[i], c));
for (const k of Object.keys(SNAP.agents)) eq(`agent ${k}`, SNAP.agents[k], after.agents[k]);
eq('battles', SNAP.battles, after.battles);
eq('votes', SNAP.votes, after.votes);
eq('duels', SNAP.duels, after.duels);
after.meme_days.forEach((md, i) => {
  const before = SNAP.meme_days[i];
  if (before === null && md === null) { console.log(`  [ok] meme${i} null on both sides (no meme day)`); return; }
  if (before === null || md === null) throw new Error(`meme${i} null mismatch: snapshot=${JSON.stringify(before)} live=${JSON.stringify(md)}`);
  const { judging_complete, ...rest } = md;
  if (JSON.stringify(before) !== JSON.stringify(rest)) throw new Error(`meme${i} CHANGED (excluding judging_complete)`);
  console.log(`  [ok] meme${i} unchanged except judging_complete=${judging_complete}`);
});
eq('pool', SNAP.pool, after.pool);
eq('season', SNAP.season, after.season);
eq('leaderboard', SNAP.leaderboard, after.leaderboard);
eq('activity', SNAP.activity, after.activity);

// v8 params
const checks = [
  ['schema_version', params.schema_version, 8],
  ['battle_min_stake_yocto', params.battle_min_stake_yocto, '100000000000000000000000'],
  ['coin_duel_min_volume_yocto', params.coin_duel_min_volume_yocto, '100000000000000000000000'],
  ['coin_duel_pair_cap_yocto', params.coin_duel_pair_cap_yocto, '1000000000000000000000000'],
  ['meme_judging_grace_ns', params.meme_judging_grace_ns, 3600000000000],
  ['rep_weight_pnl', params.rep_weight_pnl, 30],
  ['rep_weight_win_rate', params.rep_weight_win_rate, 20],
  ['rep_weight_hold_time', params.rep_weight_hold_time, 15],
  ['rep_weight_trade_count', params.rep_weight_trade_count, 15],
  ['rep_weight_drawdown', params.rep_weight_drawdown, 20],
  ['trading_fee_bp', params.trading_fee_bp, 100],
  ['ai_weight_bp', params.ai_weight_bp, 5000],
  ['min_qualified_holding_tokens', params.min_qualified_holding_tokens, '10000'],
];
for (const [k, got, want] of checks) {
  if (String(got) !== String(want)) throw new Error(`param ${k}: got ${got}, want ${want}`);
  console.log(`  [ok] param ${k} = ${got}`);
}
console.log('  [ok] agent_registration_enabled =', params.agent_registration_enabled);

// Second migrate must fail.
try {
  await arena.functionCall({ contractId: ARENA_ID, methodName: 'migrate', args: {}, gas: 100_000_000_000_000n, attachedDeposit: 0n });
  throw new Error('second migrate() SUCCEEDED but must fail');
} catch (e) {
  if (String(e.message).includes('second migrate() SUCCEEDED')) throw e;
  console.log('  [ok] second migrate() correctly rejected:', String(e.message).slice(0, 160));
}
console.log('\nPOST-MIGRATION VERIFICATION COMPLETE — pac-arena.testnet is v8, all live state intact.');
