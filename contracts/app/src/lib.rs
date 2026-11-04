//! Cascade app contract.
//!
//! Money only ever moves between three places: the owner (a person's account
//! or a team's Sputnik DAO), the USDC contract and this contract. This
//! contract holds USDC only between a batch being funded and its lines being
//! paid out. Every destination is locked (and hashed) when the batch is
//! created, before anyone funds it.
//!
//! Trust boundaries (see docs/threat-model.md):
//! - `mark_invoice_paid` / `record_link_payment` trust the `settler` account
//!   to report what 1Click delivered. They move no money; they only record.
//! - `execute_batch` and `refund_failed` can be called by anyone, because all
//!   destinations are already fixed and every line can be paid at most once.
//! - Escrow: only the payer (or the arbiter) can release a milestone, and only
//!   to the payee fixed at creation; refunds only ever go to the payer.
//! - Agent allowances: an agent can spend its owner's deposit only within the
//!   owner's limits (per payment, per day, expiry, allowed recipients); the
//!   owner can revoke at any time and the rest comes back to them.

pub mod model;
pub mod vault;

use model::*;
use vault::*;
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    env, ext_contract, log, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

/// Lines per batch. Bounded so `refund_failed` can scan a batch in one call.
pub const MAX_LINES: usize = 50;
/// Lines `execute_batch` will dispatch in one call (gas bound).
pub const MAX_EXEC_PER_CALL: u32 = 8;
pub const MAX_PREPARERS: usize = 10;

const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(5);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_ON_LINE_SENT: Gas = Gas::from_tgas(10);
const GAS_PER_LINE: Gas = Gas::from_tgas(5 + 15 + 10 + 2);
const GAS_EXEC_BASE: Gas = Gas::from_tgas(10);
const GAS_ON_REFUND: Gas = Gas::from_tgas(10);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// USDC on NEAR asks 0.00125 NEAR to register an account.
const DEFAULT_STORAGE_DEPOSIT: u128 = 1_250_000_000_000_000_000_000;

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
}

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Owners,
    Invoices,
    Batches,
    Lines,
    PaidDeposits,
    Splits,
    Escrows,
    Allowances,
}

/// `msg` for funding an escrow (exact total; anyone may fund it, e.g. 1Click delivering a checkout payment).
#[derive(Serialize, Deserialize, Debug)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct EscrowMsg {
    pub escrow: u64,
}

/// `msg` for topping up an agent allowance (the sender is the owner).
#[derive(Serialize, Deserialize, Debug)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct AllowanceMsg {
    pub allowance: AccountId,
}

/// `msg` for paying into a revenue split.
#[derive(Serialize, Deserialize, Debug)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct SplitMsg {
    pub split: u64,
}

/// Smallest payment a split accepts (0.01 USDC): stops dust from filling storage.
pub const MIN_SPLIT_PAYMENT: u128 = 10_000;

/// The `msg` the owner (or DAO) passes to `usdc.ft_transfer_call` to fund a batch.
#[derive(Serialize, Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct FundMsg {
    pub batch_id: u64,
    pub hash: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Config {
    pub admin: AccountId,
    pub settler: AccountId,
    pub token: AccountId,
    pub dao_factory: AccountId,
    pub storage_deposit: U128,
    pub next_invoice_id: u64,
    pub next_batch_id: u64,
    pub next_split_id: u64,
    pub next_escrow_id: u64,
}

#[near(serializers = [json])]
pub struct CreatedBatch {
    pub id: u64,
    pub hash: String,
    pub total: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Cascade {
    admin: AccountId,
    settler: AccountId,
    token: AccountId,
    dao_factory: AccountId,
    storage_deposit: NearToken,
    owners: LookupMap<AccountId, Owner>,
    invoices: LookupMap<u64, Invoice>,
    batches: LookupMap<u64, Batch>,
    lines: LookupMap<(u64, u32), Line>,
    /// Every 1Click deposit address already recorded as paid. The settler
    /// cannot record the same incoming payment twice.
    paid_deposits: LookupSet<String>,
    splits: LookupMap<u64, SplitRule>,
    escrows: LookupMap<u64, Escrow>,
    allowances: LookupMap<(AccountId, AccountId), Allowance>,
    next_invoice_id: u64,
    next_batch_id: u64,
    next_split_id: u64,
    next_escrow_id: u64,
}

/// SHA-256 over the Borsh encoding of the lines, as lowercase hex.
/// `packages/core/src/hash.ts` implements the same encoding; both sides are
/// tested against the same fixed vector.
pub fn hash_lines(lines: &[LineInput]) -> String {
    let bytes = near_sdk::borsh::to_vec(&lines.to_vec()).expect("borsh");
    hex::encode(env::sha256(&bytes))
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    log!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({
            "standard": "cascade",
            "version": "1.0.0",
            "event": event,
            "data": [data],
        })
    );
}

fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

#[near]
impl Cascade {
    #[init]
    pub fn new(
        admin: AccountId,
        settler: AccountId,
        token: AccountId,
        dao_factory: AccountId,
        storage_deposit: Option<U128>,
    ) -> Self {
        let deposit = NearToken::from_yoctonear(storage_deposit.map(|v| v.0).unwrap_or(DEFAULT_STORAGE_DEPOSIT));
        // This contract must itself be registered with the token, or every
        // ft_transfer_call that funds a batch fails. Do it here so no
        // deployment can forget it.
        ext_ft::ext(token.clone())
            .with_attached_deposit(deposit)
            .with_static_gas(GAS_STORAGE_DEPOSIT)
            .storage_deposit(Some(env::current_account_id()), Some(true))
            .detach();
        Self {
            admin,
            settler,
            token,
            dao_factory,
            storage_deposit: deposit,
            owners: LookupMap::new(Key::Owners),
            invoices: LookupMap::new(Key::Invoices),
            batches: LookupMap::new(Key::Batches),
            lines: LookupMap::new(Key::Lines),
            paid_deposits: LookupSet::new(Key::PaidDeposits),
            splits: LookupMap::new(Key::Splits),
            escrows: LookupMap::new(Key::Escrows),
            allowances: LookupMap::new(Key::Allowances),
            next_invoice_id: 0,
            next_batch_id: 0,
            next_split_id: 0,
            next_escrow_id: 0,
        }
    }

    // ------------------------------------------------------------ admin

    pub fn set_settler(&mut self, settler: AccountId) {
        require!(env::predecessor_account_id() == self.admin, "only admin");
        self.settler = settler;
    }

    // ------------------------------------------------------------ owners

    /// The caller registers itself as an owner. A DAO calls this through a
    /// Sputnik `FunctionCall` proposal, so its members approve who can
    /// prepare payments on its behalf.
    pub fn register_owner(&mut self, kind: OwnerKind, preparers: Vec<AccountId>) -> Owner {
        let id = env::predecessor_account_id();
        require!(preparers.len() <= MAX_PREPARERS, "too many preparers");
        if kind == OwnerKind::Dao {
            let suffix = format!(".{}", self.dao_factory);
            require!(
                id.as_str().ends_with(&suffix),
                "a Dao owner must be a Sputnik DAO account"
            );
        }
        let owner = Owner { id: id.clone(), kind, preparers, token: self.token.clone() };
        self.owners.insert(id.clone(), owner.clone());
        emit("register_owner", near_sdk::serde_json::json!({ "owner": id, "kind": kind }));
        owner
    }

    fn owner_for_preparer(&self, owner: &AccountId) -> Owner {
        let o = self.owners.get(owner).cloned().unwrap_or_else(|| env::panic_str("unknown owner"));
        require!(o.can_prepare(&env::predecessor_account_id()), "not allowed to prepare for this owner");
        o
    }

    // ------------------------------------------------------------ invoices

    pub fn create_invoice(&mut self, owner: AccountId, amount: U128, metadata_hash: String) -> Invoice {
        self.owner_for_preparer(&owner);
        require!(amount.0 > 0, "amount must be positive");
        require!(is_hex64(&metadata_hash), "metadata_hash must be 64 hex chars");
        let id = self.next_invoice_id;
        self.next_invoice_id += 1;
        let inv = Invoice {
            id,
            owner: owner.clone(),
            amount,
            status: InvoiceStatus::Open,
            source: InvoiceSource::Invoice,
            metadata_hash,
            created_by: env::predecessor_account_id(),
            created_at_ms: now_ms(),
            settlement: None,
        };
        self.invoices.insert(id, inv.clone());
        emit("create_invoice", near_sdk::serde_json::json!({ "id": id, "owner": owner, "amount": amount }));
        inv
    }

    pub fn void_invoice(&mut self, id: u64) -> Invoice {
        let mut inv = self.invoices.get(&id).cloned().unwrap_or_else(|| env::panic_str("no invoice"));
        self.owner_for_preparer(&inv.owner);
        require!(inv.status == InvoiceStatus::Open, "only open invoices can be voided");
        inv.status = InvoiceStatus::Void;
        self.invoices.insert(id, inv.clone());
        emit("void_invoice", near_sdk::serde_json::json!({ "id": id }));
        inv
    }

    fn take_deposit_address(&mut self, deposit_address: &str) {
        require!(!deposit_address.is_empty(), "empty deposit address");
        require!(
            self.paid_deposits.insert(deposit_address.to_string()),
            "deposit address already recorded"
        );
    }

