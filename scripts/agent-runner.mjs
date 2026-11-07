// PAC agent loop — the brain behind a PAC agent wallet.
//
// One decision cycle: REGISTER (first run: register the wallet as an
// agent) -> SENSE (read live chain state) -> THINK (ask NEAR AI for a
// structured decision) -> ACT (sign at most one arena action) ->
// REMEMBER (append the decision to the per-agent log).
//
// A wallet on its own is not an agent: it holds funds and signs, but
// it cannot decide. This loop is the deciding part. It runs on its own
// (see scripts/agent-loop.sh and the scheduler docs in README.md), so
// the wallet's trades, battles and votes are the agent's own decisions,
// not a human pressing run.
//
// The NEAR AI key is NOT read from an env var and never appears here.
// Decisions go through the stored connector custom.near-ai-pac
// (~/workspace/custom-connectors/custom.near-ai-pac/bin/near-ai-call.py),
// which calls NEAR AI Cloud with the credential held in the Secure
// Vault. If the helper is missing or a call fails, the runner does
// nothing (fail closed). The key is never printed, never written to a
// file, and never committed.
//
// SAFETY LIMITS (hard, in code, never overridden by the model):
//   - max 1 NEAR per buy / sell / battle stake.
//   - never spend below a 1 NEAR reserve balance (NEAR left after the
//     action, not counting gas, must stay >= 1 NEAR).
//   - at most 1 action per cycle per agent.
//   - the agent NEVER approves a token, transfers funds to an arbitrary
//     address, or signs anything except the arena's buy / sell
//     (ft_transfer_call to the arena with msg "sell") / create_battle /
//     accept_battle / vote calls.
//   - any step that fails means do nothing and log the failure.
//
// BATTLE MODEL: the runner reads get_params and adapts.
//   - v7 (battle_min_stake_yocto present): the two agents decide the
//     stake. The challenger attaches any amount >= the minimum (0.1
//     NEAR) and the opponent must match it exactly. The runner uses
//     the model's chosen stake, clamped to [minimum, 1 NEAR].
//   - v6 (only battle_forfeit_yocto present): the forfeit is fixed at
//     0.1 NEAR. The runner forces the stake to exactly the fixed
//     forfeit, whatever the model asked for, and notes it in the log.
//     The stake-choice part activates with v7.
//
// Usage:
//   node scripts/agent-runner.mjs --agent degen [--dry-run]
//   node scripts/agent-runner.mjs --agent holder --dry-run
//   node scripts/agent-runner.mjs --all [--dry-run]
//   PAC_NEAR_AI_MODEL=z-ai/glm-5.3-flash node scripts/agent-runner.mjs --agent sniper
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';

const ARENA_ID = process.env.PAC_ARENA_ID || 'pac-arena.testnet';
const ACCOUNTS_FILE = new URL('../.testnet-accounts.json', import.meta.url);
const PERSONALITIES_FILE = new URL('./agent-personalities.json', import.meta.url);
const MEMORY_DIR = process.env.PAC_MEMORY_DIR || new URL('../agent-memory/', import.meta.url);
const RPC = 'https://rpc.testnet.fastnear.com';
const DEFAULT_MODEL = 'z-ai/glm-5.3-flash';
const NEAR_AI_HELPER = fileURLToPath(new URL('../../custom-connectors/custom.near-ai-pac/bin/near-ai-call.py', import.meta.url));

if (!fs.existsSync(NEAR_AI_HELPER)) {
  console.error('agent-runner: NEAR AI helper not found at ' + NEAR_AI_HELPER + '. Refusing to run (fail closed).');
  process.exit(1);
}
const MODEL = process.env.PAC_NEAR_AI_MODEL || DEFAULT_MODEL;

// --- safety limits (hard) -------------------------------------------------
const MAX_ACTION_NEAR = 1;        // max NEAR per buy / sell / battle stake
const RESERVE_NEAR = 1;           // NEAR that must remain after the action
const MIN_SELL_PROCEEDS_NEAR = 0.01;
const GAS = 100_000_000_000_000n;
const YOCTO_PER_NEAR = 10n ** 24n;
const nearToYocto = (n) => BigInt(Math.round(Number(n) * 1e6)) * (10n ** 18n); // via micro-NEAR, avoids float error
const yoctoToNear = (y) => Number(BigInt(y)) / 1e24;
const fmtNear = (y) => yoctoToNear(y).toFixed(4);

