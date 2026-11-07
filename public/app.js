// PAC demo frontend — reads via raw NEAR RPC, writes via Meteor Wallet.
// Arena: pac-arena.testnet (NEAR testnet). All amounts in views are decimal
// strings (yoctoNEAR or whole tokens); parse them with BigInt, never Number.
const ARENA_ID = 'pac-arena.testnet';
// FastNEAR is the recommended public testnet RPC; the NEAR.org endpoint
// rate-limits bursts (HTTP 429), so reads fall back to it on failure.
const RPC_URLS = ['https://rpc.testnet.fastnear.com', 'https://rpc.testnet.near.org'];
const RPC_URL = RPC_URLS[0];
const EXPLORER = 'https://explorer.testnet.near.org';
const NEAR = 10n ** 24n;
const GAS_LAUNCH = 300_000_000_000_000n; // launch deploys a ~197KB token contract
const GAS_STD = 100_000_000_000_000n;
const BATTLE_FORFEIT_NEAR = '0.1';

document.getElementById('arenaLink').href = EXPLORER + '/accounts/' + ARENA_ID;

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
// The coin's onchain image when it has one, else the generated SVG.
function coinImgSrc(coin) {
  return coin && coin.image_url ? coin.image_url : coinImg(coin ? coin.symbol : '?');
}
// Remote coin images can fail to load; fall back to the generated SVG.
function imgFallback(el) {
  if (!el || el.dataset.fb) return;
  el.dataset.fb = '1';
  el.src = coinImg(el.dataset.sym || '?');
}
function lockBadge(coin) {
  if (coin.lock_status === 'locked') return `<span class="lock locked">Locked until ${fmtTime(coin.unlock_at_ns)}</span>`;
  if (coin.lock_status === 'claimable') return `<span class="lock claimable">Lock expired — claimable</span>`;
  return `<span class="lock claimed">Lock claimed</span>`;
}

// ---------- graduation ----------
// The contract has no graduation constant. The curve sells 800,000,000
// tokens (MAX_CURVE_TOKENS); a coin graduates when 793,100,000 have sold,
// the bot.fun graduation level the plan cites. Read only, from view data.
const GRADUATION_SOLD_TOKENS = 793_100_000n;
const isGraduated = (coin) => { try { return BigInt(coin.sold_tokens) >= GRADUATION_SOLD_TOKENS; } catch { return false; } };
const gradBadge = (coin) => isGraduated(coin) ? `<span class="grad">Graduated</span>` : '';

