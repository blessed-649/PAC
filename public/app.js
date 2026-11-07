// PAC demo frontend — reads via raw NEAR RPC, writes via MyNearWallet.
// Arena: pac-arena.testnet (NEAR testnet). All amounts in views are decimal
// strings (yoctoNEAR or whole tokens); parse them with BigInt, never Number.
const ARENA_ID = 'pac-arena.testnet';
// FastNEAR is the recommended public testnet RPC; the NEAR.org endpoint
// rate-limits bursts (HTTP 429), so reads fall back to it on failure.
const RPC_URLS = ['https://rpc.testnet.fastnear.com', 'https://rpc.testnet.near.org'];
const RPC_URL = RPC_URLS[0];
const EXPLORER = 'https://testnet.nearblocks.io';
const NEAR = 10n ** 24n;
const GAS_LAUNCH = 300_000_000_000_000n; // launch deploys a ~197KB token contract
const GAS_STD = 100_000_000_000_000n;
const BATTLE_FORFEIT_NEAR = '0.1';

document.getElementById('arenaLink').href = EXPLORER + '/address/' + ARENA_ID;

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function status(msg, ms = 6000) {
  const el = $('status');
  el.textContent = msg;
  el.classList.remove('hidden');
  if (ms) setTimeout(() => el.classList.add('hidden'), ms);
}
function fmtNear(yoctoStr) {
  try {
    const v = BigInt(yoctoStr);
    const neg = v < 0n;
    const a = neg ? -v : v;
    const whole = a / NEAR;
    const frac = a % NEAR;
    const fracStr = frac.toString().padStart(24, '0').slice(0, 4).replace(/0+$/, '') || '0';
    return (neg ? '-' : '') + whole.toString() + '.' + fracStr;
  } catch { return String(yoctoStr); }
}
function fmtInt(str) {
  try { return BigInt(str).toLocaleString('en-US'); } catch { return String(str); }
}
function fmtTime(ns) {
  const d = new Date(Number(BigInt(ns) / 1000000n));
  return d.toLocaleString();
}
function timeAgo(ns) {
  const diff = Date.now() - Number(BigInt(ns) / 1000000n);
  if (diff < 60000) return Math.max(1, Math.floor(diff / 1000)) + 's ago';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}
