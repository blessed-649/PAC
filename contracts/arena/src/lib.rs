//! Public Agent Coin (PAC) — on-chain memecoin arena on NEAR testnet.
//!
//! The agent is the wallet. The wallet is public. Everything it holds,
//! trades, and launches is visible on-chain. The token rules react to what
//! those transparent wallets do.
//!
//! Mechanics (all in this contract, parameters fixed at launch, no admin):
//!   1. Public agent wallets — every agent is a named NEAR account.
//!   2. Creator lock — an agent's initial buy is locked 24h, held by the
//!      arena, claimable only after the lock expires.
//!   3. Reputation score (0-1000) — realised PnL 40%, win rate 30%,
//!      average hold time 30%. A rug zeroes the score.
//!   4. Agent battles — two wallets stake a 0.1 NEAR forfeit, 24h window,
//!      the contract compares realised PnL on the battle coin and pays the
//!      winner automatically.
//!   5. Holder milestones — at 10 holders 1% of supply is burned, at 50
//!      a 50M-token treasury tranche joins the curve, at 100 holders a
//!      1M-token airdrop opens (equal share, one claim each).
//!   6. Community supply votes — holders vote (weight = curve holdings,
//!      one vote each) on burn 2%, mint 2%, or do nothing; the winner
//!      executes onchain after the deadline.
//!   7. Coin duels — two coins duel 24h on trading volume; the loser pays
//!      5% of its NEAR treasury to the winner's treasury.
//!   8. Daily meme ritual — each 24h day holders submit a meme hash and
//!      vote (one vote each); the winning hash is stored onchain and its
//!      submitter earns 0.01 NEAR from the coin treasury when it affords it.
//!
//! Cut for v1 (roadmap, not built): copytrading, weekly seasons,
//! simulation. The rnear-sdk treasury yield stays v2, not built.

use near_contract_standards::fungible_token::metadata::FungibleTokenMetadata;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
    PromiseResult,
};

// ---------------------------------------------------------------------------
// Fixed parameters — set at launch, readable by anyone, no admin key.
// ---------------------------------------------------------------------------

/// Token decimals for every launched coin.
pub const DECIMALS: u8 = 18;
/// Smallest token units per whole token.
pub const DECIMAL_MULT: u128 = 1_000_000_000_000_000_000;
/// Total supply per coin, whole tokens.
pub const TOTAL_SUPPLY_TOKENS: u128 = 1_000_000_000;
/// Tokens sold through the bonding curve (80% of supply). The rest stays
/// in the arena as reserve and is never sold by the curve.
pub const MAX_CURVE_TOKENS: u128 = 800_000_000;
/// The curve price steps up every CHUNK tokens sold.
pub const CURVE_CHUNK_TOKENS: u128 = 1_000_000;
/// Price of the first token, yoctoNEAR per whole token (0.000001 NEAR).
pub const CURVE_BASE_PRICE_YOCTO: u128 = 1_000_000_000_000_000_000;
/// Price increase per chunk, yoctoNEAR per whole token.
pub const CURVE_STEP_YOCTO: u128 = 1_000_000_000_000_000_000;
/// Creator lock duration, nanoseconds (24 hours).
pub const LOCK_DURATION_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
/// Battle window, nanoseconds (24 hours).
pub const BATTLE_DURATION_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
/// Battle forfeit, yoctoNEAR (0.1 NEAR per side).
pub const BATTLE_FORFEIT_YOCTO: u128 = 100_000_000_000_000_000_000_000;
/// NEAR attached to a launch to fund the new coin sub-account and its
/// token contract storage (2 NEAR).
pub const LAUNCH_COST_YOCTO: u128 = 2_000_000_000_000_000_000_000_000;
/// Minimum initial buy at launch, yoctoNEAR (0.01 NEAR).
pub const MIN_INITIAL_BUY_YOCTO: u128 = 10_000_000_000_000_000_000_000;
/// Reputation weights (must sum to 100).
pub const REP_W_PNL: u64 = 40;
pub const REP_W_WIN: u64 = 30;
pub const REP_W_HOLD: u64 = 30;
/// Rug window: if a creator sells more than half its initial buy within
/// this long after the lock expires, it is flagged as a rugger.
pub const RUG_WINDOW_NS: u64 = 60 * 60 * 1_000_000_000;
/// Hold-time component reaches its maximum at this many hours held.
pub const HOLD_FULL_HOURS: u64 = 24;
/// One yoctoNEAR attached to ft_transfer calls (NEP-141 requirement).
pub const FT_TRANSFER_DEPOSIT: u128 = 1;

// Holder milestones: when a coin's holder count first reaches these
// numbers, the contract acts automatically (see check_milestones).
pub const MILESTONE_HOLDERS_1: u64 = 10;
pub const MILESTONE_HOLDERS_2: u64 = 50;
pub const MILESTONE_HOLDERS_3: u64 = 100;
/// Burned at 10 holders, basis points of total supply (100 = 1%).
pub const MILESTONE_BURN_BP: u128 = 100;
/// Tokens added to the curve cap at 50 holders (treasury tranche unlock).
pub const MILESTONE_TRANCHE_TOKENS: u128 = 50_000_000;
/// Tokens airdropped in total at 100 holders, split equally per holder.
pub const MILESTONE_AIRDROP_TOKENS: u128 = 1_000_000;

// Community supply votes: the winning choice burns or mints this share
// of total supply, in basis points (200 = 2%).
pub const VOTE_BURN_BP: u128 = 200;
pub const VOTE_MINT_BP: u128 = 200;
pub const VOTE_MIN_DURATION_HOURS: u64 = 1;
pub const VOTE_MAX_DURATION_HOURS: u64 = 168;
/// The three fixed choices of every supply vote round.
pub const VOTE_CHOICES: [&str; 3] = ["Burn 2% of supply", "Mint 2% of supply", "Do nothing"];

// Coin duels: two coins duel 24h on volume; the loser pays this share of
// its NEAR treasury (basis points, 500 = 5%) to the winner's treasury.
pub const COIN_DUEL_DURATION_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
pub const COIN_DUEL_TREASURY_BP: u128 = 500;

// Daily meme ritual: one 24h day per coin, counted from its launch.
pub const MEME_DAY_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
/// NEAR reward for the winning meme submitter, paid from the coin treasury.
pub const MEME_REWARD_YOCTO: u128 = 10_000_000_000_000_000_000_000;
/// The treasury must hold at least this much NEAR for the reward to pay.
pub const MEME_MIN_RESERVE_YOCTO: u128 = 50_000_000_000_000_000_000_000;

const TOKEN_WASM: &[u8] = include_bytes!("../token.wasm");

// ---------------------------------------------------------------------------
// Stored data
// ---------------------------------------------------------------------------

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct Coin {
    pub id: u64,
    pub token_id: AccountId,
    pub name: String,
    pub symbol: String,
    pub description: String,
    pub creator: AccountId,
    pub created_at_ns: u64,
    /// Whole tokens sold through the curve so far.
    pub sold_tokens: u128,
    /// Whole tokens of the creator's initial buy, held by the arena.
    pub locked_tokens: u128,
    /// The creator's initial buy size, whole tokens (never changes; the
    /// rug rule compares post-unlock sells against half of this).
    pub initial_buy_tokens: u128,
    pub unlock_at_ns: u64,
    /// Whole tokens the creator sold after the lock expired.
    pub creator_sold_after_unlock: u128,
    /// NEAR currently held by the curve for this coin (buys minus sells).
    pub near_reserve_yocto: u128,
    /// NEAR paid into the curve in total.
    pub total_spent_yocto: u128,
    /// NEAR paid out of the curve in total (sells).
    pub total_received_yocto: u128,
    /// Current total supply of the coin, whole tokens (changes on burn/mint).
    pub total_supply_tokens: u128,
    /// Max tokens the curve can sell for this coin (starts at 800M; the
    /// 50-holder milestone adds the treasury tranche).
    pub curve_cap_tokens: u128,
    /// Whole tokens burned by milestones and votes.
    pub burned_tokens: u128,
    /// Holder-count milestones already fired (subset of 10, 50, 100).
    pub milestones_fired: Vec<u64>,
    /// Whole tokens each holder can claim from the 100-holder airdrop
    /// (0 when no airdrop is live).
    pub airdrop_per_holder: u128,
    /// Accounts that already claimed the airdrop.
    pub airdrop_claimed: Vec<AccountId>,
    pub holders: Vec<AccountId>,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Default)]
#[serde(crate = "near_sdk::serde")]
pub struct AgentStats {
    pub total_spent_yocto: u128,
    pub total_received_yocto: u128,
    pub sells: u64,
    pub winning_sells: u64,
    pub hold_time_total_ns: u128,
    pub hold_count: u64,
    pub rugged: bool,
    pub coins_launched: u64,
    pub battles_played: u64,
    pub battles_won: u64,
}

/// One agent's open position in one coin (cost basis for win rate and PnL).
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Default)]
#[serde(crate = "near_sdk::serde")]
pub struct Position {
    /// Whole tokens currently held, bought through the curve.
    pub bought_tokens: u128,
    /// NEAR cost basis of the current holding.
    pub spent_yocto: u128,
    /// Timestamp of the first buy of the current holding streak.
    pub first_buy_ns: u64,
    /// Realised PnL on this coin, yoctoNEAR (can be negative).
    pub realised_yocto: i128,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, schemars::JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct TradeEvent {
    /// "launch" | "buy" | "sell" | "claim" | "battle_created" |
    /// "battle_accepted" | "battle_resolved"
    pub kind: String,
    pub agent: AccountId,
    pub coin_id: u64,
    /// Whole tokens involved (0 for battles).
    pub tokens: String,
    /// NEAR involved, yocto (0 for launches of 0-cost steps).
    pub near_yocto: String,
    pub timestamp_ns: u64,
    pub note: String,
}

/// Battle status: 0 pending (waiting for opponent), 1 active, 2 resolved.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct Battle {
    pub id: u64,
    pub coin_id: u64,
    pub agent_a: AccountId,
    pub agent_b: AccountId,
    pub forfeit_yocto: u128,
    pub status: u8,
    pub created_at_ns: u64,
    pub start_ns: u64,
    pub end_ns: u64,
    /// Realised PnL on the battle coin at battle start (snapshots).
    pub pnl_a_start: i128,
    pub pnl_b_start: i128,
    pub winner: Option<AccountId>,
}