// --- CLI ------------------------------------------------------------------
const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const DRY_RUN = args.includes('--dry-run');
const RUN_ALL = args.includes('--all');
const AGENT_ARG = arg('--agent', null);
const ROLES = ['degen', 'holder', 'sniper'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- NEAR AI (via the stored connector) -----------------------------------
function callNearAi(messages, maxTokens, temperature = 0.4) {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [NEAR_AI_HELPER, 'complete'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => reject(new Error(`near-ai helper could not start: ${err.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`near-ai helper exited ${code}: ${stderr.trim().slice(0, 300) || 'no detail'}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`near-ai helper returned invalid JSON: ${stdout.slice(0, 200)}`));
      }
    });
    proc.stdin.end(JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature }));
  });
}

const DECISION_SYSTEM_PROMPT = `You are the trading brain of an AI agent that owns a public wallet on PAC, an onchain memecoin arena on NEAR testnet. Every agent is a fully public wallet: anyone can see your holdings, your trades and your reputation score. You decide what your wallet does next. Reply with ONLY a JSON object, no other text:
{"action": "buy"|"sell"|"hold"|"battle"|"vote"|"none", "coin_id": <integer or null>, "amount_near": <number or null>, "opponent": "<account or null>", "battle_id": <integer or null>, "choice_index": <0|1|2 or null>, "reasoning": "<one sentence>", "confidence": <0-100>}
Rules:
- "buy": buy coin_id with amount_near NEAR (0.05 to 1). Only buy a coin that exists and is moving in a way that fits your style.
- "sell": sell tokens of coin_id worth about amount_near NEAR (0.05 to 1). Only sell a coin you hold.
- "hold": do nothing this cycle, you like your current positions.
- "battle": challenge "opponent" on coin_id with a stake of amount_near NEAR (0.1 to 1). Only battle when you believe your realised PnL on that coin will beat theirs. If "battle_id" is given instead, it means ACCEPT that pending battle (amount_near must equal its stake); use this only when a pending battle against you is listed.
- "vote": vote in the open supply round for coin_id. "choice_index" 0 burns 2% of supply, 1 mints 2%, 2 does nothing. Only vote when a round is open and you hold that coin.
- "none": no sensible action this cycle.
- Never invent a coin, an opponent, a battle or a round. Use only what is listed in the state. If nothing fits your style, choose "hold" or "none".`;

function parseDecision(content) {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`model did not return JSON: ${content.slice(0, 200)}`);
  const d = JSON.parse(match[0]);
  const actions = ['buy', 'sell', 'hold', 'battle', 'vote', 'none'];
  if (!actions.includes(d.action)) throw new Error(`unknown action: ${d.action}`);
  if (typeof d.reasoning !== 'string' || d.reasoning.trim().length === 0) throw new Error('decision has no reasoning');
  d.confidence = Math.max(0, Math.min(100, Math.round(Number(d.confidence))));
  if (!Number.isFinite(d.confidence)) throw new Error('decision has no numeric confidence');
  if (d.coin_id !== null && d.coin_id !== undefined) d.coin_id = Number(d.coin_id);
  if (d.amount_near !== null && d.amount_near !== undefined) d.amount_near = Number(d.amount_near);
  if (d.battle_id !== null && d.battle_id !== undefined) d.battle_id = Number(d.battle_id);
  if (d.choice_index !== null && d.choice_index !== undefined) d.choice_index = Number(d.choice_index);
  return d;
}

async function think(personality, stateText, memoryText) {
  const messages = [
    { role: 'system', content: DECISION_SYSTEM_PROMPT },
    { role: 'user', content: `You are ${personality.name} (${personality.account}). Your style: ${personality.style}\n\nCURRENT STATE (live from the chain):\n${stateText}\n\nYOUR RECENT DECISIONS (most recent last):\n${memoryText || '(none yet)'}\n\nDecide your next action.` },
  ];
  // The model reasons before it answers, so a small token budget can be
  // spent on reasoning with nothing left for the reply. Retry with a
  // larger budget before giving up. Never invent a decision.
  for (const maxTokens of [2000, 4000]) {
    let result;
    try {
      result = await callNearAi(messages, maxTokens);
    } catch (e) {
      if (/empty model output/i.test(e.message)) continue;
      throw e;
    }
    const content = (result.output || '').trim();
    if (!content) continue;
    try {
      return { decision: parseDecision(content), verifiable: !!result.verifiable };
    } catch (e) {
      console.error(`  think: unusable model output at ${maxTokens} tokens (${e.message}), retrying...`);
    }
  }
  throw new Error('model did not return a usable decision');
}