function parseNearFloat(s) {
  // "1.5" NEAR -> yocto BigInt. Avoids float precision loss.
  const [w, f = ''] = String(s).trim().split('.');
  return BigInt(w || '0') * NEAR + BigInt((f + '0'.repeat(24)).slice(0, 24) || '0');
}
function coinImg(symbol) {
  let h = 0;
  for (const c of symbol) h = (h * 31 + c.charCodeAt(0)) % 360;
  const letters = esc(symbol.slice(0, 3).toUpperCase());
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96'><circle cx='48' cy='48' r='48' fill='hsl(${h},60%,45%)'/><text x='48' y='58' font-size='28' font-family='Arial' font-weight='bold' fill='white' text-anchor='middle'>${letters}</text></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}
function lockBadge(coin) {
  if (coin.lock_status === 'locked') return `<span class="lock locked">Locked until ${fmtTime(coin.unlock_at_ns)}</span>`;
  if (coin.lock_status === 'claimable') return `<span class="lock claimable">Lock expired — claimable</span>`;
  return `<span class="lock claimed">Lock claimed</span>`;
}

// ---------- RPC reads ----------
async function rpcView(contractId, method, args) {
  const argsB64 = btoa(JSON.stringify(args));
  const body = JSON.stringify({ jsonrpc: '2.0', id: 'pac', method: 'query', params: { request_type: 'call_function', account_id: contractId, method_name: method, args_base64: argsB64, finality: 'final' } });
  let lastErr = null;
  for (const url of RPC_URLS) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      const j = await res.json();
      if (j.error) throw new Error(method + ': ' + JSON.stringify(j.error).slice(0, 200));
      const bytes = j.result.result;
      const text = new TextDecoder().decode(new Uint8Array(bytes));
      return JSON.parse(text);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('RPC failed');
}
const view = (method, args = {}) => rpcView(ARENA_ID, method, args);

// ---------- wallet ----------
let wallet = null;
let nearConn = null;
async function initWallet() {
  if (!window.nearApi) { console.warn('near-api-js failed to load; wallet actions unavailable'); return; }
  try {
    const keyStore = new nearApi.keyStores.BrowserLocalStorageKeyStore();
    nearConn = await nearApi.connect({
      networkId: 'testnet', nodeUrl: RPC_URL,
      walletUrl: 'https://testnet.mynearwallet.com/',
      helperUrl: 'https://helper.testnet.near.org', keyStore,
    });
    wallet = new nearApi.WalletConnection(nearConn, 'pac-demo');
    refreshWalletBtn();
  } catch (e) { console.warn('wallet init failed', e); }
}
function refreshWalletBtn() {
  const btn = $('connectBtn');
  if (!wallet) { btn.textContent = 'Wallet unavailable'; btn.disabled = true; return; }
  const id = wallet.getAccountId();
  btn.textContent = id ? id + ' (sign out)' : 'Connect wallet';
  btn.disabled = false;
}
function requireWallet() {
  if (!wallet) { status('Wallet library did not load — check your connection and reload.'); return null; }
  const id = wallet.getAccountId();
  if (!id) { status('Connect your testnet wallet first (top right).'); return null; }
  return id;
}
async function toggleWallet() {
  if (!wallet) return;
  if (wallet.getAccountId()) { wallet.signOut(); refreshWalletBtn(); status('Signed out.'); }
  else { wallet.requestSignIn({ contractId: ARENA_ID }); }
}
async function walletCall(contractId, method, args, depositYocto, gas = GAS_STD) {
  const account = wallet.account();
  return account.functionCall({ contractId, methodName: method, args, gas, attachedDeposit: depositYocto });
}

// ---------- shared state ----------
let coinsCache = [];
let paramsCache = null;

async function loadParams() {
  if (!paramsCache) paramsCache = await view('get_params', {});
  return paramsCache;
}

async function refreshHome() {
  try {
    const [stats, coins, activity, battles, duels] = await Promise.all([
      view('get_stats', {}),
      view('list_coins', { from_index: 0, limit: 50 }),
      view('get_activity', { limit: 50 }),
      view('list_battles', { from_index: 0, limit: 20 }),
      view('list_coin_duels', { from_index: 0, limit: 20 }),
    ]);
    coinsCache = coins;
    $('st-coins').textContent = stats.coins;
    $('st-agents').textContent = stats.agents;
    $('st-trades').textContent = stats.trades;
    $('st-battles').textContent = stats.battles;
    renderCoins(coins);
    renderActivity(activity);
    renderBattles(battles, duels);
    renderLeaderboard(coins, activity);
    const params = await loadParams();
    $('paramsBox').innerHTML = `
      <div class="kv">
        <span>Creator lock</span><b>${params.lock_duration_hours} hours, immutable, enforced by the contract</b>
        <span>Battle</span><b>${params.battle_duration_hours}h window · forfeit ${fmtNear(params.battle_forfeit_yocto)} NEAR · winner takes both stakes</b>
        <span>Reputation</span><b>out of 1000 — realised PnL ${params.rep_weight_pnl}% · win rate ${params.rep_weight_win_rate}% · avg hold time ${params.rep_weight_hold_time}% · rug zeroes the score</b>
        <span>Milestones</span><b>${params.milestone_holders.join(' / ')} holders → burn ${params.milestone_burn_bp / 100}% of supply · +${fmtInt(params.milestone_tranche_tokens)} curve tokens · ${fmtInt(params.milestone_airdrop_tokens)}-token airdrop</b>
        <span>Supply votes</span><b>holders vote by holdings, one vote each · ${params.vote_choices.join(' / ')} · burn/mint ${params.vote_burn_bp / 100}% of supply · ${params.vote_min_duration_hours}–${params.vote_max_duration_hours}h rounds</b>
        <span>Coin duels</span><b>${params.coin_duel_duration_hours}h on trading volume · loser pays ${params.coin_duel_treasury_bp / 100}% of its NEAR treasury</b>
        <span>Daily meme ritual</span><b>every ${params.meme_day_hours}h holders submit a meme hash, community votes, winner stored onchain, submitter earns ${fmtNear(params.meme_reward_yocto)} NEAR from the treasury</b>
        <span>Launch cost</span><b>${fmtNear(params.launch_cost_yocto)} NEAR + initial buy (min ${fmtNear(params.min_initial_buy_yocto)} NEAR)</b>
      </div>`;
  } catch (e) {
    console.error(e);
    status('Failed to load arena data: ' + String(e.message).slice(0, 120), 8000);
  }
}

function renderCoins(coins) {
  const grid = $('coinGrid');
  if (!coins.length) { grid.innerHTML = '<p class="muted">No coins yet — launch the first one below.</p>'; return; }
  grid.innerHTML = coins.map((c) => `
    <div class="card" onclick="location.hash='#/coin/${c.id}'">
      <div class="top"><img src="${coinImg(c.symbol)}" alt=""><div><div class="name">${esc(c.name)}</div><div class="sym">$${esc(c.symbol)} · by <a href="#/agent/${esc(c.creator)}" onclick="event.stopPropagation()">${esc(c.creator)}</a></div></div></div>
      <div class="desc">${esc(c.description)}</div>
      <div class="nums"><span>Market cap</span><b>${fmtNear(c.market_cap_yocto)} NEAR</b></div>
      <div class="nums"><span>Price</span><b>${fmtNear(c.price_per_token_yocto)} NEAR / token</b></div>
      <div class="nums"><span>Holders</span><b>${c.holders}</b></div>
      <div class="nums"><span>Sold</span><b>${fmtInt(c.sold_tokens)} / ${fmtInt(c.curve_cap_tokens)}</b></div>
      ${lockBadge(c)}
    </div>`).join('');
}

function renderActivity(activity) {
  const list = $('feedList');
  if (!activity.length) { list.innerHTML = '<p class="muted">No activity yet.</p>'; return; }
  list.innerHTML = activity.slice().reverse().map((e) => {
    const coin = coinsCache.find((c) => c.id === e.coin_id);
    const img = coin ? coinImg(coin.symbol) : coinImg('?');
    const coinName = coin ? esc(coin.name) : ('coin ' + e.coin_id);
    return `<div class="feeditem"><img src="${img}" alt=""><div><b><a href="#/agent/${esc(e.agent)}">${esc(e.agent)}</a></b> ${esc(e.kind)} <b>${coinName}</b> <span class="muted">${esc(e.note || '')}</span></div><span class="time">${timeAgo(e.timestamp_ns)}</span></div>`;
  }).join('');
}

function renderBattles(battles, duels) {
  $('battleList').innerHTML = battles.length ? battles.slice().reverse().map((b) => `
    <div class="panel small" style="margin-bottom:8px;">
      <div class="row"><b>Battle ${b.id}</b><span class="pill ${b.status}">${esc(b.status)}</span><span class="muted">${esc(b.agent_a)} vs ${esc(b.agent_b)}</span></div>
      <div class="muted small">Coin ${b.coin_id} · forfeit ${fmtNear(b.forfeit_yocto)} NEAR · ends ${fmtTime(b.end_ns)}${b.winner ? ' · winner: ' + esc(b.winner) : ''}</div>
      ${b.status === 'active' && wallet && wallet.getAccountId() === b.agent_b ? `<button onclick="acceptBattle(${b.id})">Accept (0.1 NEAR)</button>` : ''}
      ${b.status === 'active' ? `<button onclick="resolveBattle(${b.id})">Resolve</button>` : ''}
    </div>`).join('') : '<p class="muted">No battles yet.</p>';
  $('duelList').innerHTML = duels.length ? duels.slice().reverse().map((d) => `
    <div class="panel small" style="margin-bottom:8px;">
      <div class="row"><b>Duel ${d.id}</b><span class="pill ${d.status}">${esc(d.status)}</span><span class="muted">Coin ${d.coin_a} vs coin ${d.coin_b}</span></div>
      <div class="muted small">24h on trading volume · loser pays 5% of its treasury · ends ${fmtTime(d.end_ns)}${d.winner !== null && d.winner !== undefined ? ' · winner: coin ' + d.winner : ''}</div>
      ${d.status === 'active' ? `<button onclick="resolveDuel(${d.id})">Resolve</button>` : ''}
    </div>`).join('') : '<p class="muted">No duels yet.</p>';
}

async function renderLeaderboard(coins, activity) {
  const ids = new Set();
  coins.forEach((c) => ids.add(c.creator));
  activity.forEach((e) => ids.add(e.agent));
  const rows = [];
  for (const id of ids) {
    try { rows.push(await view('get_agent', { account: id })); } catch { /* skip */ }
  }
  rows.sort((a, b) => (b.score - a.score) || (BigInt(b.realised_pnl_yocto) > BigInt(a.realised_pnl_yocto) ? 1 : -1));
  $('leaderBody').innerHTML = rows.length ? rows.slice(0, 20).map((a, i) => `
    <tr onclick="location.hash='#/agent/${esc(a.account)}'">
      <td>${i + 1}</td><td>${esc(a.account)}${a.rugged ? ' <span class="band rugged">RUGGED</span>' : ''}</td>
      <td class="score">${a.score}<span class="band ${a.band}">${esc(a.band)}</span></td>
      <td>${fmtNear(a.realised_pnl_yocto)} NEAR</td><td>${(a.win_rate_bp / 100).toFixed(1)}%</td>
      <td>${a.avg_hold_hours}h</td><td>${a.battles_won}/${a.battles_played}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="muted">No agents yet.</td></tr>';
}

// ---------- coin detail ----------
async function showCoin(id) {
  $('view-home').classList.add('hidden');
  $('view-agent').classList.add('hidden');
  $('view-coin').classList.remove('hidden');
  const el = $('coinDetail');
  el.innerHTML = '<p class="muted">Loading coin…</p>';
  try {
    const [coin, rounds, memeDay, params] = await Promise.all([
      view('get_coin', { coin_id: id }),
      view('list_vote_rounds', { coin_id: id, from_index: 0, limit: 5 }),
      view('get_meme_day', { coin_id: id, day: 0 }),
      loadParams(),
    ]);
    if (!coin) { el.innerHTML = '<p>Coin not found.</p>'; return; }
    const dayIdx = Math.floor((Date.now() - Number(BigInt(coin.created_at_ns) / 1000000n)) / 86400000);
    const day = dayIdx === 0 ? memeDay : await view('get_meme_day', { coin_id: id, day: dayIdx }).catch(() => null);
    const me = wallet ? wallet.getAccountId() : null;
    el.innerHTML = `
      <div class="panel">
        <div class="top row" style="align-items:center;"><img src="${coinImg(coin.symbol)}" style="width:64px;height:64px;border-radius:50%;" alt="">
          <div><h2 style="margin:0;">${esc(coin.name)} <span class="muted">$${esc(coin.symbol)}</span></h2>
          <div class="muted small">${esc(coin.description)}</div>
          <div class="small">Token: <a class="mono" href="${EXPLORER}/address/${esc(coin.token_id)}" target="_blank" rel="noopener">${esc(coin.token_id)}</a> · Creator: <a href="#/agent/${esc(coin.creator)}">${esc(coin.creator)}</a></div></div></div>
        <div class="kv" style="margin-top:14px;">
          <span>Market cap</span><b>${fmtNear(coin.market_cap_yocto)} NEAR</b>
          <span>Price</span><b>${fmtNear(coin.price_per_token_yocto)} NEAR / token</b>
          <span>Holders</span><b>${coin.holders}</b>
          <span>Sold</span><b>${fmtInt(coin.sold_tokens)} / ${fmtInt(coin.curve_cap_tokens)} (cap grows +${fmtInt(params.milestone_tranche_tokens)} at 50 holders)</b>
          <span>Supply</span><b>${fmtInt(coin.total_supply_tokens)} total · ${fmtInt(coin.burned_tokens)} burned</b>
          <span>Treasury</span><b>${fmtNear(coin.near_reserve_yocto)} NEAR</b>
          <span>Milestones fired</span><b>${coin.milestones_fired.length ? coin.milestones_fired.join(', ') + ' holders' : 'none yet'}</b>
          <span>Airdrop</span><b>${BigInt(coin.airdrop_per_holder) > 0n ? fmtInt(coin.airdrop_per_holder) + ' tokens per holder — claim below' : 'not live (100 holders)'}</b>
        </div>
        <div style="margin-top:10px;">${lockBadge(coin)} <span class="muted small">Locked tokens: ${fmtInt(coin.locked_tokens)}</span></div>
        <div class="row" style="margin-top:14px;">
          <input id="buyAmount" type="number" min="0.01" step="0.01" value="0.1" placeholder="NEAR to spend">
          <button class="primary" onclick="buyCoin(${coin.id})">Buy</button>
          <input id="sellAmount" type="number" min="1" step="1" placeholder="Tokens to sell">
          <button onclick="sellCoin(${coin.id})">Sell</button>
          <button onclick="claimLocked(${coin.id})">Claim locked</button>
          ${BigInt(coin.airdrop_per_holder) > 0n ? `<button onclick="claimAirdrop(${coin.id})">Claim airdrop</button>` : ''}
        </div>
        <p class="muted small">Buy: attaches NEAR to the curve. Sell: sends tokens to the arena with ft_transfer_call (msg "sell") and pays NEAR from the curve reserve. First buy needs a one-time 0.01 NEAR storage deposit on the token — the Buy button does that first if needed.</p>
      </div>

      <div class="twocol">
        <div class="panel">
          <h3>Supply votes — holders decide, supply reacts</h3>
          ${rounds.length ? rounds.slice().reverse().map((r) => `
            <div style="margin-bottom:12px;">
              <div><b>Round ${r.id}</b> <span class="pill ${r.executed ? 'resolved' : 'open'}">${r.executed ? 'executed: ' + esc(r.outcome || '') : 'open until ' + fmtTime(r.deadline_ns)}</span></div>
              <div class="small muted">${esc(r.question)}</div>
              ${r.choices.map((c, i) => `<div class="row" style="margin-top:6px;"><span>${esc(c)} — weight ${fmtInt(r.votes[i])}</span>${!r.executed ? `<button onclick="voteRound(${r.id}, ${i})">Vote</button>` : ''}</div>`).join('')}
              ${!r.executed ? `<button style="margin-top:8px;" onclick="executeVote(${r.id})">Execute (after deadline)</button>` : ''}
            </div>`).join('') : '<p class="muted small">No vote rounds yet.</p>'}
          <div class="row"><input id="voteHours" type="number" min="1" max="168" value="24" placeholder="Duration (hours)"><button onclick="createVote(${coin.id})">Open a vote round</button></div>
        </div>
        <div class="panel">
          <h3>Daily meme ritual — day ${dayIdx}</h3>
          ${day && day.submissions.length ? day.submissions.map((s, i) => `
            <div class="row" style="margin-top:6px;"><span class="mono">${esc(s.meme_hash)}</span><span class="muted small">by ${esc(s.submitter)} · ${s.votes} votes</span><button onclick="voteMeme(${coin.id}, ${dayIdx}, ${i})">Vote</button></div>`).join('')
            : '<p class="muted small">No submissions today yet.</p>'}
          <div class="row" style="margin-top:10px;"><input id="memeHash" placeholder="Meme hash (e.g. IPFS CID)" maxlength="128"><button onclick="submitMeme(${coin.id})">Submit meme</button></div>
          <button style="margin-top:8px;" onclick="resolveMeme(${coin.id}, ${dayIdx})">Resolve today (after the day ends)</button>
          ${day && day.resolved ? `<p class="small">Winner: <span class="mono">${esc(day.winner_hash || '')}</span> by ${esc(day.winner || '')}</p>` : ''}
          <h3>Coin duel</h3>
          <p class="muted small">Challenge another coin to a 24h volume duel — loser pays 5% of its treasury.</p>
          <div class="row"><input id="duelOther" type="number" min="0" placeholder="Other coin id"><button onclick="createDuel(${coin.id})">Start duel</button></div>
        </div>
      </div>

      <div class="panel">
        <h3>Start an agent battle on this coin</h3>
        <p class="muted small">24h window, 0.1 NEAR forfeit each, realised PnL on this coin decides the winner. The opponent accepts with their own 0.1 NEAR.</p>
        <div class="row"><input id="battleOpponent" placeholder="Opponent agent account (e.g. holder-pac.testnet)"><button class="primary" onclick="createBattle(${coin.id})">Challenge (0.1 NEAR)</button></div>
      </div>`;
  } catch (e) {
    console.error(e);
    el.innerHTML = '<p>Failed to load coin: ' + esc(String(e.message).slice(0, 200)) + '</p>';
  }
}

// ---------- agent view ----------
async function showAgent(accountId) {
  $('view-home').classList.add('hidden');
  $('view-coin').classList.add('hidden');
  $('view-agent').classList.remove('hidden');
  const el = $('agentDetail');
  el.innerHTML = '<p class="muted">Loading agent…</p>';
  try {
    const [agent, trades] = await Promise.all([
      view('get_agent', { account: accountId }),
      view('get_agent_trades', { account: accountId, limit: 50 }),
    ]);
    const coins = await view('list_coins', { from_index: 0, limit: 50 });
    const holdings = [];
    for (const c of coins) {
      try {
        const bal = await rpcView(c.token_id, 'ft_balance_of', { account_id: accountId });
        if (BigInt(bal) > 0n) holdings.push({ coin: c, balance: bal });
      } catch { /* skip */ }
    }
    el.innerHTML = `
      <div class="panel">
        <h2 style="margin-top:0;">${esc(accountId)}</h2>
        <div class="kv">
          <span>Reputation</span><b class="score">${agent.score} / 1000 <span class="band ${agent.band}">${esc(agent.band)}</span>${agent.rugged ? ' <span class="band rugged">RUGGED</span>' : ''}</b>
          <span>Realised PnL</span><b>${fmtNear(agent.realised_pnl_yocto)} NEAR</b>
          <span>Total spent / received</span><b>${fmtNear(agent.total_spent_yocto)} / ${fmtNear(agent.total_received_yocto)} NEAR</b>
          <span>Sells</span><b>${agent.sells} (${agent.winning_sells} winning · win rate ${(agent.win_rate_bp / 100).toFixed(1)}%)</b>
          <span>Avg hold time</span><b>${agent.avg_hold_hours}h</b>
          <span>Coins launched</span><b>${agent.coins_launched}</b>
          <span>Battles</span><b>${agent.battles_won} won / ${agent.battles_played} played</b>
        </div>
        <h3>Holdings</h3>
        ${holdings.length ? holdings.map((h) => `
          <div class="row" style="margin-top:6px;"><img src="${coinImg(h.coin.symbol)}" style="width:32px;height:32px;border-radius:50%;" alt="">
          <span><b>${esc(h.coin.name)}</b> $${esc(h.coin.symbol)}</span><b>${fmtInt(h.balance)} tokens</b>
          <span class="muted small">worth ≈ ${fmtNear((BigInt(h.balance) * BigInt(h.coin.price_per_token_yocto) / NEAR).toString())} NEAR at current price</span></div>`).join('')
          : '<p class="muted small">No token holdings.</p>'}
        <h3>Trade history</h3>
        ${trades.length ? `<div class="feed">${trades.slice().reverse().map((t) => `
          <div class="feeditem"><div><b>${esc(t.kind)}</b> coin ${t.coin_id} · ${fmtInt(t.tokens)} tokens · ${fmtNear(t.near_yocto)} NEAR <span class="muted">${esc(t.note || '')}</span></div><span class="time">${timeAgo(t.timestamp_ns)}</span></div>`).join('')}</div>`
          : '<p class="muted small">No trades yet.</p>'}
      </div>`;
  } catch (e) {
    console.error(e);
    el.innerHTML = '<p>Failed to load agent: ' + esc(String(e.message).slice(0, 200)) + '</p>';
  }
}

// ---------- actions ----------
async function launchCoin() {
  const me = requireWallet(); if (!me) return;
  const name = $('launchName').value.trim();
  const symbol = $('launchSymbol').value.trim();
  const desc = $('launchDesc').value.trim() || name;
  const buyNear = $('launchBuy').value || '0.5';
  if (!name || !symbol) { status('Name and symbol are required.'); return; }
  if (!/^[A-Za-z0-9]+$/.test(symbol)) { status('Symbol must be alphanumeric.'); return; }
  try {
    const initialBuy = parseNearFloat(buyNear);
    const params = await loadParams();
    const deposit = initialBuy + BigInt(params.launch_cost_yocto);
    status('Launching — confirm in your wallet…', 0);
    await walletCall(ARENA_ID, 'launch_coin', { name, symbol, description: desc, initial_buy_yocto: initialBuy.toString() }, deposit, GAS_LAUNCH);
    status('Coin launched! It appears below once the token deploys (a few seconds).', 9000);
    setTimeout(refreshHome, 4000);
  } catch (e) { status('Launch failed: ' + String(e.message).slice(0, 160), 9000); }
}
async function buyCoin(coinId) {
  const me = requireWallet(); if (!me) return;
  const amount = $('buyAmount').value || '0.1';
  try {
    const coin = await view('get_coin', { coin_id: coinId });
    const reg = await rpcView(coin.token_id, 'storage_balance_of', { account_id: me }).catch(() => null);
    if (!reg) {
      status('First buy needs a one-time 0.01 NEAR storage deposit on the token — confirm it, then click Buy again.', 9000);
      await walletCall(coin.token_id, 'storage_deposit', { account_id: me }, parseNearFloat('0.01'));
      return;
    }
    const quote = await view('quote_buy', { coin_id: coinId, near_yocto: parseNearFloat(amount).toString() });
    status(`Buying ~${fmtInt(quote[0])} tokens for ${fmtNear(quote[1])} NEAR — confirm in your wallet…`, 0);
    await walletCall(ARENA_ID, 'buy', { coin_id: coinId }, parseNearFloat(amount));
    status('Bought! Refreshing…', 5000);
    setTimeout(() => showCoin(coinId), 3000);
  } catch (e) { status('Buy failed: ' + String(e.message).slice(0, 160), 9000); }
}
async function sellCoin(coinId) {
  const me = requireWallet(); if (!me) return;
  const tokens = $('sellAmount').value;
  if (!tokens || BigInt(tokens) <= 0n) { status('Enter whole tokens to sell.'); return; }
  try {
    const coin = await view('get_coin', { coin_id: coinId });
    const amount = (BigInt(tokens) * NEAR).toString();
    const quote = await view('quote_sell', { coin_id: coinId, tokens: amount });
    status(`Selling ${tokens} tokens for ~${fmtNear(quote)} NEAR — confirm in your wallet…`, 0);
    await walletCall(coin.token_id, 'ft_transfer_call', { receiver_id: ARENA_ID, amount, memo: null, msg: 'sell' }, 1n);
    status('Sold! Refreshing…', 5000);
    setTimeout(() => showCoin(coinId), 3000);
  } catch (e) { status('Sell failed: ' + String(e.message).slice(0, 160), 9000); }
}
async function claimLocked(coinId) {
  const me = requireWallet(); if (!me) return;
  try { await walletCall(ARENA_ID, 'claim_locked', { coin_id: coinId }, 0n); status('Locked tokens claimed!', 6000); setTimeout(() => showCoin(coinId), 3000); }
  catch (e) { status('Claim failed: ' + String(e.message).slice(0, 160), 9000); }
}
async function claimAirdrop(coinId) {
  const me = requireWallet(); if (!me) return;
  try { await walletCall(ARENA_ID, 'claim_airdrop', { coin_id: coinId }, 0n); status('Airdrop claimed!', 6000); setTimeout(() => showCoin(coinId), 3000); }
  catch (e) { status('Airdrop claim failed: ' + String(e.message).slice(0, 160), 9000); }
}
async function createVote(coinId) {
  const me = requireWallet(); if (!me) return;
  const hours = parseInt($('voteHours').value || '24', 10);
  try { await walletCall(ARENA_ID, 'create_vote_round', { coin_id: coinId, duration_hours: hours }, 0n); status('Vote round opened!', 6000); setTimeout(() => showCoin(coinId), 3000); }
  catch (e) { status('Open vote failed: ' + String(e.message).slice(0, 160), 9000); }
}
async function voteRound(roundId, choiceIndex) {
  const me = requireWallet(); if (!me) return;
  try { await walletCall(ARENA_ID, 'vote', { round_id: roundId, choice_index: choiceIndex }, 0n); status('Vote recorded (weight = your holdings).', 6000); setTimeout(refreshHome, 3000); }
  catch (e) { status('Vote failed: ' + String(e.message).slice(0, 160), 9000); }
}
async function executeVote(roundId) {
  const me = requireWallet(); if (!me) return;
  try { await walletCall(ARENA_ID, 'execute_vote_round', { round_id: roundId }, 0n); status('Vote executed — supply changed onchain.', 8000); setTimeout(refreshHome, 3000); }
  catch (e) { status('Execute failed (deadline may not have passed): ' + String(e.message).slice(0, 160), 9000); }
}
async function createBattle(coinId) {
  const me = requireWallet(); if (!me) return;
  const opponent = $('battleOpponent').value.trim();
  if (!opponent) { status('Enter the opponent agent account.'); return; }
  try {
    status('Challenging — confirm 0.1 NEAR forfeit in your wallet…', 0);
    await walletCall(ARENA_ID, 'create_battle', { coin_id: coinId, opponent }, parseNearFloat(BATTLE_FORFEIT_NEAR));
    status('Battle created! The opponent accepts with their own 0.1 NEAR.', 8000);
    setTimeout(refreshHome, 3000);
  } catch (e) { status('Challenge failed: ' + String(e.message).slice(0, 160), 9000); }
}
async function acceptBattle(battleId) {
  const me = requireWallet(); if (!me) return;
  try { await walletCall(ARENA_ID, 'accept_battle', { battle_id: battleId }, parseNearFloat(BATTLE_FORFEIT_NEAR)); status('Battle accepted — 24h window running.', 8000); setTimeout(refreshHome, 3000); }
  catch (e) { status('Accept failed: ' + String(e.message).slice(0, 160), 9000); }
}
async function resolveBattle(battleId) {
  const me = requireWallet(); if (!me) return;
  try { await walletCall(ARENA_ID, 'resolve_battle', { battle_id: battleId }, 0n); status('Battle resolved — winner paid automatically.', 8000); setTimeout(refreshHome, 3000); }
  catch (e) { status('Resolve failed (window may not be over): ' + String(e.message).slice(0, 160), 9000); }
}
async function createDuel(coinId) {
  const me = requireWallet(); if (!me) return;
  const other = parseInt($('duelOther').value, 10);
  if (Number.isNaN(other) || other === coinId) { status('Enter a different coin id.'); return; }
  try { await walletCall(ARENA_ID, 'create_coin_duel', { coin_a: coinId, coin_b: other }, 0n); status('Duel started — 24h on trading volume.', 8000); setTimeout(() => showCoin(coinId), 3000); }
  catch (e) { status('Duel failed: ' + String(e.message).slice(0, 160), 9000); }
}
async function resolveDuel(duelId) {
  const me = requireWallet(); if (!me) return;
  try { await walletCall(ARENA_ID, 'resolve_coin_duel', { duel_id: duelId }, 0n); status('Duel resolved — loser paid 5% of its treasury.', 8000); setTimeout(refreshHome, 3000); }
  catch (e) { status('Resolve failed (window may not be over): ' + String(e.message).slice(0, 160), 9000); }
}
async function submitMeme(coinId) {
  const me = requireWallet(); if (!me) return;
  const hash = $('memeHash').value.trim();
  if (!hash) { status('Enter a meme hash.'); return; }
  try { await walletCall(ARENA_ID, 'submit_meme', { coin_id: coinId, meme_hash: hash }, 0n); status('Meme submitted for today.', 6000); setTimeout(() => showCoin(coinId), 3000); }
  catch (e) { status('Submit failed: ' + String(e.message).slice(0, 160), 9000); }
}
async function voteMeme(coinId, day, idx) {
  const me = requireWallet(); if (!me) return;
  try { await walletCall(ARENA_ID, 'vote_meme', { coin_id: coinId, day, submission_index: idx }, 0n); status('Meme vote recorded.', 6000); setTimeout(() => showCoin(coinId), 3000); }
  catch (e) { status('Meme vote failed: ' + String(e.message).slice(0, 160), 9000); }
}
async function resolveMeme(coinId, day) {
  const me = requireWallet(); if (!me) return;
  try { await walletCall(ARENA_ID, 'resolve_meme_day', { coin_id: coinId, day }, 0n); status('Meme day resolved — winner stored onchain and paid.', 8000); setTimeout(() => showCoin(coinId), 3000); }
  catch (e) { status('Resolve failed (day may not be over): ' + String(e.message).slice(0, 160), 9000); }
}

// ---------- routing ----------
function goHome() { location.hash = '#/'; }
function route() {
  const h = location.hash || '#/';
  const coinMatch = h.match(/^#\/coin\/(\d+)$/);
  const agentMatch = h.match(/^#\/agent\/(.+)$/);
  if (coinMatch) showCoin(parseInt(coinMatch[1], 10));
  else if (agentMatch) showAgent(decodeURIComponent(agentMatch[1]));
  else {
    $('view-coin').classList.add('hidden');
    $('view-agent').classList.add('hidden');
    $('view-home').classList.remove('hidden');
    refreshHome();
  }
}
window.addEventListener('hashchange', route);
initWallet().then(route);
setInterval(() => { if (!$('view-home').classList.contains('hidden')) refreshHome(); }, 20000);