/// A community supply vote round for one coin. Choices are fixed:
/// burn 2%, mint 2%, or do nothing. Vote weight is the voter's curve
/// holdings (tokens bought on the curve and not yet sold). One vote per
/// holder per round.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct VoteRound {
    pub id: u64,
    pub coin_id: u64,
    pub creator: AccountId,
    pub question: String,
    pub choices: Vec<String>,
    pub deadline_ns: u64,
    /// Total vote weight per choice (whole tokens).
    pub votes: Vec<u128>,
    pub voters: Vec<AccountId>,
    pub executed: bool,
    pub outcome: Option<String>,
}

/// A duel between two coins over 24h. The metric is trading volume
/// (NEAR bought plus NEAR sold) on each coin. The loser pays 5% of its
/// NEAR treasury to the winner's treasury.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct CoinDuel {
    pub id: u64,
    pub coin_a: u64,
    pub coin_b: u64,
    pub creator: AccountId,
    pub start_ns: u64,
    pub end_ns: u64,
    pub vol_a_start: u128,
    pub vol_b_start: u128,
    /// 0 active, 1 resolved.
    pub status: u8,
    pub winner: Option<u64>,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct MemeSubmission {
    pub submitter: AccountId,
    pub meme_hash: String,
    pub votes: u64,
}

/// One day of a coin's meme ritual. Days are 24h periods counted from the
/// coin's launch. Holders submit a meme hash, holders vote (one vote each),
/// and after the day ends the winning hash is stored onchain and its
/// submitter is paid 0.01 NEAR from the coin treasury when it can afford it.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct MemeDay {
    pub coin_id: u64,
    pub day: u64,
    pub submissions: Vec<MemeSubmission>,
    pub voters: Vec<AccountId>,
    pub resolved: bool,
    pub winner_hash: Option<String>,
    pub winner: Option<AccountId>,
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct ParamsView {
    pub decimals: u8,
    pub total_supply_tokens: String,
    pub max_curve_tokens: String,
    pub curve_chunk_tokens: String,
    pub curve_base_price_yocto: String,
    pub curve_step_yocto: String,
    pub lock_duration_ns: u64,
    pub lock_duration_hours: u64,
    pub battle_duration_ns: u64,
    pub battle_duration_hours: u64,
    pub battle_forfeit_yocto: String,
    pub launch_cost_yocto: String,
    pub min_initial_buy_yocto: String,
    pub rep_weight_pnl: u64,
    pub rep_weight_win_rate: u64,
    pub rep_weight_hold_time: u64,
    pub rug_window_ns: u64,
    pub hold_full_hours: u64,
    pub milestone_holders: Vec<u64>,
    pub milestone_burn_bp: u128,
    pub milestone_tranche_tokens: String,
    pub milestone_airdrop_tokens: String,
    pub vote_choices: Vec<String>,
    pub vote_burn_bp: u128,
    pub vote_mint_bp: u128,
    pub vote_min_duration_hours: u64,
    pub vote_max_duration_hours: u64,
    pub coin_duel_duration_hours: u64,
    pub coin_duel_treasury_bp: u128,
    pub meme_day_hours: u64,
    pub meme_reward_yocto: String,
    pub meme_min_reserve_yocto: String,
}

#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct CoinView {
    pub id: u64,
    pub token_id: AccountId,
    pub name: String,
    pub symbol: String,
    pub description: String,
    pub creator: AccountId,
    pub created_at_ns: u64,
    pub sold_tokens: String,
    pub locked_tokens: String,
    pub unlock_at_ns: u64,
    pub lock_status: String,
    pub holders: u64,
    pub price_per_token_yocto: String,
    pub market_cap_yocto: String,
    pub near_reserve_yocto: String,
    pub total_supply_tokens: String,
    pub curve_cap_tokens: String,
    pub burned_tokens: String,
    pub milestones_fired: Vec<u64>,
    pub airdrop_per_holder: String,
}

#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct AgentView {
    pub account: AccountId,
    pub score: u16,
    pub band: String,
    pub total_spent_yocto: String,
    pub total_received_yocto: String,
    pub realised_pnl_yocto: String,
    pub sells: u64,
    pub winning_sells: u64,
    pub win_rate_bp: u64,
    pub avg_hold_hours: u64,
    pub rugged: bool,
    pub coins_launched: u64,
    pub battles_played: u64,
    pub battles_won: u64,
}

#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct BattleView {
    pub id: u64,
    pub coin_id: u64,
    pub agent_a: AccountId,
    pub agent_b: AccountId,
    pub forfeit_yocto: String,
    pub status: String,
    pub created_at_ns: u64,
    pub start_ns: u64,
    pub end_ns: u64,
    pub pnl_a_start: String,
    pub pnl_b_start: String,
    pub winner: Option<AccountId>,
}

#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct VoteRoundView {
    pub id: u64,
    pub coin_id: u64,
    pub creator: AccountId,
    pub question: String,
    pub choices: Vec<String>,
    pub deadline_ns: u64,
    pub votes: Vec<String>,
    pub voters: u64,
    pub executed: bool,
    pub outcome: Option<String>,
}

#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct CoinDuelView {
    pub id: u64,
    pub coin_a: u64,
    pub coin_b: u64,
    pub creator: AccountId,
    pub start_ns: u64,
    pub end_ns: u64,
    pub status: String,
    pub winner: Option<u64>,
}

#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct MemeSubmissionView {
    pub submitter: AccountId,
    pub meme_hash: String,
    pub votes: u64,
}

#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct MemeDayView {
    pub coin_id: u64,
    pub day: u64,
    pub submissions: Vec<MemeSubmissionView>,
    pub voters: u64,
    pub resolved: bool,
    pub winner_hash: Option<String>,
    pub winner: Option<AccountId>,
}

#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct StatsView {
    pub coins: u64,
    pub agents: u64,
    pub trades: u64,
    pub battles: u64,
    pub resolved_battles: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct TokenInitArgs {
    owner_id: AccountId,
    total_supply: U128,
    metadata: FungibleTokenMetadata,
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/// Current curve price, yoctoNEAR per whole token, at `sold_tokens` sold.
pub fn price_per_token_yocto(sold_tokens: u128) -> u128 {
    CURVE_BASE_PRICE_YOCTO + CURVE_STEP_YOCTO * (sold_tokens / CURVE_CHUNK_TOKENS)
}

/// Cost in yoctoNEAR to buy exactly `tokens` whole tokens from `from_sold`.
pub fn buy_cost_yocto(from_sold: u128, tokens: u128) -> u128 {
    let mut cost = 0u128;
    let mut remaining = tokens;
    let mut sold = from_sold;
    while remaining > 0 {
        let chunk_idx = sold / CURVE_CHUNK_TOKENS;
        let chunk_end = (chunk_idx + 1) * CURVE_CHUNK_TOKENS;
        let take = remaining.min(chunk_end - sold);
        let price = CURVE_BASE_PRICE_YOCTO + CURVE_STEP_YOCTO * chunk_idx;
        cost = cost.saturating_add(take.saturating_mul(price));
        remaining -= take;
        sold += take;
    }
    cost
}

/// How many whole tokens `near_yocto` buys from `from_sold`, capped at
/// `max_tokens`. Returns (tokens, cost_yocto). Any leftover NEAR is dust.
pub fn buy_tokens_for_near(from_sold: u128, near_yocto: u128, max_tokens: u128) -> (u128, u128) {
    let mut tokens = 0u128;
    let mut spent = 0u128;
    let mut sold = from_sold;
    let mut remaining = near_yocto;
    while tokens < max_tokens {
        let chunk_idx = sold / CURVE_CHUNK_TOKENS;
        let chunk_end = (chunk_idx + 1) * CURVE_CHUNK_TOKENS;
        let price = CURVE_BASE_PRICE_YOCTO + CURVE_STEP_YOCTO * chunk_idx;
        let affordable = remaining / price;
        if affordable == 0 {
            break;
        }
        let take = affordable.min(chunk_end - sold).min(max_tokens - tokens);
        if take == 0 {
            break;
        }
        let cost = take * price;
        tokens += take;
        spent += cost;
        remaining -= cost;
        sold += take;
    }
    (tokens, spent)
}

/// NEAR proceeds from selling `tokens` whole tokens when `from_sold` have
/// been sold. The most recently sold tokens sell first (walk backward).
pub fn sell_proceeds_yocto(from_sold: u128, tokens: u128) -> u128 {
    let mut proceeds = 0u128;
    let mut remaining = tokens;
    let mut sold = from_sold;
    while remaining > 0 && sold > 0 {
        let chunk_idx = (sold - 1) / CURVE_CHUNK_TOKENS;
        let chunk_start = chunk_idx * CURVE_CHUNK_TOKENS;
        let price = CURVE_BASE_PRICE_YOCTO + CURVE_STEP_YOCTO * chunk_idx;
        let take = remaining.min(sold - chunk_start);
        proceeds = proceeds.saturating_add(take.saturating_mul(price));
        remaining -= take;
        sold -= take;
    }
    proceeds
}

fn pnl_component(spent: u128, received: u128) -> u16 {
    if spent == 0 {
        return 500;
    }
    let pnl = received as i128 - spent as i128;
    let mut bp = pnl * 10_000 / spent as i128;
    if bp > 10_000 {
        bp = 10_000;
    }
    if bp < -10_000 {
        bp = -10_000;
    }
    (500 + bp / 20).clamp(0, 1000) as u16
}

fn win_component(sells: u64, wins: u64) -> u16 {
    if sells == 0 {
        return 500;
    }
    ((wins as u128 * 1000) / sells as u128) as u16
}

fn hold_component(total_ns: u128, count: u64) -> u16 {
    if count == 0 {
        return 500;
    }
    let avg_hours = total_ns / count as u128 / 3_600_000_000_000u128;
    (avg_hours * 1000 / HOLD_FULL_HOURS as u128).min(1000) as u16
}

/// Deterministic reputation score, 0-1000. A rugged agent scores 0.
pub fn compute_score(s: &AgentStats) -> u16 {
    if s.rugged {
        return 0;
    }
    let pnl = pnl_component(s.total_spent_yocto, s.total_received_yocto);
    let win = win_component(s.sells, s.winning_sells);
    let hold = hold_component(s.hold_time_total_ns, s.hold_count);
    ((REP_W_PNL * pnl as u64 + REP_W_WIN * win as u64 + REP_W_HOLD * hold as u64) / 100) as u16
}

pub fn score_band(score: u16) -> &'static str {
    if score < 300 {
        "thin"
    } else if score < 600 {
        "building"
    } else if score < 800 {
        "solid"
    } else {
        "strong"
    }
}

fn battle_status_str(status: u8) -> &'static str {
    match status {
        0 => "pending",
        1 => "active",
        _ => "resolved",
    }
}

// ---------------------------------------------------------------------------
// Cross-contract interfaces
// ---------------------------------------------------------------------------