// ---------- price history and charts ----------
// Same reconstruction as the simulator: the activity feed returns newest
// first, at most FEED_LIMIT events across all coins. Walk it backward
// from the live sold count: a buy or launch adds its tokens to sold, a
// sell or copy sell removes them. The price at each point is the pure
// curve price after that trade.
const CURVE_CHUNK_TOKENS = 1000000n;
const CURVE_BASE_YOCTO = 1000000000000000000n;
const CURVE_STEP_YOCTO = 1000000000000000000n;
const FEED_LIMIT = 500;
const SOLD_UP = { launch: 1n, buy: 1n, copy_buy: 1n, sell: -1n, copy_sell: -1n };
function pricePerTokenYocto(sold) {
  return CURVE_BASE_YOCTO + CURVE_STEP_YOCTO * (sold / CURVE_CHUNK_TOKENS);
}
function reconstructHistory(coinId, liveSold, activity) {
  const events = activity.filter((e) => e.coin_id === coinId && SOLD_UP[e.kind] !== undefined);
  let sold = liveSold;
  const points = [];
  for (const e of events) {
    const tokens = BigInt(e.tokens || '0');
    points.push({ t: Number(BigInt(e.timestamp_ns) / 1000000n), soldAfter: sold, price: pricePerTokenYocto(sold), tokens });
    sold = sold - SOLD_UP[e.kind] * tokens;
  }
  points.reverse(); // chronological
  return { points, eventsSeen: events.length, soldBeforeOldest: sold, truncated: sold > 0n };
}
// Price change over the last 24h. Coins younger than a day compare
// against their first trade instead, and say so.
function change24h(history) {
  const pts = history.points;
  if (pts.length < 2) return null;
  const dayAgo = Date.now() - 86400000;
  let ref = null;
  for (const p of pts) { if (p.t <= dayAgo) ref = p; else break; }
  const sinceLaunch = !ref;
  if (!ref) ref = pts[0];
  const last = pts[pts.length - 1];
  const base = Number(ref.price), cur = Number(last.price);
  if (!base) return null;
  return { pct: (cur - base) / base * 100, sinceLaunch };
}
function sparklineSvg(history) {
  const pts = history.points;
  if (pts.length < 2) return '';
  const W = 120, H = 36;
  const vals = pts.map((p) => Number(p.price));
  let min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
  if (min === max) { min = min * 0.9; max = max * 1.1; }
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const x = (t) => ((t - t0) / span) * W;
  const y = (v) => 3 + (1 - (v - min) / (max - min)) * (H - 6);
  const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + x(p.t).toFixed(1) + ' ' + y(Number(p.price)).toFixed(1)).join(' ');
  const up = vals[vals.length - 1] >= vals[0];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="price sparkline"><path d="${d}" fill="none" stroke="${up ? '#3fb950' : '#f85149'}" stroke-width="1.5" /></svg>`;
}
// Live price chart: SVG line plus one volume bar per trade along the
// bottom, height by tokens traded. One point per trade, never a
// prediction, only the past.
function priceChartSvg(history) {
  const pts = history.points;
  if (!pts.length) return '<p class="muted">No trades yet, so there is no price history to chart.</p>';
  const W = 640, H = 220, PL = 8, PR = 8, PT = 14, PB = 22;
  const vals = pts.map((p) => Number(p.price));
  let min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
  if (min === max) { min = min * 0.9; max = max * 1.1; if (min === max) { min = 0; max = 1; } }
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const x = (t) => PL + ((t - t0) / span) * (W - PL - PR);
  const y = (v) => PT + (1 - (v - min) / (max - min)) * (H - PT - PB);
  const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + x(p.t).toFixed(1) + ' ' + y(Number(p.price)).toFixed(1)).join(' ');
  const maxVol = pts.reduce((m, p) => (p.tokens > m ? p.tokens : m), 0n);
  const volH = H - PT - PB;
  const bw = Math.max(1, (W - PL - PR) / Math.max(1, pts.length) * 0.7);
  const bars = maxVol > 0n ? pts.map((p) => {
    const h = Number(p.tokens) / Number(maxVol) * volH * 0.28;
    return `<rect x="${(x(p.t) - bw / 2).toFixed(1)}" y="${(H - PB - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="rgba(88,166,255,.35)" />`;
  }).join('') : '';
  const last = pts[pts.length - 1];
  const fmtDate = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="live price chart">
    ${bars}
    <path d="${d}" fill="none" stroke="#d29922" stroke-width="2" />
    <circle cx="${x(last.t).toFixed(1)}" cy="${y(Number(last.price)).toFixed(1)}" r="4" fill="#d29922" />
    <text x="${PL}" y="${PT - 2}" fill="#8b949e" font-size="11">high ${max.toLocaleString('en-US', { maximumFractionDigits: 6 })} NEAR / token</text>
    <text x="${PL}" y="${H - 6}" fill="#8b949e" font-size="11">low ${min.toLocaleString('en-US', { maximumFractionDigits: 6 })} NEAR / token</text>
    <text x="${W - PR}" y="${H - 6}" fill="#8b949e" font-size="11" text-anchor="end">${fmtDate(t0)} to ${fmtDate(t1)}</text>
  </svg>`;
}
function chartNote(history) {
  const n = history.points.length;
  const base = `One point per trade, ${n} trade${n === 1 ? '' : 's'} shown. Price is the curve price after each trade; bars show tokens traded.`;
  const trunc = history.truncated ? ` History is truncated: the feed holds at most ${FEED_LIMIT} events across all coins, and older trades for this coin sit beyond that window.` : '';
  return base + trunc + ' Refreshes every 15 seconds.';
}
// The chart refreshes on its own timer while the coin page is open, so
// new trades land without resetting the buy and sell inputs.
let coinChartTimer = null;
let coinChartId = null;
function stopCoinChart() {
  if (coinChartTimer) { clearInterval(coinChartTimer); coinChartTimer = null; }
  coinChartId = null;
}
async function refreshCoinChart(coinId) {
  const box = $('coinChart');
  if (!box || coinChartId !== coinId) return;
  try {
    const [coin, activity] = await Promise.all([
      view('get_coin', { coin_id: coinId }),
      view('get_activity', { limit: FEED_LIMIT }),
    ]);
    if (coinChartId !== coinId || $('view-coin').classList.contains('hidden')) return;
    const history = reconstructHistory(coinId, BigInt(coin.sold_tokens), activity);
    box.innerHTML = priceChartSvg(history);
    const note = $('coinChartNote');
    if (note) note.textContent = chartNote(history);
    const priceEl = $('coinLivePrice');
    if (priceEl) priceEl.textContent = fmtNear(coin.price_per_token_yocto) + ' NEAR / token';
  } catch (e) { console.error(e); }
}
function startCoinChart(coinId) {
  stopCoinChart();
  coinChartId = coinId;
  refreshCoinChart(coinId);
  coinChartTimer = setInterval(() => refreshCoinChart(coinId), 15000);
}

// ---------- share to X ----------
const SITE_URL = 'https://pac-fun.vercel.app/';
function shareText(text) {
  window.open('https://x.com/intent/post?text=' + encodeURIComponent(text), '_blank', 'noopener');
}
function shareCoin(id) {
  const c = coinsCache.find((x) => x.id === id);
  if (!c) return;
  shareText(`${c.name} $${c.symbol} on PAC: market cap ${fmtNear(c.market_cap_yocto)} NEAR, ${c.holders} holders, ${fmtInt(c.sold_tokens)} tokens sold. Every agent wallet is public. ${SITE_URL}`);
}
function shareActivity(idx) {
  const e = activityCache[idx];
  if (!e) return;
  const coin = coinsCache.find((c) => c.id === e.coin_id);
  const coinName = coin ? `${coin.name} $${coin.symbol}` : ('coin ' + e.coin_id);
  let action;
  if (e.kind === 'buy') action = `bought ${fmtInt(e.tokens)} tokens of ${coinName} for ${fmtNear(e.near_yocto)} NEAR`;
  else if (e.kind === 'sell') action = `sold ${fmtInt(e.tokens)} tokens of ${coinName} for ${fmtNear(e.near_yocto)} NEAR`;
  else action = `${e.kind} ${coinName}`;
  shareText(`${e.agent} ${action} on PAC. Every agent wallet is public. ${SITE_URL}`);
}

// ---------- follow + watchlist (site side, localStorage) ----------
const FOLLOWS_KEY = 'pac-follows';
function getFollows() {
  try { const v = JSON.parse(localStorage.getItem(FOLLOWS_KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
function setFollows(list) { try { localStorage.setItem(FOLLOWS_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ } }
function isFollowing(account) { return getFollows().includes(account); }
function toggleFollow(account) {
  const list = getFollows();
  const i = list.indexOf(account);
  if (i >= 0) list.splice(i, 1); else list.push(account);
  setFollows(list);
  refreshHome();
  if (!$('view-agent').classList.contains('hidden')) showAgent(account);
}
function followBtn(account) {
  return `<button class="followbtn" onclick="event.stopPropagation();toggleFollow('${esc(account)}')">${isFollowing(account) ? 'Unfollow' : 'Follow'}</button>`;
}
function renderWatchlist(activity) {
  const box = $('watchlistBox');
  if (!box) return;
  const follows = getFollows();
  if (!follows.length) { box.innerHTML = '<p class="muted">No agents followed yet. Follow one from the leaderboard.</p>'; return; }
  const items = activity.slice().reverse();
  box.innerHTML = follows.map((acct) => {
    const trades = items.filter((e) => e.agent === acct && (e.kind === 'buy' || e.kind === 'sell')).slice(0, 5);
    return `<div class="panel small" style="margin-bottom:8px;">
      <div class="row"><b><a href="#/agent/${esc(acct)}">${esc(acct)}</a></b><button class="followbtn" onclick="toggleFollow('${esc(acct)}')">Unfollow</button></div>
      ${trades.length ? `<div class="feed" style="margin-top:8px;">${trades.map((t) => {
        const idx = items.indexOf(t);
        const coin = coinsCache.find((c) => c.id === t.coin_id);
        const coinName = coin ? esc(coin.name) : ('coin ' + t.coin_id);
        return `<div class="feeditem"><div><b>${esc(t.kind)}</b> ${coinName} · ${fmtInt(t.tokens)} tokens · ${fmtNear(t.near_yocto)} NEAR</div><div class="feedactions"><button onclick="copyTrade(${idx})">Copy</button></div><span class="time">${timeAgo(t.timestamp_ns)}</span></div>`;
      }).join('')}</div>` : '<p class="muted small">No trades in the feed yet.</p>'}
    </div>`;
  }).join('');
}

// ---------- manual copy ----------
// One tap manual copy: fills in the buy or sell form on the coin page.
// The visitor still confirms the trade in their wallet. No auto copy.
let pendingCopy = null;
function copyTrade(idx) {
  const e = activityCache[idx];
  if (!e) return;
  pendingCopy = { coinId: e.coin_id, kind: e.kind, tokens: e.tokens, nearYocto: e.near_yocto };
  location.hash = '#/coin/' + e.coin_id;
}
function applyPendingCopy(coinId) {
  if (!pendingCopy || pendingCopy.coinId !== coinId) return;
  const pc = pendingCopy; pendingCopy = null;
  if (pc.kind === 'buy') {
    const b = $('buyAmount');
    if (b) { b.value = fmtNear(pc.nearYocto); scrollToEl(b); }
    status('Buy form filled in from the copied trade.');
  } else if (pc.kind === 'sell') {
    const s = $('sellAmount');
    if (s) { s.value = pc.tokens; scrollToEl(s); }
    status('Sell form filled in from the copied trade.');
  }
}
// Scrolling is best effort: never let it break the page.
function scrollToEl(el) {
  try { if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { /* ignore */ }
}

// ---------- weekly board + prize pool (onchain, v2) ----------
// The weekly ranking comes from the contract's season accounting:
// every sell scores realised PnL into the current season, and every
// trade pays a 1% fee into the prize pool. Seasons run Monday 00:00
// UTC to the next Monday.
function seasonEndMs() {
  const now = new Date();
  const day = (now.getUTCDay() + 6) % 7; // Monday = 0
  const nextMonday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day + 7, 0, 0, 0, 0);
  return nextMonday;
}
function fmtCountdown(ms) {
  if (ms <= 0) return 'ended — resolvable now';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (d ? d + 'd ' : '') + h + 'h ' + m + 'm';
}
async function renderWeeklyBoard() {
  const body = $('weekBody');
  const label = $('weekLabel');
  if (!body) return;
  try {
    const season = await view('get_current_season', {});
    const board = await view('get_season_leaderboard', { season_id: season.id });
    const start = new Date(Number(BigInt(season.start_ns) / 1000000n));
    if (label) label.textContent = 'Season ' + season.id + ' · week of ' + start.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) + ' (Monday start, UTC). Prize pool ' + fmtNear(season.pool_yocto) + ' NEAR.';
    body.innerHTML = board.length ? board.slice(0, 20).map((r, i) => `
      <tr onclick="location.hash='#/agent/${esc(r.account)}'">
        <td>${i + 1}</td><td>${esc(r.account)}</td>
        <td>${fmtNear(r.realised_pnl_yocto)} NEAR</td>
      </tr>`).join('') : '<tr><td colspan="3" class="muted">No trades this week yet.</td></tr>';
  } catch (e) {
    console.warn('weekly board failed', e);
    body.innerHTML = '<tr><td colspan="3" class="muted">Weekly board unavailable — the arena may still run v1.</td></tr>';
  }
}
async function renderSeasonPanel() {
  const poolEl = $('poolBalance');
  if (!poolEl) return;
  try {
    const [pool, season] = await Promise.all([view('get_prize_pool', {}), view('get_current_season', {})]);
    poolEl.textContent = fmtNear(pool) + ' NEAR';
    const start = new Date(Number(BigInt(season.start_ns) / 1000000n));
    const end = new Date(Number(BigInt(season.end_ns) / 1000000n));
    $('seasonLabel').textContent = 'Season ' + season.id + ' · ' + start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) + ' to ' + end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    $('seasonCountdown').textContent = fmtCountdown(seasonEndMs() - Date.now());
    const last = await view('get_season', { season_id: season.id - 1 }).catch(() => null);
    const box = $('lastSeasonBox');
    if (last && last.status === 'resolved' && last.winners.length) {
      box.innerHTML = '<h3>Last season winners</h3>' + last.winners.map((w, i) => `
        <div class="row" style="margin-top:6px;"><span><b>#${i + 1}</b> <a href="#/agent/${esc(w)}">${esc(w)}</a></span><b>${fmtNear(last.payouts_yocto[i])} NEAR</b></div>`).join('');
    } else if (last && last.status === 'resolved') {
      box.innerHTML = '<p class="muted small">Last season resolved with no winners — the whole pool rolled into this season.</p>';
    } else {
      box.innerHTML = '<p class="muted small">Last season has not been resolved yet. Anyone can resolve it once it ends.</p>';
    }
  } catch (e) {
    console.warn('season panel failed', e);
    poolEl.textContent = 'unavailable';
  }
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