    /// Settler only. Records that 1Click delivered at least the invoice
    /// amount to the owner. Moves no money.
    pub fn mark_invoice_paid(
        &mut self,
        id: u64,
        deposit_address: String,
        amount_out: U128,
        dest_tx: String,
    ) -> Invoice {
        require!(env::predecessor_account_id() == self.settler, "only the settler");
        let mut inv = self.invoices.get(&id).cloned().unwrap_or_else(|| env::panic_str("no invoice"));
        require!(inv.status == InvoiceStatus::Open, "invoice is not open");
        require!(amount_out.0 >= inv.amount.0, "delivered amount is below the invoice amount");
        self.take_deposit_address(&deposit_address);
        inv.status = InvoiceStatus::Paid;
        inv.settlement = Some(Settlement { deposit_address, amount_out, dest_tx, settled_at_ms: now_ms() });
        self.invoices.insert(id, inv.clone());
        emit("invoice_paid", near_sdk::serde_json::json!({ "id": id, "owner": inv.owner, "amount_out": amount_out }));
        inv
    }

    /// Settler only. A payer used the owner's public link with no invoice;
    /// record the receipt so the owner's on-chain history is complete.
    pub fn record_link_payment(
        &mut self,
        owner: AccountId,
        deposit_address: String,
        amount_out: U128,
        dest_tx: String,
        metadata_hash: String,
    ) -> Invoice {
        require!(env::predecessor_account_id() == self.settler, "only the settler");
        require!(self.owners.contains_key(&owner), "unknown owner");
        require!(amount_out.0 > 0, "amount must be positive");
        require!(is_hex64(&metadata_hash), "metadata_hash must be 64 hex chars");
        self.take_deposit_address(&deposit_address);
        let id = self.next_invoice_id;
        self.next_invoice_id += 1;
        let inv = Invoice {
            id,
            owner: owner.clone(),
            amount: amount_out,
            status: InvoiceStatus::Paid,
            source: InvoiceSource::Link,
            metadata_hash,
            created_by: env::predecessor_account_id(),
            created_at_ms: now_ms(),
            settlement: Some(Settlement { deposit_address, amount_out, dest_tx, settled_at_ms: now_ms() }),
        };
        self.invoices.insert(id, inv.clone());
        emit("invoice_paid", near_sdk::serde_json::json!({ "id": id, "owner": owner, "amount_out": amount_out, "source": "link" }));
        inv
    }

    // ------------------------------------------------------------ batches

    /// Lock a list of payment lines. Returns the id and the hash the funder
    /// must quote back in `ft_transfer_call`'s `msg`.
    pub fn create_batch(&mut self, owner: AccountId, lines: Vec<LineInput>) -> CreatedBatch {
        self.owner_for_preparer(&owner);
        require!(!lines.is_empty(), "no lines");
        require!(lines.len() <= MAX_LINES, "too many lines");
        let now = now_ms();
        let mut total: u128 = 0;
        for l in &lines {
            require!(l.amount.0 > 0, "line amount must be positive");
            require!(l.recipient != env::current_account_id(), "cannot pay this contract");
            if let Some(d) = l.deadline_ms {
                require!(d > now, "line quote already expired");
            }
            if l.kind != LineKind::Near {
                require!(l.deadline_ms.is_some(), "quoted lines need a deadline");
            }
            total = total.checked_add(l.amount.0).unwrap_or_else(|| env::panic_str("total overflow"));
        }
        let hash = hash_lines(&lines);
        let id = self.next_batch_id;
        self.next_batch_id += 1;
        let batch = Batch::new(id, owner.clone(), hash.clone(), total, lines.len() as u32, env::predecessor_account_id(), now);
        for (i, l) in lines.into_iter().enumerate() {
            self.lines.insert((id, i as u32), Line::from(l));
        }
        self.batches.insert(id, batch);
        emit("create_batch", near_sdk::serde_json::json!({ "id": id, "owner": owner, "total": U128(total), "hash": hash }));
        CreatedBatch { id, hash, total: U128(total) }
    }

    pub fn cancel_batch(&mut self, id: u64) {
        let mut b = self.batches.get(&id).cloned().unwrap_or_else(|| env::panic_str("no batch"));
        self.owner_for_preparer(&b.owner);
        require!(b.status == BatchStatus::Draft, "only drafts can be cancelled");
        b.status = BatchStatus::Cancelled;
        self.batches.insert(id, b);
        emit("cancel_batch", near_sdk::serde_json::json!({ "id": id }));
    }

    /// Informational link from a batch to the DAO proposal that funds it.
    pub fn set_batch_proposal(&mut self, id: u64, proposal_id: u64) {
        let mut b = self.batches.get(&id).cloned().unwrap_or_else(|| env::panic_str("no batch"));
        self.owner_for_preparer(&b.owner);
        require!(b.status == BatchStatus::Draft, "batch is not a draft");
        b.proposal_id = Some(proposal_id);
        self.batches.insert(id, b);
    }

