//! PAC memecoin — minimal NEP-141 fungible token.
//! One instance is deployed per launched coin by the PAC arena contract.
//! The arena is the initial owner and holds the full supply; the bonding
//! curve sells from the arena's balance. Standard NEP-141 + storage.
//!
//! The near-contract-standards macros are deprecated and broken in 5.30,
//! so the FT traits are implemented manually by delegating to the inner
//! `FungibleToken`, which implements them itself.

use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::metadata::FungibleTokenMetadata;
use near_contract_standards::fungible_token::resolver::FungibleTokenResolver;
use near_contract_standards::fungible_token::FungibleToken;
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
// `serde_json` is not a dependency of this contract; cross-contract
// calls use the ext_contract-generated ext_arena trait instead.
use near_sdk::{
    env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, PromiseOrValue,
};

/// The arena's transfer-sync method. Called after a plain transfer so
/// the arena can reduce the sender's recorded curve position (H-03).
/// The arena ignores calls from any account that is not a registered
/// token contract, so this is a notification, not an authority grant.
#[ext_contract(ext_arena)]
pub trait ExtArena {
    fn on_token_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128);
}

/// Gas attached to the arena sync call. 10 TGas is ample for the
/// position update; the call is fire-and-forget and its failure does
/// not revert the transfer.
const SYNC_GAS: Gas = Gas::from_tgas(10);

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    metadata: FungibleTokenMetadata,
    /// The arena that deployed this coin; only it can mint or burn.
    owner: AccountId,
}

#[near]
impl Contract {
    /// Initialise and mint the full supply to `owner_id` (the arena).
    #[init]
    pub fn new(owner_id: AccountId, total_supply: U128, metadata: FungibleTokenMetadata) -> Self {
        assert!(!env::state_exists(), "Already initialized");
        let mut token = FungibleToken::new(b"t");
        token.internal_register_account(&owner_id);
        token.internal_deposit(&owner_id, total_supply.0);
        Self { token, metadata, owner: owner_id }
    }

    pub fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.clone()
    }

    /// Mint new tokens to the owner (the arena). Only the owner calls.
    /// Increases total supply. Used by PAC supply votes.
    pub fn mint(&mut self, amount: U128) {
        assert_eq!(env::predecessor_account_id(), self.owner, "only owner mints");
        let owner = self.owner.clone();
        self.token.internal_deposit(&owner, amount.0);
    }

    /// Burn tokens from the owner's balance. Only the owner calls.
    /// Decreases total supply. Used by PAC holder milestones and votes.
    pub fn burn(&mut self, amount: U128) {
        assert_eq!(env::predecessor_account_id(), self.owner, "only owner burns");
        let owner = self.owner.clone();
        self.token.internal_withdraw(&owner, amount.0);
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        let sender_id = env::predecessor_account_id();
        self.token.ft_transfer(receiver_id.clone(), amount, memo);
        // H-03: a plain transfer must sync holder accounting, or a
        // wallet could transfer its tokens away and still vote, count
        // as a qualified holder, and claim an airdrop on tokens it no
        // longer holds. Notify the arena (fire-and-forget); the arena
        // reduces the sender's recorded position. Transfers where the
        // arena itself is the sender (buys, claims, airdrops, copy
        // withdrawals) or the receiver (sells) are arena-originated
        // and are already accounted for, so they are not notified.
        if sender_id != self.owner && receiver_id != self.owner {
            let owner = self.owner.clone();
            let _ = ext_arena::ext(owner)
                .with_static_gas(SYNC_GAS)
                .on_token_transfer(sender_id, receiver_id.clone(), amount);
        }
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used_amount, _) =
            self.token.internal_ft_resolve_transfer(&sender_id, receiver_id.clone(), amount);
        // H-03: same sync as ft_transfer, for the amount actually
        // used by an ft_transfer_call to a non-arena receiver. A call
        // to the arena (a sell) is excluded: the arena is the receiver.
        if used_amount > 0 && sender_id != self.owner && receiver_id != self.owner {
            let owner = self.owner.clone();
            let _ = ext_arena::ext(owner)
                .with_static_gas(SYNC_GAS)
                .on_token_transfer(sender_id, receiver_id, U128(used_amount));
        }
        used_amount.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}