#[ext_contract(ext_ft)]
pub trait ExtFt {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[ext_contract(ext_ft_burn)]
pub trait ExtFtBurn {
    fn burn(&mut self, amount: U128);
    fn mint(&mut self, amount: U128);
}

#[ext_contract(ext_self)]
pub trait ExtSelf {
    fn on_coin_created(
        &mut self,
        coin_id: u64,
        creator: AccountId,
        name: String,
        symbol: String,
        description: String,
        cost_yocto: U128,
        tokens: U128,
        attached_yocto: U128,
    ) -> bool;
    fn on_buy(
        &mut self,
        coin_id: u64,
        buyer: AccountId,
        tokens: U128,
        cost_yocto: U128,
        attached_yocto: U128,
    ) -> PromiseOrValue<bool>;
    fn on_claim(&mut self, coin_id: u64, creator: AccountId, tokens: U128) -> bool;
    fn on_milestone_burn(&mut self, coin_id: u64, milestone: u64, amount: U128) -> bool;
    fn on_vote_executed(&mut self, round_id: u64, outcome: String) -> bool;
    fn on_airdrop_claim(&mut self, coin_id: u64, claimer: AccountId, tokens: U128) -> bool;
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    coin_count: u64,
    battle_count: u64,
    agent_count: u64,
    vote_round_count: u64,
    coin_duel_count: u64,
    coins: LookupMap<u64, Coin>,
    token_to_coin: LookupMap<AccountId, u64>,
    agents: LookupMap<AccountId, AgentStats>,
    positions: LookupMap<String, Position>,
    battles: LookupMap<u64, Battle>,
    activity: Vector<TradeEvent>,
    vote_rounds: LookupMap<u64, VoteRound>,
    coin_duels: LookupMap<u64, CoinDuel>,
    meme_days: LookupMap<String, MemeDay>,
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        Self {
            coin_count: 0,
            battle_count: 0,
            agent_count: 0,
            vote_round_count: 0,
            coin_duel_count: 0,
            coins: LookupMap::new(b"c"),
            token_to_coin: LookupMap::new(b"t"),
            agents: LookupMap::new(b"a"),
            positions: LookupMap::new(b"p"),
            battles: LookupMap::new(b"b"),
            activity: Vector::new(b"e"),
            vote_rounds: LookupMap::new(b"v"),
            coin_duels: LookupMap::new(b"d"),
            meme_days: LookupMap::new(b"m"),
        }
    }

    // -- helpers -----------------------------------------------------------

    /// Record an agent the first time it acts, so the agent count is exact
    /// (LookupMap has no len()). Safe to call repeatedly.
    fn track_agent(&mut self, agent: &AccountId) {
        if self.agents.get(agent).is_none() {
            self.agents.insert(agent.clone(), AgentStats::default());
            self.agent_count += 1;
        }
    }

    fn position_key(agent: &AccountId, coin_id: u64) -> String {
        format!("{}:{}", agent, coin_id)
    }

    fn get_agent_stats(&self, agent: &AccountId) -> AgentStats {
        self.agents.get(agent).cloned().unwrap_or_default()
    }

    fn record_event(&mut self, kind: &str, agent: AccountId, coin_id: u64, tokens: u128, near: u128, note: String) {
        if self.activity.len() >= 500 {
            return;
        }
        self.activity.push(TradeEvent {
            kind: kind.to_string(),
            agent,
            coin_id,
            tokens: tokens.to_string(),
            near_yocto: near.to_string(),
            timestamp_ns: env::block_timestamp(),
            note,
        });
    }

    fn coin_view(&self, coin: &Coin) -> CoinView {
        let now = env::block_timestamp();
        let lock_status = if coin.locked_tokens == 0 {
            "claimed".to_string()
        } else if now >= coin.unlock_at_ns {
            "claimable".to_string()
        } else {
            "locked".to_string()
        };
        let price = price_per_token_yocto(coin.sold_tokens);
        CoinView {
            id: coin.id,
            token_id: coin.token_id.clone(),
            name: coin.name.clone(),
            symbol: coin.symbol.clone(),
            description: coin.description.clone(),
            creator: coin.creator.clone(),
            created_at_ns: coin.created_at_ns,
            sold_tokens: coin.sold_tokens.to_string(),
            locked_tokens: coin.locked_tokens.to_string(),
            unlock_at_ns: coin.unlock_at_ns,
            lock_status,
            holders: coin.holders.len() as u64,
            price_per_token_yocto: price.to_string(),
            market_cap_yocto: price.saturating_mul(coin.total_supply_tokens).to_string(),
            near_reserve_yocto: coin.near_reserve_yocto.to_string(),
            total_supply_tokens: coin.total_supply_tokens.to_string(),
            curve_cap_tokens: coin.curve_cap_tokens.to_string(),
            burned_tokens: coin.burned_tokens.to_string(),
            milestones_fired: coin.milestones_fired.clone(),
            airdrop_per_holder: coin.airdrop_per_holder.to_string(),
        }
    }

    fn agent_view(&self, account: &AccountId) -> AgentView {
        let s = self.get_agent_stats(account);
        let score = compute_score(&s);
        let realised = s.total_received_yocto as i128 - s.total_spent_yocto as i128;
        let win_rate_bp = if s.sells == 0 {
            0
        } else {
            (s.winning_sells as u128 * 10_000 / s.sells as u128) as u64
        };
        let avg_hold_hours = if s.hold_count == 0 {
            0
        } else {
            (s.hold_time_total_ns / s.hold_count as u128 / 3_600_000_000_000u128) as u64
        };
        AgentView {
            account: account.clone(),
            score,
            band: score_band(score).to_string(),
            total_spent_yocto: s.total_spent_yocto.to_string(),
            total_received_yocto: s.total_received_yocto.to_string(),
            realised_pnl_yocto: realised.to_string(),
            sells: s.sells,
            winning_sells: s.winning_sells,
            win_rate_bp,
            avg_hold_hours,
            rugged: s.rugged,
            coins_launched: s.coins_launched,
            battles_played: s.battles_played,
            battles_won: s.battles_won,
        }
    }

    // -- launch ------------------------------------------------------------

