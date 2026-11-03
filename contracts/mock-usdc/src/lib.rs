//! SANDBOX ONLY. A NEP-141 token that behaves like USDC on NEAR closely
//! enough for tests: 6 decimals, storage registration, and a blocklist (real
//! USDC can freeze accounts, which is how tests force a payment to fail).
//! `mint` is open to the `minter` account, which the demo uses to play the
//! part of a 1Click solver delivering USDC.

use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::resolver::FungibleTokenResolver;
use near_contract_standards::fungible_token::FungibleToken;
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::collections::LookupSet;
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue};

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Token,
    Blocked,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockUsdc {
    token: FungibleToken,
    blocked: LookupSet<AccountId>,
    minter: AccountId,
}

#[near]
impl MockUsdc {
    #[init]
    pub fn new(minter: AccountId) -> Self {
        Self { token: FungibleToken::new(Key::Token), blocked: LookupSet::new(Key::Blocked), minter }
    }

    /// Mint to `account_id`, registering it first if needed.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(env::predecessor_account_id() == self.minter, "only minter");
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
        self.token.internal_deposit(&account_id, amount.0);
        near_contract_standards::fungible_token::events::FtMint {
            owner_id: &account_id,
            amount,
            memo: Some("mock mint"),
        }
        .emit();
    }

    pub fn set_blocked(&mut self, account_id: AccountId, blocked: bool) {
        require!(env::predecessor_account_id() == self.minter, "only minter");
        if blocked {
            self.blocked.insert(&account_id);
        } else {
            self.blocked.remove(&account_id);
        }
    }

    fn check(&self, a: &AccountId) {
        require!(!self.blocked.contains(a), "account is blocked");
    }
}

#[near]
impl FungibleTokenCore for MockUsdc {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.check(&env::predecessor_account_id());
        self.check(&receiver_id);
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128> {
        self.check(&env::predecessor_account_id());
        self.check(&receiver_id);
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
impl FungibleTokenResolver for MockUsdc {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, _burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl StorageManagement for MockUsdc {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
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

#[near]
impl FungibleTokenMetadataProvider for MockUsdc {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Mock USD Coin (sandbox)".to_string(),
            symbol: "USDC".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }
}
