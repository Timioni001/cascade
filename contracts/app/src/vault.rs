//! Money the contract holds on someone's behalf, with the rules for letting
//! it go: milestone escrow and agent spending allowances. Pure types and
//! checks (no env calls), so every rule is unit-tested directly.

use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

pub const MAX_MILESTONES: usize = 20;
pub const MAX_TITLE: usize = 100;
pub const MIN_MILESTONE: u128 = 10_000; // 0.01 USDC
pub const MAX_PAYEES: usize = 20;
pub const MAX_MEMO: usize = 64;
/// What the owner tells the agent the money is for, in the owner's words.
pub const MAX_PURPOSE: usize = 140;
pub const DAY_MS: u64 = 86_400_000;
/// Refund window bounds: at least an hour, at most a year.
pub const MIN_REFUND_AFTER_MS: u64 = 3_600_000;
pub const MAX_REFUND_AFTER_MS: u64 = 365 * DAY_MS;

// ------------------------------------------------------------ escrow

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct MilestoneInput {
    pub title: String,
    pub amount: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MilestoneStatus {
    Pending,
    /// A transfer to the payee is in flight.
    Releasing,
    Released,
    /// A transfer back to the payer is in flight.
    Refunding,
    Refunded,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Milestone {
    pub title: String,
    pub amount: U128,
    pub status: MilestoneStatus,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EscrowStatus {
    AwaitingFunds,
    Funded,
    /// Every milestone released or refunded.
    Closed,
    /// Cancelled before it was funded.
    Cancelled,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Escrow {
    pub id: u64,
    /// Receives each milestone when it is released.
    pub payee: AccountId,
    /// Releases milestones; receives refunds.
    pub payer: AccountId,
    /// Optional third party who may release or refund any milestone (a DAO, a marketplace).
    pub arbiter: Option<AccountId>,
    pub milestones: Vec<Milestone>,
    pub total: U128,
    pub status: EscrowStatus,
    /// After this, anyone may return unreleased milestones to the payer.
    pub refund_after_ms: u64,
    /// Hash of the off-chain agreement (scope, deliverables).
    pub metadata_hash: String,
    pub created_by: AccountId,
    pub created_at_ms: u64,
    pub funded_by: Option<AccountId>,
}

pub fn validate_milestones(ms: &[MilestoneInput]) -> Result<u128, &'static str> {
    if ms.is_empty() || ms.len() > MAX_MILESTONES {
        return Err("1 to 20 milestones");
    }
    let mut total: u128 = 0;
    for m in ms {
        if m.title.is_empty() || m.title.len() > MAX_TITLE {
            return Err("milestone titles are 1-100 bytes");
        }
        if m.amount.0 < MIN_MILESTONE {
            return Err("each milestone is at least 0.01 USDC");
        }
        total = total.checked_add(m.amount.0).ok_or("total overflows")?;
    }
    Ok(total)
}

impl Escrow {
    /// The payer, or the arbiter, approves the work: pay this milestone to the payee.
    pub fn can_release(&self, who: &AccountId) -> bool {
        *who == self.payer || self.arbiter.as_ref() == Some(who)
    }

    /// The payee (giving money back), the arbiter, or anyone once the refund date has passed.
    pub fn can_refund(&self, who: &AccountId, now_ms: u64) -> bool {
        *who == self.payee || self.arbiter.as_ref() == Some(who) || now_ms >= self.refund_after_ms
    }

    /// Move milestone `idx` from Pending to `to` (Releasing or Refunding).
    pub fn start(&mut self, idx: usize, to: MilestoneStatus) -> Result<u128, &'static str> {
        if self.status != EscrowStatus::Funded {
            return Err("escrow is not funded");
        }
        let m = self.milestones.get_mut(idx).ok_or("no such milestone")?;
        if m.status != MilestoneStatus::Pending {
            return Err("milestone is not pending");
        }
        if to != MilestoneStatus::Releasing && to != MilestoneStatus::Refunding {
            return Err("bad transition");
        }
        m.status = to;
        Ok(m.amount.0)
    }

    /// A transfer finished: success makes it final, failure puts it back to Pending.
    pub fn finish(&mut self, idx: usize, ok: bool) {
        let Some(m) = self.milestones.get_mut(idx) else { return };
        m.status = match (m.status, ok) {
            (MilestoneStatus::Releasing, true) => MilestoneStatus::Released,
            (MilestoneStatus::Refunding, true) => MilestoneStatus::Refunded,
            (MilestoneStatus::Releasing | MilestoneStatus::Refunding, false) => MilestoneStatus::Pending,
            (s, _) => s,
        };
        if self.milestones.iter().all(|m| matches!(m.status, MilestoneStatus::Released | MilestoneStatus::Refunded)) {
            self.status = EscrowStatus::Closed;
        }
    }

    /// Money the contract still holds for this escrow.
    pub fn held(&self) -> u128 {
        if self.status == EscrowStatus::AwaitingFunds || self.status == EscrowStatus::Cancelled {
            return 0;
        }
        self.milestones
            .iter()
            .filter(|m| !matches!(m.status, MilestoneStatus::Released | MilestoneStatus::Refunded))
            .map(|m| m.amount.0)
            .sum()
    }
}

// ------------------------------------------------------------ agent allowances

/// What an agent may do with its owner's money.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct AllowancePolicy {
    pub per_payment_max: U128,
    /// Rolling per UTC day.
    pub daily_max: U128,
    pub expires_at_ms: u64,
    /// Empty: any recipient. Otherwise only these.
    pub payees: Vec<AccountId>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Allowance {
    pub owner: AccountId,
    pub agent: AccountId,
    pub balance: U128,
    pub policy: AllowancePolicy,
    /// UTC day index (ms / 86.4M) that `spent_today` counts.
    pub day: u64,
    pub spent_today: U128,
    pub total_spent: U128,
    pub payments: u64,
    pub revoked: bool,
    /// The mandate, in the owner's words ("Weather data for the Lisbon store"). Shown on every receipt the agent produces.
    pub purpose: String,
    /// When the owner last signed these limits (set_allowance is a transaction from the owner's own account).
    pub authorized_at_ms: u64,
}

pub fn validate_policy(p: &AllowancePolicy, now_ms: u64) -> Result<(), &'static str> {
    if p.per_payment_max.0 == 0 || p.daily_max.0 == 0 {
        return Err("limits must be positive");
    }
    if p.per_payment_max.0 > p.daily_max.0 {
        return Err("per-payment limit is above the daily limit");
    }
    if p.expires_at_ms <= now_ms {
        return Err("expiry is in the past");
    }
    if p.payees.len() > MAX_PAYEES {
        return Err("at most 20 payees");
    }
    Ok(())
}

impl Allowance {
    pub fn new(owner: AccountId, agent: AccountId, policy: AllowancePolicy, purpose: String, now_ms: u64) -> Self {
        Allowance {
            owner, agent, balance: U128(0), policy, day: 0, spent_today: U128(0), total_spent: U128(0), payments: 0, revoked: false,
            purpose, authorized_at_ms: now_ms,
        }
    }

    fn today_spent(&self, now_ms: u64) -> u128 {
        if now_ms / DAY_MS == self.day {
            self.spent_today.0
        } else {
            0
        }
    }

    /// Every rule an agent payment must pass. Checked before any money moves.
    pub fn check(&self, to: &AccountId, amount: u128, now_ms: u64) -> Result<(), &'static str> {
        if self.revoked {
            return Err("allowance revoked");
        }
        if now_ms >= self.policy.expires_at_ms {
            return Err("allowance expired");
        }
        if amount == 0 {
            return Err("amount must be positive");
        }
        if amount > self.policy.per_payment_max.0 {
            return Err("above the per-payment limit");
        }
        if self.today_spent(now_ms) + amount > self.policy.daily_max.0 {
            return Err("above the daily limit");
        }
        if amount > self.balance.0 {
            return Err("allowance balance too low");
        }
        if !self.policy.payees.is_empty() && !self.policy.payees.contains(to) {
            return Err("recipient not allowed");
        }
        Ok(())
    }

    /// Take `amount` (after `check`). Returns the day it was counted against.
    pub fn spend(&mut self, amount: u128, now_ms: u64) -> u64 {
        let day = now_ms / DAY_MS;
        self.spent_today = U128(self.today_spent(now_ms) + amount);
        self.day = day;
        self.balance = U128(self.balance.0 - amount);
        self.total_spent = U128(self.total_spent.0 + amount);
        self.payments += 1;
        day
    }

    /// The transfer failed: give the money and the daily room back.
    pub fn unspend(&mut self, amount: u128, day: u64) {
        self.balance = U128(self.balance.0 + amount);
        self.total_spent = U128(self.total_spent.0.saturating_sub(amount));
        self.payments = self.payments.saturating_sub(1);
        if self.day == day {
            self.spent_today = U128(self.spent_today.0.saturating_sub(amount));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn escrow() -> Escrow {
        Escrow {
            id: 0,
            payee: acc("studio.near"),
            payer: acc("client.near"),
            arbiter: Some(acc("market.near")),
            milestones: vec![
                Milestone { title: "Design".into(), amount: U128(400), status: MilestoneStatus::Pending },
                Milestone { title: "Build".into(), amount: U128(600), status: MilestoneStatus::Pending },
            ],
            total: U128(1000),
            status: EscrowStatus::Funded,
            refund_after_ms: 1_000,
            metadata_hash: "0".repeat(64),
            created_by: acc("studio.near"),
            created_at_ms: 0,
            funded_by: Some(acc("client.near")),
        }
    }

    #[test]
    fn milestones_are_validated() {
        let m = |t: &str, a: u128| MilestoneInput { title: t.into(), amount: U128(a) };
        assert_eq!(validate_milestones(&[m("a", 10_000), m("b", 20_000)]), Ok(30_000));
        assert!(validate_milestones(&[]).is_err());
        assert!(validate_milestones(&[m("", 10_000)]).is_err());
        assert!(validate_milestones(&[m("a", 9_999)]).is_err());
        assert!(validate_milestones(&vec![m("a", 10_000); 21]).is_err());
        assert!(validate_milestones(&[m("a", u128::MAX), m("b", u128::MAX)]).is_err());
    }

    #[test]
    fn only_payer_or_arbiter_release_refunds_need_payee_arbiter_or_the_deadline() {
        let e = escrow();
        assert!(e.can_release(&acc("client.near")));
        assert!(e.can_release(&acc("market.near")));
        assert!(!e.can_release(&acc("studio.near")));
        assert!(!e.can_release(&acc("mallory.near")));
        assert!(e.can_refund(&acc("studio.near"), 0));
        assert!(e.can_refund(&acc("market.near"), 0));
        assert!(!e.can_refund(&acc("client.near"), 999));
        assert!(e.can_refund(&acc("mallory.near"), 1_000));
    }

    #[test]
    fn a_milestone_moves_once_failures_return_it_and_the_escrow_closes() {
        let mut e = escrow();
        assert_eq!(e.held(), 1000);
        assert_eq!(e.start(0, MilestoneStatus::Releasing), Ok(400));
        assert!(e.start(0, MilestoneStatus::Releasing).is_err()); // no double release while in flight
        assert!(e.start(0, MilestoneStatus::Refunding).is_err());
        e.finish(0, false); // transfer failed: back to pending, money still held
        assert_eq!(e.milestones[0].status, MilestoneStatus::Pending);
        assert_eq!(e.held(), 1000);
        e.start(0, MilestoneStatus::Releasing).unwrap();
        e.finish(0, true);
        assert_eq!(e.held(), 600);
        assert!(e.start(0, MilestoneStatus::Refunding).is_err()); // released is final
        e.start(1, MilestoneStatus::Refunding).unwrap();
        e.finish(1, true);
        assert_eq!(e.status, EscrowStatus::Closed);
        assert_eq!(e.held(), 0);
        assert!(e.start(5, MilestoneStatus::Releasing).is_err());
    }

    #[test]
    fn unfunded_escrow_moves_nothing() {
        let mut e = escrow();
        e.status = EscrowStatus::AwaitingFunds;
        assert!(e.start(0, MilestoneStatus::Releasing).is_err());
        assert_eq!(e.held(), 0);
    }

    fn allowance() -> Allowance {
        let mut a = Allowance::new(
            acc("ada.near"),
            acc("agent.ada.near"),
            AllowancePolicy { per_payment_max: U128(100), daily_max: U128(250), expires_at_ms: 10 * DAY_MS, payees: vec![] },
            "Weather data".into(),
            0,
        );
        a.balance = U128(1_000);
        a
    }

    #[test]
    fn policy_is_validated() {
        let p = |per: u128, daily: u128, exp: u64| AllowancePolicy { per_payment_max: U128(per), daily_max: U128(daily), expires_at_ms: exp, payees: vec![] };
        assert!(validate_policy(&p(1, 2, 10), 5).is_ok());
        assert!(validate_policy(&p(0, 2, 10), 5).is_err());
        assert!(validate_policy(&p(3, 2, 10), 5).is_err());
        assert!(validate_policy(&p(1, 2, 5), 5).is_err());
    }

    #[test]
    fn agent_spending_respects_every_limit() {
        let mut a = allowance();
        let shop = acc("shop.near");
        let t = DAY_MS + 5;
        assert_eq!(a.check(&shop, 101, t), Err("above the per-payment limit"));
        a.spend(100, t);
        a.spend(100, t);
        assert_eq!(a.check(&shop, 60, t), Err("above the daily limit"));
        assert!(a.check(&shop, 50, t).is_ok());
        // Next UTC day: the daily room resets, the balance does not.
        assert!(a.check(&shop, 100, 2 * DAY_MS).is_ok());
        assert_eq!(a.balance.0, 800);
        assert_eq!(a.check(&shop, 0, t), Err("amount must be positive"));
        assert_eq!(a.check(&shop, 1, 10 * DAY_MS), Err("allowance expired"));
        a.revoked = true;
        assert_eq!(a.check(&shop, 1, t), Err("allowance revoked"));
    }

    #[test]
    fn payee_allowlist_and_balance() {
        let mut a = allowance();
        a.policy.payees = vec![acc("shop.near")];
        assert_eq!(a.check(&acc("other.near"), 1, 0), Err("recipient not allowed"));
        a.balance = U128(10);
        assert_eq!(a.check(&acc("shop.near"), 11, 0), Err("allowance balance too low"));
    }

    #[test]
    fn a_failed_payment_gives_back_balance_and_daily_room() {
        let mut a = allowance();
        let t = 3 * DAY_MS;
        let day = a.spend(100, t);
        a.unspend(100, day);
        assert_eq!((a.balance.0, a.spent_today.0, a.total_spent.0, a.payments), (1_000, 0, 0, 0));
        // A failure reported on a later day does not touch the new day's count.
        let day = a.spend(100, t);
        a.spend(50, t + DAY_MS);
        a.unspend(100, day);
        assert_eq!((a.balance.0, a.spent_today.0), (950, 50));
    }
}