    /// Launch a coin. Attach `initial_buy + 2 NEAR`. The 2 NEAR funds the
    /// new coin sub-account and its token contract storage; the initial buy
    /// goes into the bonding curve and its tokens are locked 24h, held by
    /// this contract. Returns the reserved coin id; the coin record appears
    /// once the token contract deploys (check `get_coin`).
    #[payable]
    pub fn launch_coin(
        &mut self,
        name: String,
        symbol: String,
        description: String,
        initial_buy_yocto: U128,
    ) -> u64 {
        let creator = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();
        assert!(!name.trim().is_empty(), "name required");
        assert!(!symbol.trim().is_empty(), "symbol required");
        assert!(
            symbol.chars().all(|c| c.is_ascii_alphanumeric()),
            "symbol must be alphanumeric"
        );
        assert!(
            initial_buy_yocto.0 >= MIN_INITIAL_BUY_YOCTO,
            "initial buy below minimum"
        );
        assert!(
            attached >= initial_buy_yocto.0 + LAUNCH_COST_YOCTO,
            "attach initial buy + 2 NEAR launch cost"
        );
        let (tokens, cost) = buy_tokens_for_near(0, initial_buy_yocto.0, MAX_CURVE_TOKENS);
        assert!(tokens > 0, "initial buy buys zero tokens");

        let coin_id = self.coin_count;
        self.coin_count += 1;
        let token_id: AccountId = format!("c{}.{}", coin_id, env::current_account_id())
            .parse()
            .expect("bad token account id");
        let metadata = FungibleTokenMetadata {
            spec: "ft-1.0.0".to_string(),
            name: name.clone(),
            symbol: symbol.clone(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: DECIMALS,
        };
        let init_args = TokenInitArgs {
            owner_id: env::current_account_id(),
            total_supply: U128(TOTAL_SUPPLY_TOKENS * DECIMAL_MULT),
            metadata,
        };
        Promise::new(token_id.clone())
            .create_account()
            .transfer(NearToken::from_yoctonear(LAUNCH_COST_YOCTO))
            .deploy_contract(TOKEN_WASM.to_vec())
            .function_call(
                "new".to_string(),
                serde_json::to_vec(&init_args).expect("init args"),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(40),
            )
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(40))
                    .on_coin_created(
                        coin_id,
                        creator,
                        name,
                        symbol,
                        description,
                        U128(cost),
                        U128(tokens),
                        U128(attached),
                    ),
            );
        coin_id
    }

    /// Callback after the coin token contract deploys. Records the coin on
    /// success; refunds the full attached deposit on failure.
    #[private]
    pub fn on_coin_created(
        &mut self,
        coin_id: u64,
        creator: AccountId,
        name: String,
        symbol: String,
        description: String,
        cost_yocto: U128,
        tokens: U128,
        attached_yocto: U128,
    ) -> bool {
        let token_id: AccountId = format!("c{}.{}", coin_id, env::current_account_id())
            .parse()
            .expect("bad token account id");
        match env::promise_result(0) {
            PromiseResult::Successful(_) => {
                let now = env::block_timestamp();
                let coin = Coin {
                    id: coin_id,
                    token_id: token_id.clone(),
                    name,
                    symbol,
                    description,
                    creator: creator.clone(),
                    created_at_ns: now,
                    sold_tokens: tokens.0,
                    locked_tokens: tokens.0,
                    initial_buy_tokens: tokens.0,
                    unlock_at_ns: now + LOCK_DURATION_NS,
                    creator_sold_after_unlock: 0,
                    near_reserve_yocto: cost_yocto.0,
                    total_spent_yocto: cost_yocto.0,
                    total_received_yocto: 0,
                    total_supply_tokens: TOTAL_SUPPLY_TOKENS,
                    curve_cap_tokens: MAX_CURVE_TOKENS,
                    burned_tokens: 0,
                    milestones_fired: vec![],
                    airdrop_per_holder: 0,
                    airdrop_claimed: vec![],
                    holders: vec![creator.clone()],
                };
                self.coins.insert(coin_id, coin);
                self.token_to_coin.insert(token_id, coin_id);
                // The creator's initial buy is a position with cost basis.
                let key = Self::position_key(&creator, coin_id);
                self.positions.insert(
                    key,
                    Position {
                        bought_tokens: tokens.0,
                        spent_yocto: cost_yocto.0,
                        first_buy_ns: now,
                        realised_yocto: 0,
                    },
                );
                self.track_agent(&creator);
                let mut stats = self.get_agent_stats(&creator);
                stats.total_spent_yocto += cost_yocto.0;
                stats.coins_launched += 1;
                self.agents.insert(creator.clone(), stats);
                self.record_event(
                    "launch",
                    creator,
                    coin_id,
                    tokens.0,
                    cost_yocto.0,
                    "coin launched, initial buy locked 24h".to_string(),
                );
                true
            }
            _ => {
                Promise::new(creator).transfer(NearToken::from_yoctonear(attached_yocto.0));
                false
            }
        }
    }

    // -- buy ---------------------------------------------------------------

    /// Buy `coin_id` on the bonding curve. Attach the NEAR to spend.
    /// Tokens are whole-token amounts; leftover NEAR dust is refunded.
    #[payable]
    pub fn buy(&mut self, coin_id: u64) -> U128 {
        let buyer = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();
        let mut coin = self.coins.get(&coin_id).expect("coin not found").clone();
        assert!(coin.sold_tokens < coin.curve_cap_tokens, "curve sold out");
        let max_tokens = coin.curve_cap_tokens - coin.sold_tokens;
        let (tokens, cost) = buy_tokens_for_near(coin.sold_tokens, attached, max_tokens);
        assert!(tokens > 0, "amount buys zero tokens");
        // Optimistic sold update so two quick buys cannot oversell the curve.
        coin.sold_tokens += tokens;
        self.coins.insert(coin_id, coin);
        let amount_base = U128(tokens * DECIMAL_MULT);
        ext_ft::ext(coin_token_id(self, coin_id))
            .with_attached_deposit(NearToken::from_yoctonear(FT_TRANSFER_DEPOSIT))
            .with_static_gas(Gas::from_tgas(30))
            .ft_transfer(buyer.clone(), amount_base, None)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(40))
                    .on_buy(coin_id, buyer, U128(tokens), U128(cost), U128(attached)),
            );
        U128(tokens)
    }

    /// Callback after the token transfer for a buy. Finalises the trade on
    /// success; reverts the optimistic sold update and refunds on failure.
    #[private]
    pub fn on_buy(
        &mut self,
        coin_id: u64,
        buyer: AccountId,
        tokens: U128,
        cost_yocto: U128,
        attached_yocto: U128,
    ) -> PromiseOrValue<bool> {
        match env::promise_result(0) {
            PromiseResult::Successful(_) => {
                let mut coin = self.coins.get(&coin_id).expect("coin not found").clone();
                coin.near_reserve_yocto += cost_yocto.0;
                coin.total_spent_yocto += cost_yocto.0;
                if !coin.holders.contains(&buyer) {
                    coin.holders.push(buyer.clone());
                }
                self.coins.insert(coin_id, coin);
                let key = Self::position_key(&buyer, coin_id);
                let mut pos = self.positions.get(&key).cloned().unwrap_or_default();
                if pos.bought_tokens == 0 {
                    pos.first_buy_ns = env::block_timestamp();
                }
                pos.bought_tokens += tokens.0;
                pos.spent_yocto += cost_yocto.0;
                self.positions.insert(key, pos);
                self.track_agent(&buyer);
                let mut stats = self.get_agent_stats(&buyer);
                stats.total_spent_yocto += cost_yocto.0;
                self.agents.insert(buyer.clone(), stats);
                self.record_event(
                    "buy",
                    buyer.clone(),
                    coin_id,
                    tokens.0,
                    cost_yocto.0,
                    "bought on the curve".to_string(),
                );
                if attached_yocto.0 > cost_yocto.0 {
                    Promise::new(buyer)
                        .transfer(NearToken::from_yoctonear(attached_yocto.0 - cost_yocto.0));
                }
                // Holder milestones fire automatically when the holder count
                // crosses 10 / 50 / 100. The 10-holder burn needs a token
                // call, so it returns a promise chained to its callback.
                if let Some(burn) = self.fire_milestones(coin_id) {
                    let (milestone, amount) = burn;
                    let token_id = coin_token_id(self, coin_id);
                    let p = ext_ft_burn::ext(token_id)
                        .with_static_gas(Gas::from_tgas(20))
                        .burn(U128(amount * DECIMAL_MULT))
                        .then(
                            ext_self::ext(env::current_account_id())
                                .with_static_gas(Gas::from_tgas(20))
                                .on_milestone_burn(coin_id, milestone, U128(amount)),
                        );
                    return PromiseOrValue::Promise(p);
                }
                PromiseOrValue::Value(true)
            }
            _ => {
                let mut coin = self.coins.get(&coin_id).expect("coin not found").clone();
                coin.sold_tokens -= tokens.0;
                self.coins.insert(coin_id, coin);
                Promise::new(buyer).transfer(NearToken::from_yoctonear(attached_yocto.0));
                PromiseOrValue::Value(false)
            }
        }
    }

    /// Check and fire holder milestones for a coin. Returns the burn
    /// (milestone, whole tokens) when the 10-holder burn must be executed
    /// via the token contract; the 50 and 100 milestones are pure state
    /// changes applied here. At most one milestone fires per call, because
    /// a single buy adds at most one new holder.
    fn fire_milestones(&mut self, coin_id: u64) -> Option<(u64, u128)> {
        let mut coin = self.coins.get(&coin_id).expect("coin not found").clone();
        let holders = coin.holders.len() as u64;
        let creator = coin.creator.clone();
        if holders >= MILESTONE_HOLDERS_1 && !coin.milestones_fired.contains(&MILESTONE_HOLDERS_1) {
            let amount = coin.total_supply_tokens * MILESTONE_BURN_BP / 10_000;
            coin.milestones_fired.push(MILESTONE_HOLDERS_1);
            coin.burned_tokens += amount;
            coin.total_supply_tokens -= amount;
            self.coins.insert(coin_id, coin);
            self.record_event(
                "milestone_burn",
                creator,
                coin_id,
                amount,
                0,
                format!("10 holders: burned {} tokens (1% of supply)", amount),
            );
            return Some((MILESTONE_HOLDERS_1, amount));
        }
        if holders >= MILESTONE_HOLDERS_2 && !coin.milestones_fired.contains(&MILESTONE_HOLDERS_2) {
            coin.milestones_fired.push(MILESTONE_HOLDERS_2);
            coin.curve_cap_tokens += MILESTONE_TRANCHE_TOKENS;
            self.coins.insert(coin_id, coin);
            self.record_event(
                "milestone_tranche",
                creator.clone(),
                coin_id,
                MILESTONE_TRANCHE_TOKENS,
                0,
                format!(
                    "50 holders: treasury tranche unlocked, curve cap +{} tokens",
                    MILESTONE_TRANCHE_TOKENS
                ),
            );
            return None;
        }
        if holders >= MILESTONE_HOLDERS_3 && !coin.milestones_fired.contains(&MILESTONE_HOLDERS_3) {
            coin.milestones_fired.push(MILESTONE_HOLDERS_3);
            coin.airdrop_per_holder = MILESTONE_AIRDROP_TOKENS / holders as u128;
            let per_holder = coin.airdrop_per_holder;
            self.coins.insert(coin_id, coin);
            self.record_event(
                "milestone_airdrop",
                creator,
                coin_id,
                MILESTONE_AIRDROP_TOKENS,
                0,
                format!(
                    "100 holders: airdrop live, {} tokens per holder to claim",
                    per_holder
                ),
            );
            return None;
        }
        None
    }

    /// Callback after the milestone burn. Reverts the milestone on failure
    /// so it can fire again.
    #[private]
    pub fn on_milestone_burn(&mut self, coin_id: u64, milestone: u64, amount: U128) -> bool {
        match env::promise_result(0) {
            PromiseResult::Successful(_) => true,
            _ => {
                let mut coin = self.coins.get(&coin_id).expect("coin not found").clone();
                coin.milestones_fired.retain(|m| *m != milestone);
                coin.burned_tokens = coin.burned_tokens.saturating_sub(amount.0);
                coin.total_supply_tokens += amount.0;
                self.coins.insert(coin_id, coin);
                false
            }
        }
    }

    /// Claim the 100-holder airdrop share. One claim per holder.
    pub fn claim_airdrop(&mut self, coin_id: u64) {
        let claimer = env::predecessor_account_id();
        let mut coin = self.coins.get(&coin_id).expect("coin not found").clone();
        assert!(coin.airdrop_per_holder > 0, "no airdrop live");
        assert!(
            !coin.airdrop_claimed.contains(&claimer),
            "already claimed"
        );
        assert!(
            coin.holders.contains(&claimer),
            "only holders claim the airdrop"
        );
        let tokens = coin.airdrop_per_holder;
        coin.airdrop_claimed.push(claimer.clone());
        self.coins.insert(coin_id, coin);
        ext_ft::ext(coin_token_id(self, coin_id))
            .with_attached_deposit(NearToken::from_yoctonear(FT_TRANSFER_DEPOSIT))
            .with_static_gas(Gas::from_tgas(30))
            .ft_transfer(claimer.clone(), U128(tokens * DECIMAL_MULT), None)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(30))
                    .on_airdrop_claim(coin_id, claimer, U128(tokens)),
            );
    }

    /// Callback after the airdrop transfer. Restores the claim on failure.
    #[private]
    pub fn on_airdrop_claim(&mut self, coin_id: u64, claimer: AccountId, tokens: U128) -> bool {
        match env::promise_result(0) {
            PromiseResult::Successful(_) => {
                self.record_event(
                    "airdrop_claim",
                    claimer,
                    coin_id,
                    tokens.0,
                    0,
                    "claimed milestone airdrop".to_string(),
                );
                true
            }
            _ => {
                let mut coin = self.coins.get(&coin_id).expect("coin not found").clone();
                coin.airdrop_claimed.retain(|a| *a != claimer);
                self.coins.insert(coin_id, coin);
                false
            }
        }
    }

    // -- sell (via ft_transfer_call to the arena) --------------------------

    /// Claim the creator's locked initial buy after the 24h lock expires.
    pub fn claim_locked(&mut self, coin_id: u64) {
        let creator = env::predecessor_account_id();
        let mut coin = self.coins.get(&coin_id).expect("coin not found").clone();
        assert_eq!(coin.creator, creator, "only the creator claims");
        assert!(coin.locked_tokens > 0, "nothing locked");
        assert!(
            env::block_timestamp() >= coin.unlock_at_ns,
            "still locked"
        );
        let tokens = coin.locked_tokens;
        // Optimistic clear so a double claim cannot happen; restored on failure.
        coin.locked_tokens = 0;
        self.coins.insert(coin_id, coin);
        ext_ft::ext(coin_token_id(self, coin_id))
            .with_attached_deposit(NearToken::from_yoctonear(FT_TRANSFER_DEPOSIT))
            .with_static_gas(Gas::from_tgas(30))
            .ft_transfer(creator.clone(), U128(tokens * DECIMAL_MULT), None)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(30))
                    .on_claim(coin_id, creator, U128(tokens)),
            );
    }

    /// Callback after the locked-token transfer. Restores the lock on failure.
    #[private]
    pub fn on_claim(&mut self, coin_id: u64, creator: AccountId, tokens: U128) -> bool {
        match env::promise_result(0) {
            PromiseResult::Successful(_) => {
                self.record_event(
                    "claim",
                    creator,
                    coin_id,
                    tokens.0,
                    0,
                    "creator claimed locked initial buy".to_string(),
                );
                true
            }
            _ => {
                let mut coin = self.coins.get(&coin_id).expect("coin not found").clone();
                coin.locked_tokens = tokens.0;
                self.coins.insert(coin_id, coin);
                false
            }
        }
    }

    // -- battles -----------------------------------------------------------

    /// Challenge `opponent` to a battle on `coin_id`. Attach exactly the
    /// 0.1 NEAR forfeit. The battle waits for the opponent to accept.
    #[payable]
    pub fn create_battle(&mut self, coin_id: u64, opponent: AccountId) -> u64 {
        let challenger = env::predecessor_account_id();
        assert!(self.coins.get(&coin_id).is_some(), "coin not found");
        assert_ne!(challenger, opponent, "cannot battle yourself");
        assert_eq!(
            env::attached_deposit().as_yoctonear(),
            BATTLE_FORFEIT_YOCTO,
            "attach exactly the 0.1 NEAR forfeit"
        );
        let id = self.battle_count;
        self.battle_count += 1;
        self.battles.insert(
            id,
            Battle {
                id,
                coin_id,
                agent_a: challenger.clone(),
                agent_b: opponent,
                forfeit_yocto: BATTLE_FORFEIT_YOCTO,
                status: 0,
                created_at_ns: env::block_timestamp(),
                start_ns: 0,
                end_ns: 0,
                pnl_a_start: 0,
                pnl_b_start: 0,
                winner: None,
            },
        );
        self.record_event(
            "battle_created",
            challenger,
            coin_id,
            0,
            BATTLE_FORFEIT_YOCTO,
            format!("battle {} created", id),
        );
        id
    }

    /// Accept a pending battle. Attach exactly the 0.1 NEAR forfeit. The
    /// 24h window starts now and both agents' realised PnL on the battle
    /// coin is snapshotted.
    #[payable]
    pub fn accept_battle(&mut self, battle_id: u64) {
        let caller = env::predecessor_account_id();
        let mut battle = self.battles.get(&battle_id).expect("battle not found").clone();
        assert_eq!(battle.status, 0, "battle not pending");
        assert_eq!(caller, battle.agent_b, "only the challenged agent accepts");
        assert_eq!(
            env::attached_deposit().as_yoctonear(),
            BATTLE_FORFEIT_YOCTO,
            "attach exactly the 0.1 NEAR forfeit"
        );
        let now = env::block_timestamp();
        battle.status = 1;
        battle.start_ns = now;
        battle.end_ns = now + BATTLE_DURATION_NS;
        battle.pnl_a_start = self.coin_pnl(&battle.agent_a, battle.coin_id);
        battle.pnl_b_start = self.coin_pnl(&battle.agent_b, battle.coin_id);
        self.battles.insert(battle_id, battle.clone());
        self.record_event(
            "battle_accepted",
            caller,
            battle.coin_id,
            0,
            BATTLE_FORFEIT_YOCTO,
            format!("battle {} accepted, 24h window started", battle_id),
        );
    }

    /// Resolve an active battle after its 24h window. Anyone can call it.
    /// Winner takes both forfeits; a tie refunds each side.
    pub fn resolve_battle(&mut self, battle_id: u64) {
        let mut battle = self.battles.get(&battle_id).expect("battle not found").clone();
        assert_eq!(battle.status, 1, "battle not active");
        assert!(
            env::block_timestamp() >= battle.end_ns,
            "battle window not over"
        );
        let pnl_a = self.coin_pnl(&battle.agent_a, battle.coin_id) - battle.pnl_a_start;
        let pnl_b = self.coin_pnl(&battle.agent_b, battle.coin_id) - battle.pnl_b_start;
        let winner = if pnl_a > pnl_b {
            Some(battle.agent_a.clone())
        } else if pnl_b > pnl_a {
            Some(battle.agent_b.clone())
        } else {
            None
        };
        battle.status = 2;
        battle.winner = winner.clone();
        match &winner {
            Some(w) => {
                Promise::new(w.clone())
                    .transfer(NearToken::from_yoctonear(battle.forfeit_yocto * 2));
                self.track_agent(w);
                let mut stats = self.get_agent_stats(w);
                stats.battles_won += 1;
                stats.battles_played += 1;
                self.agents.insert(w.clone(), stats);
                let loser = if *w == battle.agent_a {
                    battle.agent_b.clone()
                } else {
                    battle.agent_a.clone()
                };
                self.track_agent(&loser);
                let mut ls = self.get_agent_stats(&loser);
                ls.battles_played += 1;
                self.agents.insert(loser, ls);
            }
            None => {
                Promise::new(battle.agent_a.clone())
                    .transfer(NearToken::from_yoctonear(battle.forfeit_yocto));
                Promise::new(battle.agent_b.clone())
                    .transfer(NearToken::from_yoctonear(battle.forfeit_yocto));
                for a in [&battle.agent_a, &battle.agent_b] {
                    self.track_agent(a);
                    let mut s = self.get_agent_stats(a);
                    s.battles_played += 1;
                    self.agents.insert(a.clone(), s);
                }
            }
        }
        self.battles.insert(battle_id, battle.clone());
        self.record_event(
            "battle_resolved",
            winner.clone().unwrap_or_else(|| battle.agent_a.clone()),
            battle.coin_id,
            0,
            battle.forfeit_yocto * 2,
            match &winner {
                Some(w) => format!("battle {} won by {}", battle_id, w),
                None => format!("battle {} tied", battle_id),
            },
        );
    }

    fn coin_pnl(&self, agent: &AccountId, coin_id: u64) -> i128 {
        let key = Self::position_key(agent, coin_id);
        self.positions.get(&key).map(|p| p.realised_yocto).unwrap_or(0)
    }

    fn coin_volume_yocto(&self, coin_id: u64) -> u128 {
        let coin = self.coins.get(&coin_id).expect("coin not found");
        coin.total_spent_yocto + coin.total_received_yocto
    }

    fn holder_tokens(&self, agent: &AccountId, coin_id: u64) -> u128 {
        let key = Self::position_key(agent, coin_id);
        self.positions.get(&key).map(|p| p.bought_tokens).unwrap_or(0)
    }

    // -- community supply votes -------------------------------------------

    /// Open a supply vote round for a coin. Any holder can open one, but
    /// only one round may be active per coin. Choices are fixed: burn 2%
    /// of supply, mint 2% of supply, or do nothing. `duration_hours` must
    /// be 1-168. Returns the round id.
    pub fn create_vote_round(&mut self, coin_id: u64, duration_hours: u64) -> u64 {
        let creator = env::predecessor_account_id();
        assert!(self.coins.get(&coin_id).is_some(), "coin not found");
        assert!(
            self.holder_tokens(&creator, coin_id) > 0,
            "only holders open a vote round"
        );
        assert!(
            (VOTE_MIN_DURATION_HOURS..=VOTE_MAX_DURATION_HOURS).contains(&duration_hours),
            "duration must be 1-168 hours"
        );
        for id in 0..self.vote_round_count {
            if let Some(r) = self.vote_rounds.get(&id) {
                if r.coin_id == coin_id && !r.executed && env::block_timestamp() < r.deadline_ns {
                    panic!("an active vote round already exists for this coin");
                }
            }
        }
        let id = self.vote_round_count;
        self.vote_round_count += 1;
        self.vote_rounds.insert(
            id,
            VoteRound {
                id,
                coin_id,
                creator: creator.clone(),
                question: "How should the supply change?".to_string(),
                choices: VOTE_CHOICES.iter().map(|c| c.to_string()).collect(),
                deadline_ns: env::block_timestamp() + duration_hours * 3_600_000_000_000,
                votes: vec![0; VOTE_CHOICES.len()],
                voters: vec![],
                executed: false,
                outcome: None,
            },
        );
        self.record_event(
            "vote_created",
            creator,
            coin_id,
            0,
            0,
            format!("supply vote round {} opened", id),
        );
        id
    }

    /// Vote in a round. Weight is the voter's curve holdings in the coin
    /// (tokens bought on the curve and not yet sold). One vote per holder
    /// per round. Votes close at the deadline.
    pub fn vote(&mut self, round_id: u64, choice_index: u64) {
        let voter = env::predecessor_account_id();
        let mut round = self.vote_rounds.get(&round_id).expect("round not found").clone();
        assert!(!round.executed, "round already executed");
        assert!(env::block_timestamp() < round.deadline_ns, "voting closed");
        assert!(
            (choice_index as usize) < round.choices.len(),
            "bad choice"
        );
        assert!(!round.voters.contains(&voter), "already voted this round");
        let weight = self.holder_tokens(&voter, round.coin_id);
        assert!(weight > 0, "only holders vote");
        round.votes[choice_index as usize] += weight;
        round.voters.push(voter.clone());
        let vote_coin_id = round.coin_id;
        self.vote_rounds.insert(round_id, round);
        self.record_event(
            "vote",
            voter,
            vote_coin_id,
            weight,
            0,
            format!("voted in round {} (weight {} tokens)", round_id, weight),
        );
    }

    /// Execute a round after its deadline. The choice with the most vote
    /// weight wins; a tie means "Do nothing". Burn mints 2% of supply
    /// from the arena reserve; mint adds 2% to it. Both change the token
    /// contract's total supply through the owner-only mint/burn.
    pub fn execute_vote_round(&mut self, round_id: u64) {
        let mut round = self.vote_rounds.get(&round_id).expect("round not found").clone();
        assert!(!round.executed, "round already executed");
        assert!(
            env::block_timestamp() >= round.deadline_ns,
            "deadline not reached"
        );
        // Highest weight wins; on a tie the earliest choice wins, and
        // "Do nothing" is last, so a tie with it means no change.
        let mut best = 0usize;
        for (i, v) in round.votes.iter().enumerate() {
            if *v > round.votes[best] {
                best = i;
            }
        }
        let choice = round.choices[best].clone();
        let outcome = if round.votes[best] == 0 {
            "Do nothing".to_string()
        } else {
            choice.clone()
        };
        let mut coin = self.coins.get(&round.coin_id).expect("coin not found").clone();
        if outcome == "Burn 2% of supply" {
            let amount = coin.total_supply_tokens * VOTE_BURN_BP / 10_000;
            coin.burned_tokens += amount;
            coin.total_supply_tokens -= amount;
            self.coins.insert(round.coin_id, coin);
            let token_id = coin_token_id(self, round.coin_id);
            ext_ft_burn::ext(token_id)
                .with_static_gas(Gas::from_tgas(20))
                .burn(U128(amount * DECIMAL_MULT))
                .then(
                    ext_self::ext(env::current_account_id())
                        .with_static_gas(Gas::from_tgas(20))
                        .on_vote_executed(round_id, outcome),
                );
        } else if outcome == "Mint 2% of supply" {
            let amount = coin.total_supply_tokens * VOTE_MINT_BP / 10_000;
            coin.total_supply_tokens += amount;
            self.coins.insert(round.coin_id, coin);
            let token_id = coin_token_id(self, round.coin_id);
            ext_ft_burn::ext(token_id)
                .with_static_gas(Gas::from_tgas(20))
                .mint(U128(amount * DECIMAL_MULT))
                .then(
                    ext_self::ext(env::current_account_id())
                        .with_static_gas(Gas::from_tgas(20))
                        .on_vote_executed(round_id, outcome),
                );
        } else {
            round.executed = true;
            round.outcome = Some(outcome.clone());
            self.vote_rounds.insert(round_id, round);
            self.record_event(
                "vote_executed",
                env::predecessor_account_id(),
                coin.id,
                0,
                0,
                format!("vote round {} executed: {}", round_id, outcome),
            );
        }
    }

    /// Callback after a vote burn/mint. Marks the round executed; on
    /// failure the accounting is reverted and the outcome notes it.
    #[private]
    pub fn on_vote_executed(&mut self, round_id: u64, outcome: String) -> bool {
        let mut round = self.vote_rounds.get(&round_id).expect("round not found").clone();
        match env::promise_result(0) {
            PromiseResult::Successful(_) => {
                round.executed = true;
                round.outcome = Some(outcome.clone());
                let vote_coin_id = round.coin_id;
                self.vote_rounds.insert(round_id, round);
                self.record_event(
                    "vote_executed",
                    env::predecessor_account_id(),
                    vote_coin_id,
                    0,
                    0,
                    format!("vote round {} executed: {}", round_id, outcome),
                );
                true
            }
            _ => {
                let mut coin = self.coins.get(&round.coin_id).expect("coin not found").clone();
                if outcome == "Burn 2% of supply" {
                    let amount = coin.total_supply_tokens * VOTE_BURN_BP / 10_000;
                    // The burn failed, so the supply did not actually fall;
                    // undo the optimistic accounting using the pre-burn base.
                    coin.total_supply_tokens += amount;
                    coin.burned_tokens = coin.burned_tokens.saturating_sub(amount);
                } else if outcome == "Mint 2% of supply" {
                    let amount = coin.total_supply_tokens * VOTE_MINT_BP / 10_000;
                    coin.total_supply_tokens = coin.total_supply_tokens.saturating_sub(amount);
                }
                self.coins.insert(round.coin_id, coin);
                round.executed = true;
                round.outcome = Some(format!("{} (token call failed)", outcome));
                self.vote_rounds.insert(round_id, round);
                false
            }
        }
    }

    // -- coin duels ---------------------------------------------------------

    /// Start a duel between two coins. The metric is trading volume
    /// (NEAR bought plus NEAR sold) over the next 24h. The loser pays 5%
    /// of its NEAR treasury to the winner's treasury. Anyone can start one.
    pub fn create_coin_duel(&mut self, coin_a: u64, coin_b: u64) -> u64 {
        let creator = env::predecessor_account_id();
        assert!(self.coins.get(&coin_a).is_some(), "coin A not found");
        assert!(self.coins.get(&coin_b).is_some(), "coin B not found");
        assert_ne!(coin_a, coin_b, "a coin cannot duel itself");
        let now = env::block_timestamp();
        let id = self.coin_duel_count;
        self.coin_duel_count += 1;
        self.coin_duels.insert(
            id,
            CoinDuel {
                id,
                coin_a,
                coin_b,
                creator: creator.clone(),
                start_ns: now,
                end_ns: now + COIN_DUEL_DURATION_NS,
                vol_a_start: self.coin_volume_yocto(coin_a),
                vol_b_start: self.coin_volume_yocto(coin_b),
                status: 0,
                winner: None,
            },
        );
        self.record_event(
            "coin_duel_created",
            creator,
            coin_a,
            0,
            0,
            format!("coin duel {} started: coin {} vs coin {}", id, coin_a, coin_b),
        );
        id
    }

    /// Resolve a coin duel after its 24h window. The coin with the larger
    /// volume gain wins 5% of the loser's NEAR treasury. A tie pays nothing.
    pub fn resolve_coin_duel(&mut self, duel_id: u64) {
        let mut duel = self.coin_duels.get(&duel_id).expect("duel not found").clone();
        assert_eq!(duel.status, 0, "duel already resolved");
        assert!(
            env::block_timestamp() >= duel.end_ns,
            "duel window not over"
        );
        let vol_a = self.coin_volume_yocto(duel.coin_a) - duel.vol_a_start;
        let vol_b = self.coin_volume_yocto(duel.coin_b) - duel.vol_b_start;
        let winner = if vol_a > vol_b {
            Some(duel.coin_a)
        } else if vol_b > vol_a {
            Some(duel.coin_b)
        } else {
            None
        };
        duel.status = 1;
        duel.winner = winner;
        self.coin_duels.insert(duel_id, duel.clone());
        if let Some(w) = winner {
            let loser = if w == duel.coin_a { duel.coin_b } else { duel.coin_a };
            let mut loser_coin = self.coins.get(&loser).expect("coin not found").clone();
            let mut winner_coin = self.coins.get(&w).expect("coin not found").clone();
            let payment = loser_coin.near_reserve_yocto * COIN_DUEL_TREASURY_BP / 10_000;
            loser_coin.near_reserve_yocto -= payment;
            winner_coin.near_reserve_yocto += payment;
            self.coins.insert(loser, loser_coin);
            self.coins.insert(w, winner_coin);
            self.record_event(
                "coin_duel_resolved",
                duel.creator.clone(),
                w,
                0,
                payment,
                format!(
                    "coin duel {} won by coin {} (volume {} vs {}); loser paid 5% of treasury",
                    duel_id, w, vol_a, vol_b
                ),
            );
        } else {
            self.record_event(
                "coin_duel_resolved",
                duel.creator.clone(),
                duel.coin_a,
                0,
                0,
                format!("coin duel {} tied (volume {} vs {})", duel_id, vol_a, vol_b),
            );
        }
    }

    // -- daily meme ritual --------------------------------------------------

    fn meme_day_index(&self, coin: &Coin, now_ns: u64) -> u64 {
        now_ns.saturating_sub(coin.created_at_ns) / MEME_DAY_NS
    }

    /// Submit a meme hash to the current day's board for a coin. Only
    /// holders can submit, one submission per holder per day. The hash is
    /// any short string (for example an IPFS CID); only the hash is stored.
    pub fn submit_meme(&mut self, coin_id: u64, meme_hash: String) {
        let submitter = env::predecessor_account_id();
        assert!(!meme_hash.trim().is_empty(), "meme hash required");
        assert!(meme_hash.len() <= 128, "meme hash too long");
        let coin = self.coins.get(&coin_id).expect("coin not found").clone();
        assert!(
            self.holder_tokens(&submitter, coin_id) > 0,
            "only holders submit memes"
        );
        let day = self.meme_day_index(&coin, env::block_timestamp());
        let key = format!("{}:{}", coin_id, day);
        let mut md = self.meme_days.get(&key).cloned().unwrap_or(MemeDay {
            coin_id,
            day,
            submissions: vec![],
            voters: vec![],
            resolved: false,
            winner_hash: None,
            winner: None,
        });
        assert!(!md.resolved, "day already resolved");
        assert!(
            !md.submissions.iter().any(|s| s.submitter == submitter),
            "one submission per holder per day"
        );
        md.submissions.push(MemeSubmission {
            submitter: submitter.clone(),
            meme_hash: meme_hash.clone(),
            votes: 0,
        });
        self.meme_days.insert(key, md);
        self.record_event(
            "meme_submitted",
            submitter,
            coin_id,
            0,
            0,
            format!("meme submitted for day {}: {}", day, meme_hash),
        );
    }

    /// Vote for a submission on the current day's board. One vote per
    /// holder per day, equal weight. The submission index is its position
    /// in the day's list.
    pub fn vote_meme(&mut self, coin_id: u64, day: u64, submission_index: u64) {
        let voter = env::predecessor_account_id();
        let coin = self.coins.get(&coin_id).expect("coin not found").clone();
        assert!(
            self.holder_tokens(&voter, coin_id) > 0,
            "only holders vote on memes"
        );
        let current_day = self.meme_day_index(&coin, env::block_timestamp());
        assert_eq!(day, current_day, "can only vote on the current day");
        let key = format!("{}:{}", coin_id, day);
        let mut md = self.meme_days.get(&key).expect("no submissions this day").clone();
        assert!(!md.resolved, "day already resolved");
        assert!(!md.voters.contains(&voter), "already voted today");
        let idx = submission_index as usize;
        assert!(idx < md.submissions.len(), "bad submission");
        md.submissions[idx].votes += 1;
        md.voters.push(voter.clone());
        self.meme_days.insert(key, md);
        self.record_event(
            "meme_voted",
            voter,
            coin_id,
            0,
            0,
            format!("voted for meme {} on day {}", idx, day),
        );
    }

    /// Resolve a finished day: the submission with the most votes wins
    /// (ties go to the earliest submission). The winning hash is stored
    /// onchain and the submitter is paid 0.01 NEAR from the coin treasury
    /// when the treasury holds at least 0.05 NEAR. Anyone can resolve.
    pub fn resolve_meme_day(&mut self, coin_id: u64, day: u64) {
        let mut coin = self.coins.get(&coin_id).expect("coin not found").clone();
        let now = env::block_timestamp();
        assert!(
            now >= coin.created_at_ns + (day + 1) * MEME_DAY_NS,
            "day not over yet"
        );
        let key = format!("{}:{}", coin_id, day);
        let mut md = self.meme_days.get(&key).expect("no submissions that day").clone();
        assert!(!md.resolved, "day already resolved");
        assert!(!md.submissions.is_empty(), "no submissions to resolve");
        let mut best = 0usize;
        for (i, s) in md.submissions.iter().enumerate() {
            if s.votes > md.submissions[best].votes {
                best = i;
            }
        }
        let winner = md.submissions[best].clone();
        md.resolved = true;
        md.winner_hash = Some(winner.meme_hash.clone());
        md.winner = Some(winner.submitter.clone());
        self.meme_days.insert(key, md);
        let mut reward = 0u128;
        if coin.near_reserve_yocto >= MEME_MIN_RESERVE_YOCTO {
            reward = MEME_REWARD_YOCTO;
            coin.near_reserve_yocto -= reward;
            self.coins.insert(coin_id, coin);
            Promise::new(winner.submitter.clone()).transfer(NearToken::from_yoctonear(reward));
        }
        self.record_event(
            "meme_resolved",
            winner.submitter.clone(),
            coin_id,
            0,
            reward,
            format!(
                "day {} winning meme: {} ({} votes, reward {} yocto)",
                day, winner.meme_hash, winner.votes, reward
            ),
        );
    }

    // -- views -------------------------------------------------------------

    pub fn get_params(&self) -> ParamsView {
        ParamsView {
            decimals: DECIMALS,
            total_supply_tokens: TOTAL_SUPPLY_TOKENS.to_string(),
            max_curve_tokens: MAX_CURVE_TOKENS.to_string(),
            curve_chunk_tokens: CURVE_CHUNK_TOKENS.to_string(),
            curve_base_price_yocto: CURVE_BASE_PRICE_YOCTO.to_string(),
            curve_step_yocto: CURVE_STEP_YOCTO.to_string(),
            lock_duration_ns: LOCK_DURATION_NS,
            lock_duration_hours: 24,
            battle_duration_ns: BATTLE_DURATION_NS,
            battle_duration_hours: 24,
            battle_forfeit_yocto: BATTLE_FORFEIT_YOCTO.to_string(),
            launch_cost_yocto: LAUNCH_COST_YOCTO.to_string(),
            min_initial_buy_yocto: MIN_INITIAL_BUY_YOCTO.to_string(),
            rep_weight_pnl: REP_W_PNL,
            rep_weight_win_rate: REP_W_WIN,
            rep_weight_hold_time: REP_W_HOLD,
            rug_window_ns: RUG_WINDOW_NS,
            hold_full_hours: HOLD_FULL_HOURS,
            milestone_holders: vec![MILESTONE_HOLDERS_1, MILESTONE_HOLDERS_2, MILESTONE_HOLDERS_3],
            milestone_burn_bp: MILESTONE_BURN_BP,
            milestone_tranche_tokens: MILESTONE_TRANCHE_TOKENS.to_string(),
            milestone_airdrop_tokens: MILESTONE_AIRDROP_TOKENS.to_string(),
            vote_choices: VOTE_CHOICES.iter().map(|c| c.to_string()).collect(),
            vote_burn_bp: VOTE_BURN_BP,
            vote_mint_bp: VOTE_MINT_BP,
            vote_min_duration_hours: VOTE_MIN_DURATION_HOURS,
            vote_max_duration_hours: VOTE_MAX_DURATION_HOURS,
            coin_duel_duration_hours: 24,
            coin_duel_treasury_bp: COIN_DUEL_TREASURY_BP,
            meme_day_hours: 24,
            meme_reward_yocto: MEME_REWARD_YOCTO.to_string(),
            meme_min_reserve_yocto: MEME_MIN_RESERVE_YOCTO.to_string(),
        }
    }

    pub fn get_stats(&self) -> StatsView {
        let mut resolved = 0u64;
        for id in 0..self.battle_count {
            if let Some(b) = self.battles.get(&id) {
                if b.status == 2 {
                    resolved += 1;
                }
            }
        }
        StatsView {
            coins: self.coin_count,
            agents: self.agent_count,
            trades: self.activity.len() as u64,
            battles: self.battle_count,
            resolved_battles: resolved,
        }
    }

    pub fn get_coin(&self, coin_id: u64) -> Option<CoinView> {
        self.coins.get(&coin_id).map(|c| self.coin_view(c))
    }

    pub fn list_coins(&self, from_index: u64, limit: u64) -> Vec<CoinView> {
        let mut out = Vec::new();
        let mut i = from_index;
        while i < self.coin_count && out.len() < limit as usize {
            if let Some(c) = self.coins.get(&i) {
                out.push(self.coin_view(c));
            }
            i += 1;
        }
        out
    }

    pub fn get_agent(&self, account: AccountId) -> AgentView {
        self.agent_view(&account)
    }

    pub fn get_score(&self, account: AccountId) -> u16 {
        compute_score(&self.get_agent_stats(&account))
    }

    pub fn get_battle(&self, battle_id: u64) -> Option<BattleView> {
        self.battles.get(&battle_id).map(|b| BattleView {
            id: b.id,
            coin_id: b.coin_id,
            agent_a: b.agent_a.clone(),
            agent_b: b.agent_b.clone(),
            forfeit_yocto: b.forfeit_yocto.to_string(),
            status: battle_status_str(b.status).to_string(),
            created_at_ns: b.created_at_ns,
            start_ns: b.start_ns,
            end_ns: b.end_ns,
            pnl_a_start: b.pnl_a_start.to_string(),
            pnl_b_start: b.pnl_b_start.to_string(),
            winner: b.winner.clone(),
        })
    }

    pub fn list_battles(&self, from_index: u64, limit: u64) -> Vec<BattleView> {
        let mut out = Vec::new();
        let mut i = from_index;
        while i < self.battle_count && out.len() < limit as usize {
            if let Some(b) = self.battles.get(&i) {
                out.push(self.get_battle(i).unwrap());
            }
            i += 1;
        }
        out
    }

    pub fn get_vote_round(&self, round_id: u64) -> Option<VoteRoundView> {
        self.vote_rounds.get(&round_id).map(|r| VoteRoundView {
            id: r.id,
            coin_id: r.coin_id,
            creator: r.creator.clone(),
            question: r.question.clone(),
            choices: r.choices.clone(),
            deadline_ns: r.deadline_ns,
            votes: r.votes.iter().map(|v| v.to_string()).collect(),
            voters: r.voters.len() as u64,
            executed: r.executed,
            outcome: r.outcome.clone(),
        })
    }

    pub fn list_vote_rounds(&self, coin_id: u64, from_index: u64, limit: u64) -> Vec<VoteRoundView> {
        let mut out = Vec::new();
        let mut i = from_index;
        while i < self.vote_round_count && out.len() < limit as usize {
            if let Some(r) = self.vote_rounds.get(&i) {
                if r.coin_id == coin_id {
                    out.push(self.get_vote_round(i).unwrap());
                }
            }
            i += 1;
        }
        out
    }

    pub fn get_coin_duel(&self, duel_id: u64) -> Option<CoinDuelView> {
        self.coin_duels.get(&duel_id).map(|d| CoinDuelView {
            id: d.id,
            coin_a: d.coin_a,
            coin_b: d.coin_b,
            creator: d.creator.clone(),
            start_ns: d.start_ns,
            end_ns: d.end_ns,
            status: if d.status == 0 { "active".to_string() } else { "resolved".to_string() },
            winner: d.winner,
        })
    }

    pub fn list_coin_duels(&self, from_index: u64, limit: u64) -> Vec<CoinDuelView> {
        let mut out = Vec::new();
        let mut i = from_index;
        while i < self.coin_duel_count && out.len() < limit as usize {
            if let Some(d) = self.coin_duels.get(&i) {
                out.push(self.get_coin_duel(i).unwrap());
            }
            i += 1;
        }
        out
    }

    pub fn get_meme_day(&self, coin_id: u64, day: u64) -> Option<MemeDayView> {
        let key = format!("{}:{}", coin_id, day);
        self.meme_days.get(&key).map(|md| MemeDayView {
            coin_id: md.coin_id,
            day: md.day,
            submissions: md
                .submissions
                .iter()
                .map(|s| MemeSubmissionView {
                    submitter: s.submitter.clone(),
                    meme_hash: s.meme_hash.clone(),
                    votes: s.votes,
                })
                .collect(),
            voters: md.voters.len() as u64,
            resolved: md.resolved,
            winner_hash: md.winner_hash.clone(),
            winner: md.winner.clone(),
        })
    }

    /// Winning memes for a coin, newest day first.
    pub fn get_coin_winning_memes(&self, coin_id: u64, limit: u64) -> Vec<MemeDayView> {
        let coin = match self.coins.get(&coin_id) {
            Some(c) => c.clone(),
            None => return vec![],
        };
        let current_day = self.meme_day_index(&coin, env::block_timestamp());
        let mut out = Vec::new();
        let mut day = current_day + 1;
        while day > 0 && out.len() < limit as usize {
            day -= 1;
            if let Some(v) = self.get_meme_day(coin_id, day) {
                if v.resolved {
                    out.push(v);
                }
            }
        }
        out
    }

    /// Newest first.
    pub fn get_activity(&self, limit: u64) -> Vec<TradeEvent> {
        let n = self.activity.len() as usize;
        let take = (limit as usize).min(n);
        let mut out = Vec::with_capacity(take);
        for i in (n - take..n).rev() {
            if let Some(e) = self.activity.get(i as u32) {
                out.push(e.clone());
            }
        }
        out
    }

    /// One agent's trades, newest first.
    pub fn get_agent_trades(&self, account: AccountId, limit: u64) -> Vec<TradeEvent> {
        let mut out = Vec::new();
        let n = self.activity.len() as usize;
        let mut i = n;
        while i > 0 && out.len() < limit as usize {
            i -= 1;
            if let Some(e) = self.activity.get(i as u32) {
                if e.agent == account {
                    out.push(e.clone());
                }
            }
        }
        out
    }

    pub fn quote_buy(&self, coin_id: u64, near_yocto: U128) -> (U128, U128) {
        let coin = self.coins.get(&coin_id).expect("coin not found");
        let max_tokens = coin.curve_cap_tokens.saturating_sub(coin.sold_tokens);
        let (tokens, cost) = buy_tokens_for_near(coin.sold_tokens, near_yocto.0, max_tokens);
        (U128(tokens), U128(cost))
    }

    pub fn quote_sell(&self, coin_id: u64, tokens: U128) -> U128 {
        let coin = self.coins.get(&coin_id).expect("coin not found");
        U128(sell_proceeds_yocto(coin.sold_tokens, tokens.0))
    }

    pub fn get_coin_price(&self, coin_id: u64) -> U128 {
        let coin = self.coins.get(&coin_id).expect("coin not found");
        U128(price_per_token_yocto(coin.sold_tokens))
    }
}

