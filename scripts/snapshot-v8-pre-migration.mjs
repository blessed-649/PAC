// One-off pre-migration snapshot of the live v7 arena, saved to
// ~/workspace/pac/migration-v8-snapshot.json for diagnosis if the
// migration fails. Read-only views only; no transaction is sent.
import fs from 'node:fs';
import { connect, keyStores, KeyPair } from 'near-api-js';

const ACCOUNTS_FILE = new URL('../.testnet-accounts.json', import.meta.url);
const OUT = new URL('../migration-v8-snapshot.json', import.meta.url);
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

const season = await view('get_current_season', {});
const snap = {
  taken_at_utc: new Date().toISOString(),
  arena: ARENA_ID,
  params: await view('get_params', {}),
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
fs.writeFileSync(OUT, JSON.stringify(snap, null, 2));
console.log('snapshot saved to migration-v8-snapshot.json');
console.log('schema_version:', snap.params.schema_version, '| stats:', JSON.stringify(snap.stats));
console.log('coins sold:', snap.coins.map((c) => c.sold_tokens).join(', '), '| pool:', snap.pool);
console.log('scores degen/holder/sniper/isaiah-pac/clearsite:', snap.agents.degen.score, snap.agents.holder.score, snap.agents.sniper.score, snap.agents.isaiah_pac.score, snap.agents.clearsite587.score);
console.log('battles:', JSON.stringify(snap.battles.map((b) => ({ id: b.id, status: b.status, challenger: b.challenger, opponent: b.opponent }))));