    /// NEP-141 receiver. Two kinds of `msg`:
    ///
    /// `{"batch_id", "hash"}`: funding a batch. Accepted only from the
    /// configured token, from the batch owner, for exactly the batch total,
    /// with the matching hash. Anything else is returned in full.
    ///
    /// `{"split": id}`: a payment into a revenue split (anyone may pay, e.g.
    /// NEAR Intents delivering a checkout payment). The amount is divided by
    /// the split's shares into a new batch that is funded at once; the
    /// settler (or anyone) then pays it out like any other batch.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let reject = |why: &str| {
            emit("fund_rejected", near_sdk::serde_json::json!({ "sender": sender_id, "amount": amount, "reason": why }));
            PromiseOrValue::Value(amount)
        };
        if env::predecessor_account_id() != self.token {
            return reject("wrong token");
        }
        if let Ok(m) = near_sdk::serde_json::from_str::<SplitMsg>(&msg) {
            return self.receive_split(sender_id, amount, m.split);
        }
        if let Ok(m) = near_sdk::serde_json::from_str::<EscrowMsg>(&msg) {
            return self.fund_escrow(sender_id, amount, m.escrow);
        }
        if let Ok(m) = near_sdk::serde_json::from_str::<AllowanceMsg>(&msg) {
            return self.fund_allowance(sender_id, amount, m.allowance);
        }
        let Ok(m) = near_sdk::serde_json::from_str::<FundMsg>(&msg) else {
            return reject("bad msg");
        };
        let Some(mut b) = self.batches.get(&m.batch_id).cloned() else {
            return reject("no such batch");
        };
        if b.status != BatchStatus::Draft {
            return reject("batch is not waiting for funds");
        }
        if b.owner != sender_id {
            return reject("only the batch owner can fund it");
        }
        if b.total != amount {
            return reject("amount does not match batch total");
        }
        if b.hash != m.hash {
            return reject("hash does not match batch");
        }
        b.mark_funded();
        self.batches.insert(m.batch_id, b);
        emit("batch_funded", near_sdk::serde_json::json!({ "id": m.batch_id, "amount": amount }));
        PromiseOrValue::Value(U128(0))
    }

    fn receive_split(&mut self, sender_id: AccountId, amount: U128, split_id: u64) -> PromiseOrValue<U128> {
        let Some(rule) = self.splits.get(&split_id).cloned() else {
            emit("fund_rejected", near_sdk::serde_json::json!({ "sender": sender_id, "amount": amount, "reason": "no such split" }));
            return PromiseOrValue::Value(amount);
        };
        if amount.0 < MIN_SPLIT_PAYMENT {
            emit("fund_rejected", near_sdk::serde_json::json!({ "sender": sender_id, "amount": amount, "reason": "below the minimum split payment" }));
            return PromiseOrValue::Value(amount);
        }
        let parts = split_amount(amount.0, &rule.shares);
        let lines: Vec<LineInput> = rule
            .shares
            .iter()
            .zip(parts)
            .filter(|(_, p)| *p > 0)
            .map(|(s, p)| LineInput { recipient: s.account.clone(), amount: U128(p), kind: LineKind::Near, dest: None, deadline_ms: None })
            .collect();
        let id = self.next_batch_id;
        self.next_batch_id += 1;
        let mut batch = Batch::new(id, rule.owner.clone(), hash_lines(&lines), amount.0, lines.len() as u32, sender_id.clone(), now_ms());
        batch.mark_funded();
        for (i, l) in lines.into_iter().enumerate() {
            self.lines.insert((id, i as u32), Line::from(l));
        }
        self.batches.insert(id, batch);
        emit("split_received", near_sdk::serde_json::json!({ "split": split_id, "batch": id, "owner": rule.owner, "amount": amount, "sender": sender_id }));
        PromiseOrValue::Value(U128(0))
    }

    // ------------------------------------------------------------ splits

    /// Create a standing revenue split for `owner` (by the owner or a preparer).
    /// Shares are NEAR accounts (people, or a DAO) and must add up to 100%.
    pub fn create_split(&mut self, owner: AccountId, shares: Vec<Share>) -> SplitRule {
        self.owner_for_preparer(&owner);
        if let Err(e) = validate_shares(&shares) {
            env::panic_str(e);
        }
        require!(shares.iter().all(|s| s.account != env::current_account_id()), "cannot pay this contract");
        let id = self.next_split_id;
        self.next_split_id += 1;
        let rule = SplitRule { id, owner: owner.clone(), shares, created_by: env::predecessor_account_id(), created_at_ms: now_ms() };
        self.splits.insert(id, rule.clone());
        emit("create_split", near_sdk::serde_json::json!({ "id": id, "owner": owner }));
        rule
    }

    pub fn get_split(&self, id: u64) -> Option<SplitRule> {
        self.splits.get(&id).cloned()
    }

    /// Anyone can push a funded batch forward. Pays up to `limit` queued
    /// lines (max 8 per call), each with `storage_deposit` + `ft_transfer`.
    pub fn execute_batch(&mut self, id: u64, limit: u32) -> u32 {
        let mut b = self.batches.get(&id).cloned().unwrap_or_else(|| env::panic_str("no batch"));
        require!(b.is_funded(), "batch is not funded");
        let limit = limit.clamp(1, MAX_EXEC_PER_CALL);
        let needed = GAS_EXEC_BASE.saturating_add(GAS_PER_LINE.saturating_mul(limit as u64));
        require!(env::prepaid_gas() >= needed, "attach more gas for this limit");

        let now = now_ms();
        let mut dispatched = 0u32;
        let mut i = b.cursor;
        while i < b.line_count && dispatched < limit {
            let key = (id, i);
            let mut line = self.lines.get(&key).cloned().expect("line");
            if line.status == LineStatus::Queued {
                if line.deadline_ms.is_some_and(|d| d <= now) {
                    b.transition(&mut line, LineStatus::Failed).unwrap_or_else(|e| env::panic_str(&e.to_string()));
                    line.note = Some("quote expired before payment".into());
                } else {
                    b.transition(&mut line, LineStatus::InFlight).unwrap_or_else(|e| env::panic_str(&e.to_string()));
                    self.dispatch_line(id, i, &line);
                    dispatched += 1;
                }
                self.lines.insert(key, line);
            }
            i += 1;
        }
        b.cursor = i;
        self.batches.insert(id, b);
        dispatched
    }

    fn dispatch_line(&self, id: u64, idx: u32, line: &Line) {
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(self.storage_deposit)
            .with_static_gas(GAS_STORAGE_DEPOSIT)
            .storage_deposit(Some(line.recipient.clone()), Some(true))
            .then(
                ext_ft::ext(self.token.clone())
                    .with_attached_deposit(ONE_YOCTO)
                    .with_static_gas(GAS_FT_TRANSFER)
                    .ft_transfer(line.recipient.clone(), line.amount, Some(format!("cascade:{id}:{idx}"))),
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_LINE_SENT).on_line_sent(id, idx))
            .detach();
    }

    #[private]
    pub fn on_line_sent(&mut self, id: u64, idx: u32, #[callback_result] result: Result<(), PromiseError>) -> bool {
        let mut b = self.batches.get(&id).cloned().expect("batch");
        let mut line = self.lines.get(&(id, idx)).cloned().expect("line");
        let ok = result.is_ok();
        let to = if ok { LineStatus::Sent } else { LineStatus::Failed };
        b.transition(&mut line, to).unwrap_or_else(|e| env::panic_str(&e.to_string()));
        if !ok {
            line.note = Some("transfer failed".into());
        }
        self.lines.insert((id, idx), line.clone());
        self.batches.insert(id, b);
        emit(
            if ok { "line_sent" } else { "line_failed" },
            near_sdk::serde_json::json!({ "batch": id, "line": idx, "recipient": line.recipient, "amount": line.amount }),
        );
        ok
    }

    /// Anyone can return failed lines' money to the batch owner.
    pub fn refund_failed(&mut self, id: u64) -> Promise {
        let mut b = self.batches.get(&id).cloned().unwrap_or_else(|| env::panic_str("no batch"));
        let mut idxs = Vec::new();
        let mut total: u128 = 0;
        for i in 0..b.line_count {
            let mut line = self.lines.get(&(id, i)).cloned().expect("line");
            if line.status == LineStatus::Failed {
                b.transition(&mut line, LineStatus::Refunding).unwrap_or_else(|e| env::panic_str(&e.to_string()));
                total += line.amount.0;
                idxs.push(i);
                self.lines.insert((id, i), line);
            }
        }
        require!(!idxs.is_empty(), "nothing to refund");
        let owner = b.owner.clone();
        self.batches.insert(id, b);
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(owner, U128(total), Some(format!("cascade:{id}:refund")))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_REFUND).on_refund(id, idxs))
    }

    #[private]
    pub fn on_refund(&mut self, id: u64, idxs: Vec<u32>, #[callback_result] result: Result<(), PromiseError>) -> bool {
        let mut b = self.batches.get(&id).cloned().expect("batch");
        let ok = result.is_ok();
        let to = if ok { LineStatus::Refunded } else { LineStatus::Failed };
        let mut amount: u128 = 0;
        for i in &idxs {
            let mut line = self.lines.get(&(id, *i)).cloned().expect("line");
            b.transition(&mut line, to).unwrap_or_else(|e| env::panic_str(&e.to_string()));
            amount += line.amount.0;
            self.lines.insert((id, *i), line);
        }
        let owner = b.owner.clone();
        self.batches.insert(id, b);
        emit(
            if ok { "batch_refunded" } else { "refund_failed" },
            near_sdk::serde_json::json!({ "batch": id, "lines": idxs, "owner": owner, "amount": U128(amount) }),
        );
        ok
    }

    // ------------------------------------------------------------ escrow

    /// Propose an escrow (by the payee, the payer, or a preparer of an owner
    /// payee such as a DAO). Nothing is held until someone funds it with
    /// `ft_transfer_call(msg: {"escrow": id})` for exactly the total.
    pub fn create_escrow(
        &mut self,
        payee: AccountId,
        payer: AccountId,
        arbiter: Option<AccountId>,
        milestones: Vec<MilestoneInput>,
        refund_after_ms: u64,
        metadata_hash: String,
    ) -> Escrow {
        let caller = env::predecessor_account_id();
        let preparer = self.owners.get(&payee).is_some_and(|o| o.can_prepare(&caller));
        require!(caller == payee || caller == payer || preparer, "only the payee, the payer or a preparer of the payee");
        require!(payee != payer, "payee and payer must differ");
        let me = env::current_account_id();
        require!(payee != me && payer != me && arbiter.as_ref() != Some(&me), "cannot use this contract as a party");
        let total = validate_milestones(&milestones).unwrap_or_else(|e| env::panic_str(e));
        let now = now_ms();
        require!(
            refund_after_ms >= now + MIN_REFUND_AFTER_MS && refund_after_ms <= now + MAX_REFUND_AFTER_MS,
            "refund date must be between 1 hour and 1 year from now"
        );
        require!(is_hex64(&metadata_hash), "metadata_hash must be 64 hex chars");
        let id = self.next_escrow_id;
        self.next_escrow_id += 1;
        let e = Escrow {
            id,
            payee,
            payer,
            arbiter,
            milestones: milestones.into_iter().map(|m| Milestone { title: m.title, amount: m.amount, status: MilestoneStatus::Pending }).collect(),
            total: U128(total),
            status: EscrowStatus::AwaitingFunds,
            refund_after_ms,
            metadata_hash,
            created_by: caller,
            created_at_ms: now,
            funded_by: None,
        };
        self.escrows.insert(id, e.clone());
        emit("create_escrow", near_sdk::serde_json::json!({ "id": id, "payee": e.payee, "payer": e.payer, "total": e.total }));
        e
    }

    fn fund_escrow(&mut self, sender_id: AccountId, amount: U128, id: u64) -> PromiseOrValue<U128> {
        let reject = |why: &str| {
            emit("fund_rejected", near_sdk::serde_json::json!({ "sender": sender_id, "amount": amount, "reason": why, "escrow": id }));
            PromiseOrValue::Value(amount)
        };
        let Some(mut e) = self.escrows.get(&id).cloned() else { return reject("no such escrow") };
        if e.status != EscrowStatus::AwaitingFunds {
            return reject("escrow is not waiting for funds");
        }
        if e.total != amount {
            return reject("amount does not match escrow total");
        }
        e.status = EscrowStatus::Funded;
        e.funded_by = Some(sender_id.clone());
        self.escrows.insert(id, e);
        emit("escrow_funded", near_sdk::serde_json::json!({ "id": id, "amount": amount, "sender": sender_id }));
        PromiseOrValue::Value(U128(0))
    }

    /// Cancel before funding (payee or payer).
    pub fn cancel_escrow(&mut self, id: u64) {
        let mut e = self.escrows.get(&id).cloned().unwrap_or_else(|| env::panic_str("no escrow"));
        let caller = env::predecessor_account_id();
        require!(caller == e.payee || caller == e.payer, "only the payee or the payer");
        require!(e.status == EscrowStatus::AwaitingFunds, "escrow is already funded");
        e.status = EscrowStatus::Cancelled;
        self.escrows.insert(id, e);
        emit("escrow_cancelled", near_sdk::serde_json::json!({ "id": id }));
    }

    /// The payer (or arbiter) accepts milestone `idx`: it is paid to the payee.
    pub fn release_milestone(&mut self, id: u64, idx: u32) {
        let mut e = self.escrows.get(&id).cloned().unwrap_or_else(|| env::panic_str("no escrow"));
        require!(e.can_release(&env::predecessor_account_id()), "only the payer or the arbiter can release");
        let amount = e.start(idx as usize, MilestoneStatus::Releasing).unwrap_or_else(|err| env::panic_str(err));
        let to = e.payee.clone();
        self.escrows.insert(id, e);
        self.send(to, amount, format!("cascade:escrow:{id}:{idx}"), Self::ext(env::current_account_id()).with_static_gas(GAS_ON_LINE_SENT).on_milestone_sent(id, idx));
    }

    /// Return milestone `idx` to the payer: the payee or arbiter may, and anyone after the refund date.
    pub fn refund_milestone(&mut self, id: u64, idx: u32) {
        let mut e = self.escrows.get(&id).cloned().unwrap_or_else(|| env::panic_str("no escrow"));
        require!(e.can_refund(&env::predecessor_account_id(), now_ms()), "only the payee or the arbiter can refund before the refund date");
        let amount = e.start(idx as usize, MilestoneStatus::Refunding).unwrap_or_else(|err| env::panic_str(err));
        let to = e.payer.clone();
        self.escrows.insert(id, e);
        self.send(to, amount, format!("cascade:escrow:{id}:{idx}:refund"), Self::ext(env::current_account_id()).with_static_gas(GAS_ON_LINE_SENT).on_milestone_sent(id, idx));
    }

    #[private]
    pub fn on_milestone_sent(&mut self, id: u64, idx: u32, #[callback_result] result: Result<(), PromiseError>) -> bool {
        let mut e = self.escrows.get(&id).cloned().expect("escrow");
        let ok = result.is_ok();
        let releasing = e.milestones.get(idx as usize).is_some_and(|m| m.status == MilestoneStatus::Releasing);
        e.finish(idx as usize, ok);
        let m = e.milestones[idx as usize].clone();
        let status = e.status;
        self.escrows.insert(id, e);
        let event = match (ok, releasing) {
            (true, true) => "milestone_released",
            (true, false) => "milestone_refunded",
            (false, _) => "milestone_transfer_failed",
        };
        emit(event, near_sdk::serde_json::json!({ "escrow": id, "milestone": idx, "amount": m.amount, "closed": status == EscrowStatus::Closed }));
        ok
    }

    /// storage_deposit (so a new account can receive) + ft_transfer, then `then`.
    fn send(&self, to: AccountId, amount: u128, memo: String, then: Promise) {
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(self.storage_deposit)
            .with_static_gas(GAS_STORAGE_DEPOSIT)
            .storage_deposit(Some(to.clone()), Some(true))
            .then(ext_ft::ext(self.token.clone()).with_attached_deposit(ONE_YOCTO).with_static_gas(GAS_FT_TRANSFER).ft_transfer(to, U128(amount), Some(memo)))
            .then(then)
            .detach();
    }

    pub fn get_escrow(&self, id: u64) -> Option<Escrow> {
        self.escrows.get(&id).cloned()
    }

    // ------------------------------------------------------------ agent allowances

    /// The owner (the caller) sets or replaces what `agent` may spend. Fund it
    /// with `ft_transfer_call(msg: {"allowance": agent})`.
    pub fn set_allowance(&mut self, agent: AccountId, policy: AllowancePolicy) -> Allowance {
        let owner = env::predecessor_account_id();
        require!(agent != owner, "an agent must be a different account");
        validate_policy(&policy, now_ms()).unwrap_or_else(|e| env::panic_str(e));
        let key = (owner.clone(), agent.clone());
        let a = match self.allowances.get(&key).cloned() {
            Some(mut a) => {
                a.policy = policy;
                a.revoked = false;
                a
            }
            None => Allowance::new(owner.clone(), agent.clone(), policy),
        };
        self.allowances.insert(key, a.clone());
        emit("set_allowance", near_sdk::serde_json::json!({ "owner": owner, "agent": agent, "policy": a.policy }));
        a
    }

    fn fund_allowance(&mut self, owner: AccountId, amount: U128, agent: AccountId) -> PromiseOrValue<U128> {
        let key = (owner.clone(), agent.clone());
        let Some(mut a) = self.allowances.get(&key).cloned().filter(|a| !a.revoked) else {
            emit("fund_rejected", near_sdk::serde_json::json!({ "sender": owner, "amount": amount, "reason": "no active allowance for that agent" }));
            return PromiseOrValue::Value(amount);
        };
        a.balance = U128(a.balance.0 + amount.0);
        self.allowances.insert(key, a);
        emit("allowance_funded", near_sdk::serde_json::json!({ "owner": owner, "agent": agent, "amount": amount }));
        PromiseOrValue::Value(U128(0))
    }

    /// The agent (the caller) pays `to` from `owner`'s allowance, within its
    /// limits. `memo` ties the payment to an order (x402 uses the session id).
    pub fn agent_pay(&mut self, owner: AccountId, to: AccountId, amount: U128, memo: String) {
        let agent = env::predecessor_account_id();
        require!(memo.len() <= MAX_MEMO, "memo is at most 64 bytes");
        require!(to != env::current_account_id(), "cannot pay this contract");
        let key = (owner.clone(), agent.clone());
        let mut a = self.allowances.get(&key).cloned().unwrap_or_else(|| env::panic_str("no allowance for this agent"));
        let now = now_ms();
        a.check(&to, amount.0, now).unwrap_or_else(|e| env::panic_str(e));
        let day = a.spend(amount.0, now);
        self.allowances.insert(key, a);
        self.send(
            to.clone(),
            amount.0,
            memo.clone(),
            Self::ext(env::current_account_id()).with_static_gas(GAS_ON_LINE_SENT).on_agent_paid(owner, agent, to, amount, memo, day),
        );
    }

    #[private]
    pub fn on_agent_paid(
        &mut self,
        owner: AccountId,
        agent: AccountId,
        to: AccountId,
        amount: U128,
        memo: String,
        day: u64,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        let ok = result.is_ok();
        if !ok {
            let key = (owner.clone(), agent.clone());
            if let Some(mut a) = self.allowances.get(&key).cloned() {
                a.unspend(amount.0, day);
                self.allowances.insert(key, a);
            }
        }
        // Emitted only once the money arrived: what x402 verification reads.
        emit(
            if ok { "agent_payment" } else { "agent_payment_failed" },
            near_sdk::serde_json::json!({ "owner": owner, "agent": agent, "to": to, "amount": amount, "memo": memo }),
        );
        ok
    }

    /// The owner stops the agent at once; the unspent balance comes back.
    pub fn revoke_allowance(&mut self, agent: AccountId) {
        let owner = env::predecessor_account_id();
        let key = (owner.clone(), agent.clone());
        let mut a = self.allowances.get(&key).cloned().unwrap_or_else(|| env::panic_str("no allowance"));
        let balance = a.balance.0;
        a.revoked = true;
        a.balance = U128(0);
        self.allowances.insert(key, a);
        emit("revoke_allowance", near_sdk::serde_json::json!({ "owner": owner, "agent": agent, "returned": U128(balance) }));
        if balance > 0 {
            ext_ft::ext(self.token.clone())
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_FT_TRANSFER)
                .ft_transfer(owner.clone(), U128(balance), Some("cascade:allowance:revoked".into()))
                .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_REFUND).on_allowance_returned(owner, agent, U128(balance)))
                .detach();
        }
    }

    #[private]
    pub fn on_allowance_returned(&mut self, owner: AccountId, agent: AccountId, amount: U128, #[callback_result] result: Result<(), PromiseError>) -> bool {
        if result.is_err() {
            // Keep it safe in the (revoked) allowance; the owner can revoke again to retry.
            let key = (owner, agent);
            if let Some(mut a) = self.allowances.get(&key).cloned() {
                a.balance = U128(a.balance.0 + amount.0);
                self.allowances.insert(key, a);
            }
        }
        result.is_ok()
    }

    pub fn get_allowance(&self, owner: AccountId, agent: AccountId) -> Option<Allowance> {
        self.allowances.get(&(owner, agent)).cloned()
    }

    // ------------------------------------------------------------ views

    pub fn get_config(&self) -> Config {
        Config {
            admin: self.admin.clone(),
            settler: self.settler.clone(),
            token: self.token.clone(),
            dao_factory: self.dao_factory.clone(),
            storage_deposit: U128(self.storage_deposit.as_yoctonear()),
            next_invoice_id: self.next_invoice_id,
            next_batch_id: self.next_batch_id,
            next_split_id: self.next_split_id,
            next_escrow_id: self.next_escrow_id,
        }
    }

    pub fn get_owner(&self, id: AccountId) -> Option<Owner> {
        self.owners.get(&id).cloned()
    }

    pub fn get_invoice(&self, id: u64) -> Option<Invoice> {
        self.invoices.get(&id).cloned()
    }

    pub fn get_batch(&self, id: u64) -> Option<Batch> {
        self.batches.get(&id).cloned()
    }

    pub fn get_lines(&self, id: u64, from: Option<u32>, limit: Option<u32>) -> Vec<Line> {
        let Some(b) = self.batches.get(&id) else { return vec![] };
        let from = from.unwrap_or(0);
        let end = from.saturating_add(limit.unwrap_or(MAX_LINES as u32)).min(b.line_count);
        (from..end).filter_map(|i| self.lines.get(&(id, i)).cloned()).collect()
    }

    pub fn is_deposit_recorded(&self, deposit_address: String) -> bool {
        self.paid_deposits.contains(&deposit_address)
    }
}

#[cfg(test)]
mod tests;