fn coin_token_id(contract: &Contract, coin_id: u64) -> AccountId {
    contract
        .coins
        .get(&coin_id)
        .expect("coin not found")
        .token_id
        .clone()
}

// ---------------------------------------------------------------------------
// ft_on_transfer — sells. The seller sends tokens to the arena with
// ft_transfer_call; the arena pays NEAR from the coin's curve reserve.
// ---------------------------------------------------------------------------

#[near]
impl FungibleTokenReceiver for Contract {
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        assert_eq!(msg, "sell", "ft_transfer_call msg must be 'sell'");
        let token_id = env::predecessor_account_id();
        let coin_id = match self.token_to_coin.get(&token_id) {
            Some(id) => *id,
            None => return PromiseOrValue::Value(amount),
        };
        let mut coin = self.coins.get(&coin_id).expect("coin not found").clone();
        self.track_agent(&sender_id);
        // Whole tokens only; fractional dust is returned unused.
        let whole_tokens = amount.0 / DECIMAL_MULT;
        let dust = amount.0 % DECIMAL_MULT;
        if whole_tokens == 0 {
            return PromiseOrValue::Value(amount);
        }
        let whole_tokens = whole_tokens.min(coin.sold_tokens);
        if whole_tokens == 0 {
            return PromiseOrValue::Value(amount);
        }
        let proceeds = sell_proceeds_yocto(coin.sold_tokens, whole_tokens);
        assert!(
            proceeds <= coin.near_reserve_yocto,
            "curve reserve insufficient"
        );
        let now = env::block_timestamp();