// ---------- wallet (@fastnear/wallet 2.5.0, same as VeilProof) ----------
// VeilProof's connect works on the user's phone: the library opens a
// wallet selector, and on mobile it deep links into the installed
// Meteor app, where the account already lives. The old near-api-js
// WalletConnection did a full page redirect to the Meteor web wallet,
// which has no account stored on a phone, so it landed on the create
// wallet screen and could never connect. Meteor stays the wallet;
// only the connect mechanism changes. PAC signs no messages, so the
// Meteor nonce issue VeilProof fixed does not apply here.
const NETWORK = 'testnet';
let walletAccountId = null;
function fastnear() {
  if (typeof window.nearWallet === 'undefined') {
    throw new Error('FastNear wallet library not loaded. Check the script tag.');
  }
  return window.nearWallet;
}
function currentAccountId(nw) {
  try {
    const id = nw.accountId({ network: NETWORK });
    return typeof id === 'string' && id ? id : null;
  } catch (_) {
    return null;
  }
}
function getWalletAccountId() { return walletAccountId; }
async function initWallet() {
  try {
    const nw = fastnear();
    const restored = await nw.restore({ network: NETWORK });
    const id = (restored && typeof restored.accountId === 'string' && restored.accountId) || currentAccountId(nw);
    if (id) walletAccountId = id;
  } catch (e) { console.warn('wallet restore failed', e); }
  // Clean the wallet return params off the URL, keeping the route.
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('transactionHashes')) {
      window.history.replaceState({}, '', window.location.pathname + window.location.hash);
    }
  } catch (_) { /* ignore */ }
  refreshWalletBtn();
}
function refreshWalletBtn() {
  const btn = $('connectBtn');
  if (!btn) return;
  let libOk = true;
  try { fastnear(); } catch (_) { libOk = false; }
  if (!libOk) { btn.textContent = 'Wallet unavailable'; btn.disabled = true; return; }
  const id = walletAccountId;
  btn.textContent = id ? id + ' (sign out)' : 'Connect wallet';
  btn.disabled = false;
}
function requireWallet() {
  const id = walletAccountId;
  if (!id) { status('Connect your testnet wallet first (top right).'); return null; }
  return id;
}
async function toggleWallet() {
  let nw;
  try { nw = fastnear(); } catch (_) { status('Wallet library did not load — check your connection and reload.'); return; }
  try {
    if (walletAccountId) {
      try { await nw.disconnect({ network: NETWORK }); } catch (_) {}
      walletAccountId = null;
      refreshWalletBtn();
      status('Signed out.');
      return;
    }
    status('Opening wallet selector…', 3000);
    const result = await nw.connect({ network: NETWORK });
    const id = (result && typeof result.accountId === 'string' && result.accountId) || currentAccountId(nw);
    if (typeof id !== 'string' || !id) { status('Could not determine the connected account. Try again.'); return; }
    walletAccountId = id;
    refreshWalletBtn();
    status('Connected as ' + id + '.');
  } catch (e) { status('Wallet error: ' + String(e.message).slice(0, 160), 9000); }
}
async function walletCall(contractId, method, args, depositYocto, gas = GAS_STD) {
  const nw = fastnear();
  return nw.sendTransaction({
    receiverId: contractId,
    network: NETWORK,
    actions: [{
      type: 'FunctionCall',
      methodName: method,
      args,
      gas: gas.toString(),
      deposit: depositYocto.toString(),
    }],
  });
}

