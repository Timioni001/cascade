//! Name factory: creates `name.<factory>` accounts (e.g. `ada.cascade.near`)
//! for new users, so they get a readable payment address without a seed
//! phrase and without buying NEAR.
//!
//! - Only the relayer may call `create_name` (the relayer applies per-IP and
//!   per-session limits off-chain; this contract adds a hard daily cap).
//! - The new account gets the user's browser-generated full-access key, and
//!   optionally a function-call key limited to the Cascade app contract so
//!   everyday actions can be relayed without exposing the full key.
//! - The factory pays the account's storage and registers it with USDC.

use near_sdk::json_types::U128;
use near_sdk::{
    env, ext_contract, near, require, AccountId, Allowance, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PublicKey,
};

const GAS_ON_CREATED: Gas = Gas::from_tgas(20);
const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
const NANOS_PER_DAY: u64 = 86_400 * 1_000_000_000;

pub const RESERVED: &[&str] = &[
    "app", "admin", "api", "relayer", "settler", "factory", "www", "mail", "team", "cascade", "near",
    "support", "help", "root", "pay", "usdc",
];

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
}

/// Name rules: 2-32 chars, lowercase letters and digits, single `-` or `_`
/// between them (NEAR account-id rules, minus dots).
pub fn valid_name(name: &str) -> bool {
    let b = name.as_bytes();
    if b.len() < 2 || b.len() > 32 {
        return false;
    }
    let alnum = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    if !alnum(b[0]) || !alnum(b[b.len() - 1]) {
        return false;
    }
    let mut prev_sep = false;
    for &c in b {
        let sep = c == b'-' || c == b'_';
        if !(alnum(c) || sep) || (sep && prev_sep) {
            return false;
        }
        prev_sep = sep;
    }
    true
}

#[near(serializers = [json])]
pub struct FactoryConfig {
    pub admin: AccountId,
    pub relayer: AccountId,
    pub app: AccountId,
    pub token: AccountId,
    pub initial_balance: U128,
    pub daily_cap: u32,
    pub created_today: u32,
    pub paused: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    admin: AccountId,
    relayer: AccountId,
    app: AccountId,
    token: AccountId,
    initial_balance: NearToken,
    storage_deposit: NearToken,
    daily_cap: u32,
    day: u64,
    created_today: u32,
    paused: bool,
}

#[near]
impl Factory {
    #[init]
    pub fn new(
        admin: AccountId,
        relayer: AccountId,
        app: AccountId,
        token: AccountId,
        initial_balance: Option<U128>,
        storage_deposit: Option<U128>,
        daily_cap: Option<u32>,
    ) -> Self {
        Self {
            admin,
            relayer,
            app,
            token,
            // Enough for the account record, two keys and a few small calls.
            initial_balance: NearToken::from_yoctonear(initial_balance.map(|v| v.0).unwrap_or(10u128.pow(22))),
            storage_deposit: NearToken::from_yoctonear(storage_deposit.map(|v| v.0).unwrap_or(1_250_000_000_000_000_000_000)),
            daily_cap: daily_cap.unwrap_or(200),
            day: 0,
            created_today: 0,
            paused: false,
        }
    }

    pub fn set_paused(&mut self, paused: bool) {
        require!(env::predecessor_account_id() == self.admin, "only admin");
        self.paused = paused;
    }

    pub fn set_relayer(&mut self, relayer: AccountId) {
        require!(env::predecessor_account_id() == self.admin, "only admin");
        self.relayer = relayer;
    }

    pub fn set_daily_cap(&mut self, daily_cap: u32) {
        require!(env::predecessor_account_id() == self.admin, "only admin");
        self.daily_cap = daily_cap;
    }