// --- memory ----------------------------------------------------------------
function memoryDirPath() {
  return typeof MEMORY_DIR === 'string' ? MEMORY_DIR : fileURLToPath(MEMORY_DIR);
}
function memoryPath(role) {
  return path.join(memoryDirPath(), `${role}.jsonl`);
}
function readMemory(role, lines = 8) {
  try {
    const p = memoryPath(role);
    if (!fs.existsSync(p)) return [];
    const all = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
    return all.slice(-lines).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
function appendMemory(role, entry) {
  fs.mkdirSync(memoryDirPath(), { recursive: true });
  fs.appendFileSync(memoryPath(role), JSON.stringify(entry) + '\n');
}

// --- NEAR -------------------------------------------------------------------
const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
const personalities = JSON.parse(fs.readFileSync(PERSONALITIES_FILE, 'utf8'));
const keyStore = new keyStores.InMemoryKeyStore();
for (const role of ['arena', 'degen', 'holder', 'sniper']) {
  await keyStore.setKey('testnet', accounts[role].accountId, KeyPair.fromString(accounts[role].privateKey));
}
const near = await connect({
  networkId: 'testnet', nodeUrl: RPC,
  walletUrl: 'https://testnet.mynearwallet.com/',
  helperUrl: 'https://helper.testnet.near.org', keyStore,
});
const arena = await near.account(ARENA_ID);
const parseNear = (n) => utils.format.parseNearAmount(n);
const acct = (role) => near.account(accounts[role].accountId);

async function withRetry(fn, label) {
  let delay = 2000;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      const retryable = msg.includes('429') || msg.includes('503') || msg.includes('502') || msg.includes('ECONNRESET') || msg.includes('timeout');
      if (!retryable || attempt === 6) throw e;
      await sleep(delay);
      delay *= 2;
    }
  }
}
async function view(method, a = {}) {
  return withRetry(() => arena.viewFunction({ contractId: ARENA_ID, methodName: method, args: a }), `view ${method}`);
}
async function call(role, method, a, depositYocto = 0n, gas = GAS) {
  const account = await acct(role);
  return withRetry(() => account.functionCall({
    contractId: ARENA_ID, methodName: method, args: a,
    gas, attachedDeposit: BigInt(depositYocto),
  }), `call ${method}`);
}
async function tokenView(tokenId, method, a = {}) {
  const account = await acct('arena');
  return withRetry(() => account.viewFunction({ contractId: tokenId, methodName: method, args: a }), `token ${method}`);
}
async function tokenCall(role, tokenId, method, a, depositYocto = 0n, gas = GAS) {
  const account = await acct(role);
  return withRetry(() => account.functionCall({
    contractId: tokenId, methodName: method, args: a,
    gas, attachedDeposit: BigInt(depositYocto),
  }), `tokenCall ${method}`);
}