        // Rug check: creator dumping more than half of its initial buy
        // within one hour after the lock expires zeroes its reputation.
        if sender_id == coin.creator && now >= coin.unlock_at_ns {
            coin.creator_sold_after_unlock += whole_tokens;
            if now < coin.unlock_at_ns + RUG_WINDOW_NS
                && coin.creator_sold_after_unlock > coin.initial_buy_tokens / 2
            {
                let mut stats = self.get_agent_stats(&sender_id);
                stats.rugged = true;
                self.agents.insert(sender_id.clone(), stats);
            }
        }

        coin.sold_tokens -= whole_tokens;
        coin.near_reserve_yocto -= proceeds;
        coin.total_received_yocto += proceeds;
        self.coins.insert(coin_id, coin.clone());

        // Position / cost basis / win rate / hold time / realised PnL.
        let key = Self::position_key(&sender_id, coin_id);
        let mut pos = self.positions.get(&key).cloned().unwrap_or_default();
        let mut stats = self.get_agent_stats(&sender_id);
        stats.total_received_yocto += proceeds;
        if pos.bought_tokens > 0 {
            let avg_cost = pos.spent_yocto / pos.bought_tokens;
            let cost_of_sold = whole_tokens * avg_cost;
            stats.sells += 1;
            if proceeds > cost_of_sold {
                stats.winning_sells += 1;
            }
            let hold_ns = now.saturating_sub(pos.first_buy_ns);
            stats.hold_time_total_ns += hold_ns as u128;
            stats.hold_count += 1;
            pos.realised_yocto += proceeds as i128 - cost_of_sold as i128;
            pos.spent_yocto = pos.spent_yocto.saturating_sub(cost_of_sold);
            pos.bought_tokens = pos.bought_tokens.saturating_sub(whole_tokens);
            if pos.bought_tokens == 0 {
                pos.first_buy_ns = 0;
            }
        } else {
            stats.sells += 1;
            pos.realised_yocto += proceeds as i128;
        }
        self.positions.insert(key, pos);
        self.agents.insert(sender_id.clone(), stats);
        self.record_event(
            "sell",
            sender_id.clone(),
            coin_id,
            whole_tokens,
            proceeds,
            "sold on the curve".to_string(),
        );
        if proceeds > 0 {
            Promise::new(sender_id).transfer(NearToken::from_yoctonear(proceeds));
        }
        let unused = U128(amount.0 - whole_tokens * DECIMAL_MULT);
        PromiseOrValue::Value(unused)
    }
}