    pub fn create_name(&mut self, name: String, public_key: PublicKey, app_key: Option<PublicKey>) -> Promise {
        require!(env::predecessor_account_id() == self.relayer, "only the relayer");
        require!(!self.paused, "paused");
        require!(valid_name(&name), "names are 2-32 lowercase letters, digits, - or _");
        require!(!RESERVED.contains(&name.as_str()), "name is reserved");

        let today = env::block_timestamp() / NANOS_PER_DAY;
        if today != self.day {
            self.day = today;
            self.created_today = 0;
        }
        require!(self.created_today < self.daily_cap, "daily limit reached");
        self.created_today += 1;

        let account: AccountId = format!("{}.{}", name, env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("invalid account id"));
        let mut p = Promise::new(account.clone())
            .create_account()
            .transfer(self.initial_balance)
            .add_full_access_key(public_key);
        if let Some(k) = app_key {
            // Function-call key: may only call the app contract, cannot
            // attach deposits, and its gas allowance is unused because the
            // relayer pays for relayed transactions.
            p = p.add_access_key_allowance(k, Allowance::Unlimited, self.app.clone(), String::new());
        }
        p.then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_CREATED).on_created(account))
    }

    #[private]
    pub fn on_created(&mut self, account: AccountId, #[callback_result] result: Result<(), PromiseError>) -> bool {
        if result.is_err() {
            // Name already taken or creation failed: NEAR refunds the transfer
            // to us. Give the daily slot back.
            self.created_today = self.created_today.saturating_sub(1);
            env::log_str(&format!("create_name failed for {account}"));
            return false;
        }
        // Register the new account with USDC so it can receive money at once.
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(self.storage_deposit)
            .with_static_gas(GAS_STORAGE_DEPOSIT)
            .storage_deposit(Some(account.clone()), Some(true))
            .detach();
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"cascade\",\"version\":\"1.0.0\",\"event\":\"name_created\",\"data\":[{{\"account\":\"{account}\"}}]}}"
        ));
        true
    }

    pub fn get_config(&self) -> FactoryConfig {
        FactoryConfig {
            admin: self.admin.clone(),
            relayer: self.relayer.clone(),
            app: self.app.clone(),
            token: self.token.clone(),
            initial_balance: U128(self.initial_balance.as_yoctonear()),
            daily_cap: self.daily_cap,
            created_today: self.created_today,
            paused: self.paused,
        }
    }

    pub fn is_valid_name(&self, name: String) -> bool {
        valid_name(&name) && !RESERVED.contains(&name.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(pred: &str) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("cascade.near"))
            .predecessor_account_id(acc(pred))
            .account_balance(NearToken::from_near(100));
        testing_env!(b.build());
    }

    fn factory(cap: u32) -> Factory {
        ctx("admin.near");
        Factory::new(acc("admin.near"), acc("relayer.cascade.near"), acc("app.cascade.near"), acc("usdc.near"), None, None, Some(cap))
    }

    fn pk() -> PublicKey {
        "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap()
    }

    #[test]
    fn names() {
        for ok in ["ada", "ab", "ada-o", "a_1", "x".repeat(32).as_str()] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in ["a", "Ada", "-ada", "ada-", "a--b", "a.b", "ad a", "x".repeat(33).as_str(), "ada!"] {
            assert!(!valid_name(bad), "{bad}");
        }
    }

    #[test]
    fn only_relayer_can_create() {
        let mut f = factory(5);
        ctx("mallory.near");
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = f.create_name("ada".into(), pk(), None);
        }));
        assert!(r.is_err());
        ctx("relayer.cascade.near");
        let _ = f.create_name("ada".into(), pk(), Some(pk()));
        assert_eq!(f.get_config().created_today, 1);
    }

    #[test]
    fn reserved_and_daily_cap() {
        let mut f = factory(1);
        ctx("relayer.cascade.near");
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = f.create_name("relayer".into(), pk(), None);
        }));
        assert!(r.is_err());
        ctx("relayer.cascade.near");
        let _ = f.create_name("ada".into(), pk(), None);
        ctx("relayer.cascade.near");
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = f.create_name("bola".into(), pk(), None);
        }));
        assert!(r.is_err(), "cap of 1 per day");
    }
}