// --- one decision cycle -----------------------------------------------------
async function runCycle(role) {
  const person = personalities[role];
  const accountId = accounts[role].accountId;
  const startedAt = new Date().toISOString();
  const log = (msg) => console.log(`[${role}] ${msg}`);
  const record = { ts: startedAt, agent: accountId, role, dry_run: DRY_RUN, decision: null, tx: null, outcome: null, error: null };

  try {
    // SENSE -----------------------------------------------------------------
    log('sensing live chain state...');
    const [params, stats, coins, me, pool, season, myAccount] = await Promise.all([
      view('get_params', {}),
      view('get_stats', {}),
      view('list_coins', { from_index: 0, limit: 20 }),
      view('get_agent', { account: accountId }),
      view('get_prize_pool', {}),
      view('get_current_season', {}),
      acct(role).then((a) => a.state()),
    ]);
    const balanceYocto = BigInt(myAccount.amount);
    const v7 = params.battle_min_stake_yocto !== undefined && params.battle_min_stake_yocto !== null;
    const minStakeYocto = BigInt(v7 ? params.battle_min_stake_yocto : params.battle_forfeit_yocto);
    const fixedForfeitYocto = v7 ? null : BigInt(params.battle_forfeit_yocto);
    log(`arena v${params.schema_version || '?'} (${v7 ? 'agents-decide stake, min ' + fmtNear(minStakeYocto) + ' NEAR' : 'fixed forfeit ' + fmtNear(fixedForfeitYocto) + ' NEAR'}), balance ${fmtNear(balanceYocto)} NEAR, score ${me ? me.score : '?'} (${me ? me.band : '?'})`);

    // REGISTER — first run for a wallet, register it as an agent so the
    // site shows its AGENT badge. Idempotent: if get_agent already says
    // is_agent, skip. If register_agent does not exist yet (v6, or a v7
    // without registration), log that and continue — registration must
    // never block the sense→think→act cycle. To avoid a failed tx on
    // every cycle while the method is unavailable, remember the
    // outcome in the memory log and only retry when the arena schema
    // version changes.
    const memory = readMemory(role);
    const lastReg = [...memory].reverse().find((m) => m.registration);
    if (me && me.is_agent === true) {
      record.registration = 'already-registered';
      log('wallet already registered as an agent, skipping register_agent.');
    } else if (lastReg && lastReg.registration && lastReg.registration.startsWith('unavailable') && lastReg.schema_version === params.schema_version) {
      record.registration = lastReg.registration + ' (cached, schema unchanged)';
      log('registration unavailable on this arena schema, skipping retry.');
    } else if (DRY_RUN) {
      record.registration = 'dry-run (would call register_agent)';
      log('[dry run] would call register_agent (no args, no deposit).');
    } else {
      try {
        await call(role, 'register_agent', {});
        record.registration = 'registered';
        log('registered wallet as an agent (register_agent).');
      } catch (e) {
        const msg = String(e && e.message ? e.message : e).slice(0, 160);
        record.registration = `unavailable: ${msg}`;
        log(`register_agent not available yet (${msg}), continuing without it.`);
      }
    }
    record.schema_version = params.schema_version;

    // My holdings per coin.
    const holdings = [];
    for (const coin of coins) {
      try {
        const bal = await tokenView(coin.token_id, 'ft_balance_of', { account_id: accountId });
        if (BigInt(bal) > 0n) holdings.push({ coin_id: coin.id, symbol: coin.symbol, tokens: bal });
      } catch { /* unregistered / no balance: not a holder */ }
    }
    // Other agents' scores.
    const others = [];
    for (const r of ROLES) {
      if (r === role) continue;
      try {
        const a = await view('get_agent', { account: accounts[r].accountId });
        if (a) others.push({ account: accounts[r].accountId, score: a.score, band: a.band, realised_pnl_near: fmtNear(BigInt(a.realised_pnl_yocto)), sells: a.sells, win_rate_bp: a.win_rate_bp });
      } catch { /* ignore */ }
    }
    // My open battles (pending = I am the challenged opponent; active = in window).
    const allBattles = await view('list_battles', { from_index: 0, limit: 50 });
    const myBattles = allBattles.filter((b) => (b.agent_a === accountId || b.agent_b === accountId) && (b.status === 'pending' || b.status === 'active'));
    const pendingAgainstMe = myBattles.filter((b) => b.status === 'pending' && b.agent_b === accountId);
    // Open supply vote rounds for coins I hold (or any coin).
    const openRounds = [];
    for (const coin of coins) {
      const rounds = await view('list_vote_rounds', { coin_id: coin.id, from_index: 0, limit: 5 });
      for (const r of rounds) {
        if (!r.executed && BigInt(r.deadline_ns) > BigInt(Date.now()) * 1000000n) {
          openRounds.push({ round_id: r.id, coin_id: coin.id, symbol: coin.symbol, choices: r.choices, votes: r.votes, voters: r.voters });
        }
      }
    }
    const state = {
      agent: accountId, balance_near: fmtNear(balanceYocto),
      score: me ? me.score : null, band: me ? me.band : null,
      realised_pnl_near: me ? fmtNear(BigInt(me.realised_pnl_yocto)) : null,
      sells: me ? me.sells : null, win_rate_bp: me ? me.win_rate_bp : null,
      holdings: holdings.map((h) => `${h.symbol} (coin ${h.coin_id}): ${h.tokens} base units`),
      coins: coins.map((c) => `coin ${c.id} ${c.name} ($${c.symbol}): sold ${c.sold_tokens}, price ${fmtNear(BigInt(c.price_per_token_yocto))} NEAR/token, holders ${c.holders}`),
      other_agents: others,
      my_battles: myBattles.map((b) => `#${b.id} coin ${b.coin_id} vs ${b.agent_a === accountId ? b.agent_b : b.agent_a}, stake ${fmtNear(BigInt(b.forfeit_yocto))} NEAR, status ${b.status}`),
      pending_battles_against_me: pendingAgainstMe.map((b) => `#${b.id} coin ${b.coin_id} from ${b.agent_a}, stake ${fmtNear(BigInt(b.forfeit_yocto))} NEAR`),
      open_vote_rounds: openRounds.map((r) => `round ${r.round_id} coin ${r.coin_id} ($${r.symbol}): choices ${r.choices.join(' / ')}, votes so far ${r.votes.join(', ')}, voters ${r.voters}`),
      prize_pool_near: fmtNear(BigInt(pool)), season_id: season.id,
      battle_model: v7 ? `agents decide the stake, minimum ${fmtNear(minStakeYocto)} NEAR, no maximum` : `fixed forfeit ${fmtNear(fixedForfeitYocto)} NEAR (v6; stake choice activates with v7)`,
    };
    const stateText = [
      `Balance: ${state.balance_near} NEAR. Reputation: ${state.score} (${state.band}), realised PnL ${state.realised_pnl_near} NEAR, ${state.sells} sells, win rate ${state.win_rate_bp} bp.`,
      `My holdings: ${state.holdings.length ? state.holdings.join('; ') : 'none'}.`,
      `Coins: ${state.coins.join(' | ')}`,
      `Other agents: ${state.other_agents.map((o) => `${o.account} score ${o.score} (${o.band}), PnL ${o.realised_pnl_near} NEAR, ${o.sells} sells`).join('; ') || 'none'}.`,
      `My battles: ${state.my_battles.length ? state.my_battles.join('; ') : 'none'}.`,
      `Pending battles against me (I can accept): ${state.pending_battles_against_me.length ? state.pending_battles_against_me.join('; ') : 'none'}.`,
      `Open supply vote rounds: ${state.open_vote_rounds.length ? state.open_vote_rounds.join('; ') : 'none'}.`,
      `Prize pool: ${state.prize_pool_near} NEAR, season ${state.season_id}.`,
      `Battle model: ${state.battle_model}.`,
      `Limits for this cycle: max 1 NEAR per action, keep at least 1 NEAR reserve, at most 1 action.`,
    ].join('\n');
    record.state = { balance_near: state.balance_near, score: state.score, holdings: state.holdings, battle_model: state.battle_model };

    // THINK ------------------------------------------------------------------
    const memoryText = memory.map((m) => `- ${m.ts}: ${m.decision ? m.decision.action : '?'}${m.decision && m.decision.coin_id !== null && m.decision.coin_id !== undefined ? ' coin ' + m.decision.coin_id : ''} — ${m.decision ? m.decision.reasoning : ''} (${m.outcome || 'no outcome'})`).join('\n');
    log(`thinking via ${MODEL}...`);
    const { decision, verifiable } = await think(person, stateText, memoryText);
    record.decision = decision;
    record.model_verifiable = verifiable;
    log(`decision: ${decision.action}${decision.coin_id !== null && decision.coin_id !== undefined ? ' coin ' + decision.coin_id : ''}${decision.amount_near ? ' ' + decision.amount_near + ' NEAR' : ''} — "${decision.reasoning}" (confidence ${decision.confidence}${verifiable ? ', attested' : ''})`);

    if (decision.action === 'hold' || decision.action === 'none') {
      record.outcome = 'no action (hold/none)';
      appendMemory(role, record);
      log('no action this cycle.');
      return record;
    }

    // ACT — validate, then sign at most one action. --------------------------
    if (decision.confidence < 30) {
      record.outcome = `skipped: confidence ${decision.confidence} below 30`;
      appendMemory(role, record);
      log('confidence too low, doing nothing.');
      return record;
    }
    const coin = decision.coin_id !== null && decision.coin_id !== undefined
      ? coins.find((c) => c.id === Number(decision.coin_id))
      : null;
    if (['buy', 'sell', 'vote'].includes(decision.action) && !coin) {
      record.outcome = 'skipped: unknown coin_id ' + decision.coin_id;
      appendMemory(role, record);
      log('unknown coin, doing nothing.');
      return record;
    }

    let tx = null;
    if (decision.action === 'buy') {
      const amount = Number(decision.amount_near);
      if (!Number.isFinite(amount) || amount < 0.05 || amount > MAX_ACTION_NEAR) {
        record.outcome = `skipped: buy amount ${decision.amount_near} outside 0.05–1 NEAR`;
      } else if (balanceYocto - nearToYocto(amount) < nearToYocto(RESERVE_NEAR)) {
        record.outcome = `skipped: buy of ${amount} NEAR would break the 1 NEAR reserve (balance ${fmtNear(balanceYocto)})`;
      } else {
        // First buy of a token needs a storage deposit on the token.
        try {
          const reg = await tokenView(coin.token_id, 'storage_balance_of', { account_id: accountId });
          if (!reg || BigInt(reg.total || 0) === 0n) {
            log('registering storage on ' + coin.token_id + ' first...');
            if (!DRY_RUN) await tokenCall(role, coin.token_id, 'storage_deposit', { account_id: accountId }, nearToYocto(0.01));
            else log('[dry run] would storage_deposit 0.01 NEAR on ' + coin.token_id);
          }
        } catch (e) {
          log('storage check failed (' + String(e.message).slice(0, 100) + '), attempting buy anyway');
        }
        if (DRY_RUN) {
          record.outcome = `[dry run] would buy coin ${coin.id} with ${amount} NEAR`;
        } else {
          tx = await call(role, 'buy', { coin_id: coin.id }, nearToYocto(amount));
          record.outcome = `bought coin ${coin.id} with ${amount} NEAR`;
        }
      }
    } else if (decision.action === 'sell') {
      const holding = holdings.find((h) => h.coin_id === coin.id);
      if (!holding) {
        record.outcome = `skipped: no holdings in coin ${coin.id} to sell`;
      } else {
        const targetNear = Number(decision.amount_near);
        if (!Number.isFinite(targetNear) || targetNear < 0.05 || targetNear > MAX_ACTION_NEAR) {
          record.outcome = `skipped: sell amount ${decision.amount_near} outside 0.05–1 NEAR`;
        } else {
          const priceYocto = BigInt(coin.price_per_token_yocto);
          const meta = await tokenView(coin.token_id, 'ft_metadata', {});
          const decimals = Number(meta.decimals);
          // tokens (base units) worth ~targetNear at current price.
          const tokensToSell = (nearToYocto(targetNear) * (10n ** BigInt(decimals))) / priceYocto;
          const have = BigInt(holding.tokens);
          const sellTokens = tokensToSell > have ? have : tokensToSell;
          if (sellTokens <= 0n) {
            record.outcome = 'skipped: computed sell amount is zero';
          } else {
            if (DRY_RUN) {
              record.outcome = `[dry run] would sell ${sellTokens} base units of coin ${coin.id} (~${targetNear} NEAR)`;
            } else {
              tx = await tokenCall(role, coin.token_id, 'ft_transfer_call',
                { receiver_id: ARENA_ID, amount: sellTokens.toString(), memo: null, msg: 'sell' }, 1n);
              record.outcome = `sold ${sellTokens} base units of coin ${coin.id} (~${targetNear} NEAR)`;
            }
          }
        }
      }
    } else if (decision.action === 'battle') {
      if (decision.battle_id !== null && decision.battle_id !== undefined) {
        // Accept a pending battle against me.
        const b = pendingAgainstMe.find((x) => x.id === Number(decision.battle_id));
        if (!b) {
          record.outcome = `skipped: no pending battle #${decision.battle_id} against me`;
        } else {
          const stake = BigInt(b.forfeit_yocto);
          if (stake > nearToYocto(MAX_ACTION_NEAR)) {
            record.outcome = `skipped: battle #${b.id} stake ${fmtNear(stake)} NEAR exceeds the 1 NEAR limit`;
          } else if (balanceYocto - stake < nearToYocto(RESERVE_NEAR)) {
            record.outcome = `skipped: accepting battle #${b.id} would break the 1 NEAR reserve`;
          } else if (DRY_RUN) {
            record.outcome = `[dry run] would accept battle #${b.id} with ${fmtNear(stake)} NEAR`;
          } else {
            tx = await call(role, 'accept_battle', { battle_id: b.id }, stake);
            record.outcome = `accepted battle #${b.id} with ${fmtNear(stake)} NEAR`;
          }
        }
      } else {
        // Create a new battle vs the chosen opponent.
        const opponent = decision.opponent;
        if (!opponent || opponent === accountId || !ROLES.some((r) => accounts[r].accountId === opponent)) {
          record.outcome = `skipped: invalid battle opponent ${opponent}`;
        } else {
          let stakeNear = Number(decision.amount_near);
          if (!Number.isFinite(stakeNear) || stakeNear < 0.05) stakeNear = v7 ? 0.1 : 0.1;
          if (v7) {
            stakeNear = Math.max(yoctoToNear(minStakeYocto), Math.min(MAX_ACTION_NEAR, stakeNear));
          } else {
            // v6: the forfeit is fixed. Force exactly 0.1 NEAR.
            stakeNear = yoctoToNear(fixedForfeitYocto);
            log(`v6 fixed forfeit: stake forced to ${stakeNear} NEAR (model asked ${decision.amount_near})`);
          }
          const stake = nearToYocto(stakeNear);
          if (balanceYocto - stake < nearToYocto(RESERVE_NEAR)) {
            record.outcome = `skipped: battle stake ${stakeNear} NEAR would break the 1 NEAR reserve`;
          } else if (DRY_RUN) {
            record.outcome = `[dry run] would create battle vs ${opponent} on coin ${coin.id} with ${stakeNear} NEAR`;
          } else {
            tx = await call(role, 'create_battle', { coin_id: coin.id, opponent }, stake);
            record.outcome = `created battle vs ${opponent} on coin ${coin.id} with ${stakeNear} NEAR`;
          }
        }
      }
    } else if (decision.action === 'vote') {
      const choice = Number(decision.choice_index);
      if (![0, 1, 2].includes(choice)) {
        record.outcome = `skipped: invalid vote choice_index ${decision.choice_index}`;
      } else {
        const round = openRounds.find((r) => r.coin_id === coin.id);
        if (!round) {
          record.outcome = `skipped: no open vote round for coin ${coin.id}`;
        } else if (!holdings.some((h) => h.coin_id === coin.id)) {
          record.outcome = `skipped: not a holder of coin ${coin.id}, cannot vote`;
        } else if (DRY_RUN) {
          record.outcome = `[dry run] would vote choice ${choice} in round ${round.round_id} (coin ${coin.id})`;
        } else {
          try {
            tx = await call(role, 'vote', { round_id: round.round_id, choice_index: choice });
            record.outcome = `voted choice ${choice} in round ${round.round_id} (coin ${coin.id})`;
          } catch (e) {
            // Already voted (or round closed between sense and act): not fatal.
            record.outcome = `vote failed (probably already voted): ${String(e.message).slice(0, 120)}`;
          }
        }
      }
    }

    if (tx) {
      const hash = tx?.transaction?.hash || tx?.transaction_outcome?.id || null;
      record.tx = hash;
      log(`onchain tx: ${hash || '(hash not captured)'}`);
    }
    appendMemory(role, record);
    log(record.outcome);
    return record;
  } catch (e) {
    record.error = String(e && e.message ? e.message : e).slice(0, 500);
    record.outcome = 'cycle failed: ' + record.error;
    appendMemory(role, record);
    log('FAILED: ' + record.error);
    return record;
  }
}

// --- main -------------------------------------------------------------------
const roles = RUN_ALL ? ROLES : (AGENT_ARG ? [AGENT_ARG] : []);
if (roles.length === 0 || roles.some((r) => !ROLES.includes(r))) {
  console.error('agent-runner: use --agent degen|holder|sniper or --all');
  process.exit(1);
}
console.log(`agent-runner: model ${MODEL}${DRY_RUN ? ' (dry run — nothing will be signed)' : ''}`);
for (const role of roles) {
  console.log(`\n=== ${role} (${accounts[role].accountId}) ===`);
  await runCycle(role);
  if (roles.length > 1) await sleep(5000);
}
console.log('\nagent-runner: done.');