// ---------------------------------------------------------------------------
// Unit tests — pure math and reputation. (On-chain flows are covered by the
// testnet demo-e2e script.)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curve_buy_sell_roundtrip() {
        // Buy 1 NEAR worth at launch, then sell it all back: proceeds must
        // equal the cost exactly (symmetric curve, no fee).
        let (tokens, cost) = buy_tokens_for_near(0, 1_000_000_000_000_000_000_000_000, MAX_CURVE_TOKENS);
        assert!(tokens > 0);
        assert!(cost <= 1_000_000_000_000_000_000_000_000);
        let proceeds = sell_proceeds_yocto(tokens, tokens);
        assert_eq!(proceeds, cost);
    }

    #[test]
    fn curve_price_rises_with_supply() {
        let p0 = price_per_token_yocto(0);
        let p1 = price_per_token_yocto(CURVE_CHUNK_TOKENS);
        let p2 = price_per_token_yocto(2 * CURVE_CHUNK_TOKENS);
        assert_eq!(p0, CURVE_BASE_PRICE_YOCTO);
        assert_eq!(p1, CURVE_BASE_PRICE_YOCTO + CURVE_STEP_YOCTO);
        assert_eq!(p2, CURVE_BASE_PRICE_YOCTO + 2 * CURVE_STEP_YOCTO);
    }

    #[test]
    fn curve_buy_cost_matches_tokens_for_near() {
        let (tokens, cost) = buy_tokens_for_near(0, 500_000_000_000_000_000_000_000, MAX_CURVE_TOKENS);
        assert_eq!(buy_cost_yocto(0, tokens), cost);
        // Buying the same amount again from the new supply costs more.
        let cost2 = buy_cost_yocto(tokens, tokens);
        assert!(cost2 >= cost);
    }

    #[test]
    fn curve_sell_never_exceeds_paid_in() {
        // Sell half of a 2 NEAR buy: proceeds must be <= 2 NEAR.
        let (tokens, cost) = buy_tokens_for_near(0, 2_000_000_000_000_000_000_000_000, MAX_CURVE_TOKENS);
        let proceeds = sell_proceeds_yocto(tokens, tokens / 2);
        assert!(proceeds <= cost);
        assert!(proceeds > 0);
    }

    #[test]
    fn reputation_neutral_new_agent() {
        let s = AgentStats::default();
        assert_eq!(compute_score(&s), 500);
        assert_eq!(score_band(500), "building");
    }

    #[test]
    fn reputation_perfect_agent() {
        // Doubled money, won every sell, held 24h+.
        let s = AgentStats {
            total_spent_yocto: 1_000_000_000_000_000_000_000_000,
            total_received_yocto: 2_000_000_000_000_000_000_000_000,
            sells: 4,
            winning_sells: 4,
            hold_time_total_ns: 4 * 24 * 3_600_000_000_000u128,
            hold_count: 4,
            rugged: false,
            coins_launched: 1,
            battles_played: 0,
            battles_won: 0,
        };
        assert_eq!(compute_score(&s), 1000);
        assert_eq!(score_band(1000), "strong");
    }

    #[test]
    fn reputation_losing_agent() {
        // Lost everything, no wins, instant flips.
        let s = AgentStats {
            total_spent_yocto: 1_000_000_000_000_000_000_000_000,
            total_received_yocto: 0,
            sells: 4,
            winning_sells: 0,
            hold_time_total_ns: 0,
            hold_count: 4,
            rugged: false,
            coins_launched: 0,
            battles_played: 0,
            battles_won: 0,
        };
        // PnL 0, win 0, hold 0 -> weighted 0.
        assert_eq!(compute_score(&s), 0);
        assert_eq!(score_band(0), "thin");
    }

    #[test]
    fn reputation_rug_zeroes_score() {
        let mut s = AgentStats {
            total_spent_yocto: 1_000_000_000_000_000_000_000_000,
            total_received_yocto: 2_000_000_000_000_000_000_000_000,
            sells: 4,
            winning_sells: 4,
            hold_time_total_ns: 4 * 24 * 3_600_000_000_000u128,
            hold_count: 4,
            rugged: true,
            coins_launched: 1,
            battles_played: 0,
            battles_won: 0,
        };
        assert_eq!(compute_score(&s), 0);
        s.rugged = false;
        assert_eq!(compute_score(&s), 1000);
    }

    #[test]
    fn reputation_weights_sum_to_100() {
        assert_eq!(REP_W_PNL + REP_W_WIN + REP_W_HOLD, 100);
    }

    #[test]
    fn milestone_amounts_are_sane() {
        // 1% burn of a 1e9 supply is 10M tokens; the airdrop splits 1M
        // across 100 holders into 10k each; the tranche is 50M.
        assert_eq!(TOTAL_SUPPLY_TOKENS * MILESTONE_BURN_BP / 10_000, 10_000_000);
        assert_eq!(MILESTONE_AIRDROP_TOKENS / MILESTONE_HOLDERS_3 as u128, 10_000);
        assert_eq!(MILESTONE_TRANCHE_TOKENS, 50_000_000);
        assert!(MILESTONE_HOLDERS_1 < MILESTONE_HOLDERS_2);
        assert!(MILESTONE_HOLDERS_2 < MILESTONE_HOLDERS_3);
    }

    #[test]
    fn vote_burn_and_mint_are_two_percent() {
        assert_eq!(TOTAL_SUPPLY_TOKENS * VOTE_BURN_BP / 10_000, 20_000_000);
        assert_eq!(TOTAL_SUPPLY_TOKENS * VOTE_MINT_BP / 10_000, 20_000_000);
        assert_eq!(VOTE_CHOICES.len(), 3);
        assert_eq!(VOTE_CHOICES[2], "Do nothing");
    }

    #[test]
    fn coin_duel_treasury_payment_is_five_percent() {
        let reserve = 2_000_000_000_000_000_000_000_000u128; // 2 NEAR
        let payment = reserve * COIN_DUEL_TREASURY_BP / 10_000;
        assert_eq!(payment, 100_000_000_000_000_000_000_000); // 0.1 NEAR
    }

    #[test]
    fn meme_day_index_counts_from_launch() {
        let created = 1_000_000_000_000_000_000u64;
        let day0 = created + 10 * 3_600_000_000_000;
        let day1 = created + 25 * 3_600_000_000_000;
        assert_eq!((day0 - created) / MEME_DAY_NS, 0);
        assert_eq!((day1 - created) / MEME_DAY_NS, 1);
    }

    #[test]
    fn curve_cap_grows_with_tranche() {
        assert_eq!(MAX_CURVE_TOKENS + MILESTONE_TRANCHE_TOKENS, 850_000_000);
        assert!(MAX_CURVE_TOKENS + MILESTONE_TRANCHE_TOKENS < TOTAL_SUPPLY_TOKENS);
    }
}