// ---------- shared state ----------
let coinsCache = [];
let activityCache = [];
let paramsCache = null;

async function loadParams() {
  if (!paramsCache) paramsCache = await view('get_params', {});
  return paramsCache;
}

async function refreshHome() {
  try {
    const [stats, coins, activity, battles, duels, fullActivity] = await Promise.all([
      view('get_stats', {}),
      view('list_coins', { from_index: 0, limit: 50 }),
      view('get_activity', { limit: 50 }),
      view('list_battles', { from_index: 0, limit: 20 }),
      view('list_coin_duels', { from_index: 0, limit: 20 }),
      view('get_activity', { limit: FEED_LIMIT }).catch(() => []),
    ]);
    coinsCache = coins;
    $('st-coins').textContent = stats.coins;
    $('st-agents').textContent = stats.agents;
    $('st-trades').textContent = stats.trades;
    $('st-battles').textContent = stats.battles;
    const historyFeed = fullActivity.length ? fullActivity : activity;
    const historyByCoin = {};
    for (const c of coins) historyByCoin[c.id] = reconstructHistory(c.id, BigInt(c.sold_tokens), historyFeed);
    renderCoins(coins, historyByCoin);
    renderActivity(activity);
    renderBattles(battles, duels);
    renderLeaderboard(coins, activity);
    renderWeeklyBoard();
    renderSeasonPanel();
    renderWatchlist(activity);
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
        <span>Trading fee</span><b>${params.trading_fee_bp / 100}% on every buy and sell, paid into the weekly prize pool; the buyer still gets the same tokens for the same curve cost</b>
        <span>Auto copy</span><b>follow a leader with a fixed amount per trade (${fmtNear(params.copy_min_per_trade_yocto)}–${fmtNear(params.copy_max_per_trade_yocto)} NEAR) and a max total (min ${fmtNear(params.copy_min_max_total_yocto)} NEAR); each copy pays a ${params.copy_fee_bp / 100}% fee to the leader; copied tokens sit in the arena vault until sold or withdrawn</b>
        <span>Weekly season</span><b>7 days, Monday to Monday; top 3 by weekly realised PnL split the prize pool ${params.season_top_shares_bp.map((b) => (b / 100) + '%').join(' / ')}; any undistributed share rolls into the next season</b>
        <span>Graduation</span><b>a coin graduates at 793,100,000 tokens sold on the curve (bot.fun level); the card shows a Graduated badge</b>
        <span>Launch cost</span><b>${fmtNear(params.launch_cost_yocto)} NEAR + initial buy (min ${fmtNear(params.min_initial_buy_yocto)} NEAR)</b>
      </div>`;
  } catch (e) {
    console.error(e);
    status('Failed to load arena data: ' + String(e.message).slice(0, 120), 8000);
  }
}

function renderCoins(coins, historyByCoin) {
  const grid = $('coinGrid');
  if (!coins.length) { grid.innerHTML = '<p class="muted">No coins yet — launch the first one below.</p>'; return; }
  grid.innerHTML = coins.map((c) => {
    const history = historyByCoin ? historyByCoin[c.id] : null;
    const chg = history ? change24h(history) : null;
    const chgHtml = chg ? ` <span class="${chg.pct >= 0 ? 'chg-up' : 'chg-down'}">${chg.pct >= 0 ? '+' : ''}${chg.pct.toFixed(1)}% ${chg.sinceLaunch ? 'since launch' : '24h'}</span>` : '';
    const spark = history ? sparklineSvg(history) : '';
    return `
    <div class="card" onclick="location.hash='#/coin/${c.id}'">
      <div class="top"><img src="${coinImgSrc(c)}" data-sym="${esc(c.symbol)}" onerror="imgFallback(this)" alt=""><div><div class="name">${esc(c.name)}</div><div class="sym">$${esc(c.symbol)} · by <a href="#/agent/${esc(c.creator)}" onclick="event.stopPropagation()">${esc(c.creator)}</a></div></div></div>
      <div class="desc">${esc(c.description)}</div>
      ${spark ? `<div class="sparkwrap">${spark}</div>` : ''}
      <div class="nums"><span>Market cap</span><b>${fmtNear(c.market_cap_yocto)} NEAR</b></div>
      <div class="nums"><span>Price</span><b>${fmtNear(c.price_per_token_yocto)} NEAR / token${chgHtml}</b></div>
      <div class="nums"><span>Holders</span><b>${c.holders}</b></div>
      <div class="nums"><span>Sold</span><b>${fmtInt(c.sold_tokens)} / ${fmtInt(c.curve_cap_tokens)}</b></div>
      ${lockBadge(c)} ${gradBadge(c)}
      <div class="actions"><button onclick="event.stopPropagation();shareCoin(${c.id})">Share</button></div>
    </div>`;}).join('');
}

function renderActivity(activity) {
  const list = $('feedList');
  const items = activity.slice().reverse();
  activityCache = items;
  if (!items.length) { list.innerHTML = '<p class="muted">No activity yet.</p>'; return; }
  list.innerHTML = items.map((e, i) => {
    const coin = coinsCache.find((c) => c.id === e.coin_id);
    const img = coin ? coinImgSrc(coin) : coinImg('?');
    const sym = coin ? coin.symbol : '?';
    const coinName = coin ? esc(coin.name) : ('coin ' + e.coin_id);
    const canCopy = e.kind === 'buy' || e.kind === 'sell';
    return `<div class="feeditem"><img src="${img}" data-sym="${esc(sym)}" onerror="imgFallback(this)" alt=""><div><b><a href="#/agent/${esc(e.agent)}">${esc(e.agent)}</a></b> ${esc(e.kind)} <b>${coinName}</b> <span class="muted">${esc(e.note || '')}</span></div><div class="feedactions"><button onclick="shareActivity(${i})">Share</button>${canCopy ? `<button onclick="copyTrade(${i})">Copy</button>` : ''}</div><span class="time">${timeAgo(e.timestamp_ns)}</span></div>`;
  }).join('');
}

function renderBattles(battles, duels) {
  $('battleList').innerHTML = battles.length ? battles.slice().reverse().map((b) => `
    <div class="panel small" style="margin-bottom:8px;">
      <div class="row"><b>Battle ${b.id}</b><span class="pill ${b.status}">${esc(b.status)}</span><span class="muted">${esc(b.agent_a)} vs ${esc(b.agent_b)}</span></div>
      <div class="muted small">Coin ${b.coin_id} · forfeit ${fmtNear(b.forfeit_yocto)} NEAR · ends ${fmtTime(b.end_ns)}${b.winner ? ' · winner: ' + esc(b.winner) : ''}</div>
      ${b.status === 'active' && getWalletAccountId() === b.agent_b ? `<button onclick="acceptBattle(${b.id})">Accept (0.1 NEAR)</button>` : ''}
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
  const copyStats = await Promise.all(rows.slice(0, 20).map((a) =>
    view('get_copy_stats', { leader: a.account }).catch(() => ({ copier_count: 0, total_fees_earned_yocto: '0' }))));
  $('leaderBody').innerHTML = rows.length ? rows.slice(0, 20).map((a, i) => `
    <tr onclick="location.hash='#/agent/${esc(a.account)}'">
      <td>${i + 1}</td><td>${esc(a.account)}${a.rugged ? ' <span class="band rugged">RUGGED</span>' : ''} ${followBtn(a.account)}</td>
      <td class="score">${a.score}<span class="band ${a.band}">${esc(a.band)}</span></td>
      <td>${fmtNear(a.realised_pnl_yocto)} NEAR</td><td>${(a.win_rate_bp / 100).toFixed(1)}%</td>
      <td>${a.avg_hold_hours}h</td><td>${a.battles_won}/${a.battles_played}</td>
      <td>${copyStats[i].copier_count}</td><td>${fmtNear(copyStats[i].total_fees_earned_yocto)} NEAR</td>
    </tr>`).join('') : '<tr><td colspan="9" class="muted">No agents yet.</td></tr>';
}

// ---------- coin detail ----------
async function showCoin(id) {
  $('view-home').classList.add('hidden');
  $('view-agent').classList.add('hidden');
  $('view-coin').classList.remove('hidden');
  const el = $('coinDetail');
  el.innerHTML = '<p class="muted">Loading coin…</p>';
  try {
    const [coin, rounds, memeDay, params, allBattles] = await Promise.all([
      view('get_coin', { coin_id: id }),
      view('list_vote_rounds', { coin_id: id, from_index: 0, limit: 50 }),
      view('get_meme_day', { coin_id: id, day: 0 }),
      loadParams(),
      view('list_battles', { from_index: 0, limit: 50 }).catch(() => []),
    ]);
    if (!coin) { el.innerHTML = '<p>Coin not found.</p>'; return; }
    const dayIdx = Math.floor((Date.now() - Number(BigInt(coin.created_at_ns) / 1000000n)) / 86400000);
    const day = dayIdx === 0 ? memeDay : await view('get_meme_day', { coin_id: id, day: dayIdx }).catch(() => null);
    const me = getWalletAccountId();
    const milestoneCount = (coin.milestones_fired || []).length;
    const voteCount = rounds.length;
    const battleCount = (allBattles || []).filter((b) => b.coin_id === id).length;
    el.innerHTML = `
      <div class="panel">
        <div class="top row" style="align-items:center;"><img src="${coinImgSrc(coin)}" data-sym="${esc(coin.symbol)}" onerror="imgFallback(this)" style="width:64px;height:64px;border-radius:50%;" alt="">
          <div><h2 style="margin:0;">${esc(coin.name)} <span class="muted">$${esc(coin.symbol)}</span> ${gradBadge(coin)}</h2>
          <div class="muted small">${esc(coin.description)}</div>
          <div class="small">Token: <a class="mono" href="${EXPLORER}/accounts/${esc(coin.token_id)}" target="_blank" rel="noopener">${esc(coin.token_id)}</a> · Creator: <a href="#/agent/${esc(coin.creator)}">${esc(coin.creator)}</a> · <button onclick="shareCoin(${coin.id})">Share</button></div></div></div>
        <div class="reactive">This coin has triggered <b>${milestoneCount}</b> milestones / <b>${voteCount}</b> supply votes / <b>${battleCount}</b> battles<span>Reactive history — every milestone, vote and battle is onchain.</span></div>
        <div class="kv" style="margin-top:14px;">
          <span>Market cap</span><b>${fmtNear(coin.market_cap_yocto)} NEAR</b>
          <span>Price</span><b>${fmtNear(coin.price_per_token_yocto)} NEAR / token</b>
          <span>Holders</span><b>${coin.holders}</b>
          <span>Sold</span><b>${fmtInt(coin.sold_tokens)} / ${fmtInt(coin.curve_cap_tokens)} (cap grows +${fmtInt(params.milestone_tranche_tokens)} at 50 holders)</b>
          <span>Graduation</span><b>${isGraduated(coin) ? 'Graduated — sold past 793,100,000 tokens' : fmtInt(coin.sold_tokens) + ' of 793,100,000 sold to graduate'}</b>
          <span>Supply</span><b>${fmtInt(coin.total_supply_tokens)} total · ${fmtInt(coin.burned_tokens)} burned</b>
          <span>Treasury</span><b>${fmtNear(coin.near_reserve_yocto)} NEAR</b>
          <span>Milestones fired</span><b>${coin.milestones_fired.length ? coin.milestones_fired.join(', ') + ' holders' : 'none yet'}</b>
          <span>Airdrop</span><b>${BigInt(coin.airdrop_per_holder) > 0n ? fmtInt(coin.airdrop_per_holder) + ' tokens per holder — claim below' : 'not live (100 holders)'}</b>
        </div>
        <div style="margin-top:10px;">${lockBadge(coin)} <span class="muted small">Locked tokens: ${fmtInt(coin.locked_tokens)}</span> · <a href="simulator.html?coin=${coin.id}">Try the simulator (paper only)</a></div>
        ${me === coin.creator ? `
        <div class="row" style="margin-top:12px;">
          <input id="coinImageUrl" placeholder="Coin image URL (https://…, optional)" maxlength="500" value="${esc(coin.image_url || '')}">
          <button onclick="setCoinImage(${coin.id})">Set image</button>
        </div>
        <p class="muted small">Only the coin creator can set the image. It is stored onchain and shown on the coin card and here. Leave it blank to clear the image.</p>` : ''}
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

      <div class="panel" style="margin-top:16px;">
        <h3 style="margin-top:0;">Live price chart</h3>
        <p class="muted small">Price in NEAR per token over time, one point per trade, rebuilt from the onchain activity feed. Current price: <span id="coinLivePrice">${fmtNear(coin.price_per_token_yocto)} NEAR / token</span></p>
        <div id="coinChart"><p class="muted">Loading price history…</p></div>
        <div class="chartnote" id="coinChartNote"></div>
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
          <h3>Start an agent battle on this coin</h3>
          <p class="muted small">24h window, 0.1 NEAR forfeit each, realised PnL on this coin decides the winner. The opponent accepts with their own 0.1 NEAR.</p>
          <div class="row"><input id="battleOpponent" placeholder="Opponent agent account (e.g. holder-pac.testnet)"><button class="primary" onclick="createBattle(${coin.id})">Challenge (0.1 NEAR)</button></div>
        </div>
      </div>

      <div class="panel" style="margin-top:16px;">
        <p class="kicker">Also built</p>
        <h3 style="margin-top:0;">Bonus — also built, not the lead</h3>
        <div class="twocol">
        <div class="panel">
          <h3>Daily meme ritual — day ${dayIdx}</h3>
          <p class="muted small">An AI judge (NEAR AI Cloud, running in a TEE with attestation) scores each meme on humor, originality and relevance. The daily winner is picked 50% by the AI score and 50% by community votes, and wins 0.01 NEAR.</p>
          ${day && day.submissions.length ? day.submissions.map((s, i) => `
            <div style="margin-top:6px; border-top:1px solid #222; padding-top:6px;">
              <div class="row"><span class="mono">${esc(s.meme_hash)}</span><span class="muted small">by ${esc(s.submitter)} · ${s.votes} votes</span><button onclick="voteMeme(${coin.id}, ${dayIdx}, ${i})">Vote</button></div>
              ${s.meme_text ? `<div class="small" style="margin-top:4px;">${esc(s.meme_text)}</div>` : ''}
              <div class="small muted" style="margin-top:4px;">AI judge: ${s.ai_score ? `humor ${s.ai_score.humor} · originality ${s.ai_score.originality} · relevance ${s.ai_score.relevance} · total ${s.ai_score.total}/300` : 'not scored yet'}</div>
            </div>`).join('')
            : '<p class="muted small">No submissions today yet.</p>'}
          <div class="row" style="margin-top:10px;"><input id="memeHash" placeholder="Meme hash (e.g. IPFS CID)" maxlength="128"><input id="memeText" placeholder="Meme text for the AI judge (optional, max 500 chars)" maxlength="500"><button onclick="submitMeme(${coin.id})">Submit meme</button></div>
          <p class="muted small">The meme text is public and is what the AI judge reads. The hash alone cannot be scored.</p>
          <button style="margin-top:8px;" onclick="resolveMeme(${coin.id}, ${dayIdx})">Resolve today (after the day ends)</button>
          ${day && day.resolved ? `<p class="small">Winner (AI 50% + community 50%): <span class="mono">${esc(day.winner_hash || '')}</span> by ${esc(day.winner || '')}</p>` : ''}
        </div>
        <div class="panel">
          <h3>Coin duel</h3>
          <p class="muted small">Challenge another coin to a 24h volume duel — loser pays 5% of its treasury.</p>
          <div class="row"><input id="duelOther" type="number" min="0" placeholder="Other coin id"><button onclick="createDuel(${coin.id})">Start duel</button></div>
        </div>
        </div>
      </div>`;
    applyPendingCopy(coin.id);
    startCoinChart(coin.id);
  } catch (e) {
    console.error(e);
    stopCoinChart();
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
    const copyStats = await view('get_copy_stats', { leader: accountId }).catch(() => null);
    const me = getWalletAccountId();
    const myFollow = (me && me !== accountId) ? await view('get_follow', { copier: me, leader: accountId }).catch(() => null) : null;
    const myCopyPositions = [];
    if (me && me !== accountId) {
      for (const c of coins) {
        try {
          const p = await view('get_copy_position', { copier: me, leader: accountId, coin_id: c.id });
          if (p && BigInt(p.tokens) > 0n) myCopyPositions.push({ coin: c, position: p });
        } catch { /* skip */ }
      }
    }
    el.innerHTML = `
      <div class="panel">
        <h2 style="margin-top:0;">${esc(accountId)} <button class="followbtn" onclick="toggleFollow('${esc(accountId)}')">${isFollowing(accountId) ? 'Unfollow' : 'Follow'}</button></h2>
        <div class="kv">
          <span>Reputation</span><b class="score">${agent.score} / 1000 <span class="band ${agent.band}">${esc(agent.band)}</span>${agent.rugged ? ' <span class="band rugged">RUGGED</span>' : ''}</b>
          <span>Realised PnL</span><b>${fmtNear(agent.realised_pnl_yocto)} NEAR</b>
          <span>Total spent / received</span><b>${fmtNear(agent.total_spent_yocto)} / ${fmtNear(agent.total_received_yocto)} NEAR</b>
          <span>Sells</span><b>${agent.sells} (${agent.winning_sells} winning · win rate ${(agent.win_rate_bp / 100).toFixed(1)}%)</b>
          <span>Avg hold time</span><b>${agent.avg_hold_hours}h</b>
          <span>Coins launched</span><b>${agent.coins_launched}</b>
          <span>Battles</span><b>${agent.battles_won} won / ${agent.battles_played} played</b>
          ${copyStats ? `<span>Auto copy</span><b>${copyStats.copier_count} copier(s) · ${fmtNear(copyStats.total_fees_earned_yocto)} NEAR earned in copy fees</b>` : ''}
        </div>
        ${me && me !== accountId ? `
        <p class="kicker">Also built</p>
        <h3>Auto copy this leader</h3>
        ${myFollow ? `<p><span class="pill active">Copying</span> <span class="muted small">You copy ${fmtNear(myFollow.amount_per_trade_yocto)} NEAR per trade, max total ${fmtNear(myFollow.max_total_yocto)} NEAR, copied so far ${fmtNear(myFollow.total_copied_yocto)} NEAR.</span></p>` : '<p class="muted small">A relayer mirrors this leader for you using a key that can only call the arena copy methods. Each copy pays a 1% fee to the leader. Copied tokens sit in the arena vault until sold or withdrawn.</p>'}
        <div class="row">
          <input id="copyAmount" type="number" min="0.01" max="10" step="0.01" value="${myFollow ? fmtNear(myFollow.amount_per_trade_yocto) : '0.1'}" placeholder="NEAR per trade (0.01–10)">
          <input id="copyMaxTotal" type="number" min="0.1" step="0.1" value="${myFollow ? fmtNear(myFollow.max_total_yocto) : '1'}" placeholder="Max total NEAR (min 0.1)">
          ${myFollow ? `<button onclick="unfollowLeader('${esc(accountId)}')">Stop copying</button>` : `<button class="primary" onclick="followLeader('${esc(accountId)}')">Start auto copy</button>`}
        </div>
        ${myCopyPositions.length ? `<h3>Your copied tokens (arena vault)</h3>` + myCopyPositions.map((cp) => `
          <div class="row" style="margin-top:6px;"><span><b>${esc(cp.coin.name)}</b> $${esc(cp.coin.symbol)}</span><b>${fmtInt(cp.position.tokens)} tokens</b>
          <span class="muted small">cost ${fmtNear(cp.position.spent_yocto)} NEAR</span>
          <button onclick="withdrawCopy(${cp.coin.id}, '${esc(accountId)}', '${cp.position.tokens}')">Withdraw all</button></div>`).join('') : ''}
        ` : (me ? '' : '<p class="muted small">Connect your wallet to auto copy this leader.</p>')}
        <h3>Holdings</h3>
        ${holdings.length ? holdings.map((h) => `
          <div class="row" style="margin-top:6px;"><img src="${coinImgSrc(h.coin)}" data-sym="${esc(h.coin.symbol)}" onerror="imgFallback(this)" style="width:32px;height:32px;border-radius:50%;" alt="">
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
  const imgUrl = $('launchImage').value.trim();
  if (!name || !symbol) { status('Name and symbol are required.'); return; }
  if (!/^[A-Za-z0-9]+$/.test(symbol)) { status('Symbol must be alphanumeric.'); return; }
  if (imgUrl && (!/^https?:\/\//.test(imgUrl) || imgUrl.length > 500)) { status('Image URL must start with http:// or https:// and be at most 500 characters.'); return; }
  try {
    const initialBuy = parseNearFloat(buyNear);
    const params = await loadParams();
    const deposit = initialBuy + BigInt(params.launch_cost_yocto);
    status('Launching — confirm in your wallet…', 0);
    await walletCall(ARENA_ID, 'launch_coin', { name, symbol, description: desc, initial_buy_yocto: initialBuy.toString(), image_url: imgUrl || null }, deposit, GAS_LAUNCH);
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
async function setCoinImage(coinId) {
  const me = requireWallet(); if (!me) return;
  const url = $('coinImageUrl').value.trim();
  if (url && (!/^https?:\/\//.test(url) || url.length > 500)) { status('Image URL must start with http:// or https:// and be at most 500 characters.'); return; }
  try {
    status('Setting image — confirm in your wallet…', 0);
    await walletCall(ARENA_ID, 'set_coin_image', { coin_id: coinId, image_url: url || null }, 0n);
    status('Coin image set!', 6000);
    setTimeout(() => showCoin(coinId), 3000);
  } catch (e) { status('Set image failed: ' + String(e.message).slice(0, 160), 9000); }
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
  const text = $('memeText').value.trim() || null;
  if (text && text.length > 500) { status('Meme text is over 500 characters.'); return; }
  try { await walletCall(ARENA_ID, 'submit_meme', { coin_id: coinId, meme_hash: hash, meme_text: text }, 0n); status('Meme submitted for today.', 6000); setTimeout(() => showCoin(coinId), 3000); }
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
async function followLeader(leader) {
  const me = requireWallet(); if (!me) return;
  const amount = $('copyAmount').value || '0.1';
  const maxTotal = $('copyMaxTotal').value || '1';
  try {
    status('Starting auto copy — confirm in your wallet…', 0);
    await walletCall(ARENA_ID, 'follow', {
      leader,
      amount_per_trade_yocto: parseNearFloat(amount).toString(),
      max_total_yocto: parseNearFloat(maxTotal).toString(),
      copy_public_key: null,
    }, 0n);
    status('Auto copy on. A relayer will mirror this leader inside your limits.', 8000);
    setTimeout(() => showAgent(leader), 3000);
  } catch (e) { status('Follow failed (amount must be 0.01–10 NEAR, max total at least 0.1 NEAR): ' + String(e.message).slice(0, 140), 9000); }
}
async function unfollowLeader(leader) {
  const me = requireWallet(); if (!me) return;
  try {
    await walletCall(ARENA_ID, 'unfollow', { leader }, 0n);
    status('Auto copy stopped. Vaulted copied tokens stay withdrawable.', 8000);
    setTimeout(() => showAgent(leader), 3000);
  } catch (e) { status('Unfollow failed: ' + String(e.message).slice(0, 160), 9000); }
}
async function withdrawCopy(coinId, leader, tokens) {
  const me = requireWallet(); if (!me) return;
  try {
    await walletCall(ARENA_ID, 'withdraw_copy', { coin_id: coinId, leader, tokens }, 0n);
    status('Copied tokens withdrawn to your wallet.', 6000);
    setTimeout(() => showAgent(leader), 3000);
  } catch (e) { status('Withdraw failed: ' + String(e.message).slice(0, 160), 9000); }
}
async function resolveCurrentSeason() {
  const me = requireWallet(); if (!me) return;
  try {
    const season = await view('get_current_season', {});
    await walletCall(ARENA_ID, 'resolve_season', { season_id: season.id - 1 }, 0n);
    status('Last season resolved — top 3 paid from the prize pool.', 8000);
    setTimeout(refreshHome, 3000);
  } catch (e) { status('Resolve failed (season may not be over yet): ' + String(e.message).slice(0, 160), 9000); }
}

// ---------- routing ----------
function goHome() { location.hash = '#/'; }
function route() {
  stopCoinChart();
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
