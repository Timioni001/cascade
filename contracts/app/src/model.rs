//! Plain data types and the pure state machine for batches and lines.
//!
//! Nothing in this module touches `env`, storage or promises. Every way a line
//! can change state goes through [`Batch::transition`], which moves the line's
//! amount from one money bucket to another and then checks that the buckets
//! still add up to the batch total. That single choke point is what makes the
//! safety rules ("no line paid twice", "Sent + Refunded + Queued == total")
//! testable without a blockchain.

use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

/// A person (`Account`) or a team (`Dao`, a Sputnik DAO account).
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OwnerKind {
    Account,
    Dao,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Owner {
    pub id: AccountId,
    pub kind: OwnerKind,
    /// Accounts allowed to prepare invoices and batches for this owner.
    /// For a DAO these are typically members of its `finance` role.
    /// Preparers can never move money: funding always comes from the owner.
    pub preparers: Vec<AccountId>,
    /// The NEP-141 token this owner is paid in (USDC on NEAR).
    pub token: AccountId,
}

impl Owner {
    pub fn can_prepare(&self, who: &AccountId) -> bool {
        &self.id == who || self.preparers.iter().any(|p| p == who)
    }
}

// ---------------------------------------------------------------- invoices

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InvoiceStatus {
    Open,
    Paid,
    Void,
}

/// Where an invoice came from. `Link` receipts are created by the settler when
/// someone pays an owner's public payment link without a prior invoice.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InvoiceSource {
    Invoice,
    Link,
}

/// What the settler observed when 1Click delivered the money.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settlement {
    /// The one-time 1Click deposit address the payer sent to.
    pub deposit_address: String,
    /// USDC (base units) that arrived in the owner's account.
    pub amount_out: U128,
    /// Transaction hash on NEAR that delivered the USDC.
    pub dest_tx: String,
    pub settled_at_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invoice {
    pub id: u64,
    pub owner: AccountId,
    pub amount: U128,
    pub status: InvoiceStatus,
    pub source: InvoiceSource,
    /// Hex SHA-256 of the off-chain invoice document (client, line items, due
    /// date). Personal details stay off-chain; the hash proves they were not
    /// changed after the invoice was issued.
    pub metadata_hash: String,
    pub created_by: AccountId,
    pub created_at_ms: u64,
    pub settlement: Option<Settlement>,
}

// ---------------------------------------------------------------- batches

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineKind {
    /// Plain USDC transfer to a NEAR account.
    Near,
    /// USDC sent to a 1Click deposit address that delivers on another chain.
    CrossChain,
    /// Like `CrossChain`, but the 1Click order uses Confidential Intents.
    Private,
}

/// One payment line as submitted by the preparer. This exact structure, Borsh
/// encoded as `Vec<LineInput>`, is what the batch hash commits to.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LineInput {
    /// NEAR account that receives the `ft_transfer`. For cross-chain and
    /// private lines this is the 1Click deposit address (an implicit account).
    pub recipient: AccountId,
    pub amount: U128,
    pub kind: LineKind,
    /// Human-readable final destination, e.g. `sol:7xKX...`. Display only.
    pub dest: Option<String>,
    /// For quoted lines: the 1Click quote deadline (ms since epoch). The
    /// contract refuses to pay a deposit address after its quote expired.
    pub deadline_ms: Option<u64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineStatus {
    Queued,
    /// `ft_transfer` dispatched, callback not yet received. A line in flight
    /// can never be dispatched again.
    InFlight,
    Sent,
    Failed,
    /// Refund transfer to the owner dispatched, callback not yet received.
    Refunding,
    Refunded,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Line {
    pub recipient: AccountId,
    pub amount: U128,
    pub kind: LineKind,
    pub dest: Option<String>,
    pub deadline_ms: Option<u64>,
    pub status: LineStatus,
    pub note: Option<String>,
}

impl From<LineInput> for Line {
    fn from(i: LineInput) -> Self {
        Line {
            recipient: i.recipient,
            amount: i.amount,
            kind: i.kind,
            dest: i.dest,
            deadline_ms: i.deadline_ms,
            status: LineStatus::Queued,
            note: None,
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BatchStatus {
    /// Lines are locked, waiting for the owner (or its DAO) to fund.
    Draft,
    /// Exactly `total` USDC received from the owner.
    Funded,
    /// Some lines dispatched or awaiting refund.
    Executing,
    /// Every line Sent.
    Done,
    /// Nothing left to do; at least one line was refunded to the owner.
    PartlyRefunded,
    /// Cancelled before funding. No money was ever held.
    Cancelled,
}

/// How much of the batch total currently sits in each line status.
/// Invariant: the six buckets always add up to `Batch::total`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Buckets {
    pub queued: U128,
    pub in_flight: U128,
    pub sent: U128,
    pub failed: U128,
    pub refunding: U128,
    pub refunded: U128,
}

impl Buckets {
    fn slot(&mut self, s: LineStatus) -> &mut U128 {
        match s {
            LineStatus::Queued => &mut self.queued,
            LineStatus::InFlight => &mut self.in_flight,
            LineStatus::Sent => &mut self.sent,
            LineStatus::Failed => &mut self.failed,
            LineStatus::Refunding => &mut self.refunding,
            LineStatus::Refunded => &mut self.refunded,
        }
    }

    pub fn sum(&self) -> u128 {
        [
            self.queued.0,
            self.in_flight.0,
            self.sent.0,
            self.failed.0,
            self.refunding.0,
            self.refunded.0,
        ]
        .iter()
        .try_fold(0u128, |acc, v| acc.checked_add(*v))
        .expect("bucket overflow")
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Batch {
    pub id: u64,
    pub owner: AccountId,
    /// Hex SHA-256 of Borsh(`Vec<LineInput>`).
    pub hash: String,
    pub total: U128,
    pub line_count: u32,
    pub status: BatchStatus,
    /// Next line index `execute_batch` will look at.
    pub cursor: u32,
    /// Sputnik proposal that funds this batch (team mode, informational).
    pub proposal_id: Option<u64>,
    pub created_by: AccountId,
    pub created_at_ms: u64,
    pub buckets: Buckets,
}

// ---------------------------------------------------------------- splits

/// One recipient's share of a split, in basis points (1/100 of a percent).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Share {
    pub account: AccountId,
    pub bps: u16,
}

/// A standing revenue split: every payment sent to it (with
/// `msg = {"split": id}`) is divided between `shares` and paid out at once.
/// Immutable once created, so a payer always gets the split they were shown.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SplitRule {
    pub id: u64,
    pub owner: AccountId,
    pub shares: Vec<Share>,
    pub created_by: AccountId,
    pub created_at_ms: u64,
}

pub const MAX_SHARES: usize = 10;
pub const BPS_TOTAL: u32 = 10_000;

/// Check a split: 1-10 shares, each > 0 bps, distinct accounts, adding up to 100%.
pub fn validate_shares(shares: &[Share]) -> Result<(), &'static str> {
    if shares.is_empty() || shares.len() > MAX_SHARES {
        return Err("a split needs 1-10 shares");
    }
    let mut total: u32 = 0;
    for (i, s) in shares.iter().enumerate() {
        if s.bps == 0 {
            return Err("every share must be above 0");
        }
        if shares[..i].iter().any(|o| o.account == s.account) {
            return Err("each account may appear once");
        }
        total += s.bps as u32;
    }
    if total != BPS_TOTAL {
        return Err("shares must add up to 10000 bps (100%)");
    }
    Ok(())
}

/// Divide `amount` by the shares, rounding down; the rounding remainder goes
/// to the first share. The parts always add up to exactly `amount`.
pub fn split_amount(amount: u128, shares: &[Share]) -> Vec<u128> {
    let mut parts: Vec<u128> = shares.iter().map(|s| amount / BPS_TOTAL as u128 * s.bps as u128 + amount % BPS_TOTAL as u128 * s.bps as u128 / BPS_TOTAL as u128).collect();
    let assigned: u128 = parts.iter().sum();
    if let Some(first) = parts.first_mut() {
        *first += amount - assigned;
    }
    parts
}

#[derive(Debug, PartialEq, Eq)]
pub enum TransitionError {
    NotAllowed { from: LineStatus, to: LineStatus },
    BatchNotFunded(BatchStatus),
}

impl core::fmt::Display for TransitionError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            TransitionError::NotAllowed { from, to } => {
                write!(f, "line cannot move from {:?} to {:?}", from, to)
            }
            TransitionError::BatchNotFunded(s) => write!(f, "batch is {:?}, not funded", s),
        }
    }
}

/// The complete list of legal line moves. Anything else is a bug or an attack.
pub fn allowed(from: LineStatus, to: LineStatus) -> bool {
    use LineStatus::*;
    matches!(
        (from, to),
        (Queued, InFlight)      // dispatched
            | (Queued, Failed)  // quote expired before we paid
            | (InFlight, Sent)  // ft_transfer succeeded
            | (InFlight, Failed) // ft_transfer failed, money is back with us
            | (Failed, Refunding)
            | (Refunding, Refunded)
            | (Refunding, Failed) // refund transfer failed, try again later
    )
}

impl Batch {
    pub fn new(
        id: u64,
        owner: AccountId,
        hash: String,
        total: u128,
        line_count: u32,
        created_by: AccountId,
        now_ms: u64,
    ) -> Self {
        Batch {
            id,
            owner,
            hash,
            total: U128(total),
            line_count,
            status: BatchStatus::Draft,
            cursor: 0,
            proposal_id: None,
            created_by,
            created_at_ms: now_ms,
            buckets: Buckets {
                queued: U128(total),
                ..Default::default()
            },
        }
    }

    pub fn is_funded(&self) -> bool {
        matches!(self.status, BatchStatus::Funded | BatchStatus::Executing)
    }

    /// Move `line` to `to`, keeping the money buckets consistent.
    ///
    /// Lines can only leave `Queued` once the batch is funded. That rule plus
    /// the transition table is what guarantees a line is paid at most once.
    pub fn transition(&mut self, line: &mut Line, to: LineStatus) -> Result<(), TransitionError> {
        let from = line.status;
        if !allowed(from, to) {
            return Err(TransitionError::NotAllowed { from, to });
        }
        if !self.is_funded() {
            return Err(TransitionError::BatchNotFunded(self.status));
        }
        let amt = line.amount.0;
        let src = self.buckets.slot(from);
        src.0 = src.0.checked_sub(amt).expect("bucket underflow");
        let dst = self.buckets.slot(to);
        dst.0 = dst.0.checked_add(amt).expect("bucket overflow");
        line.status = to;
        self.check_invariant();
        self.refresh_status();
        Ok(())
    }

    /// Panics if the buckets no longer add up to the total. Called after every
    /// change; it is cheap and turns any accounting bug into a reverted call.
    pub fn check_invariant(&self) {
        assert_eq!(
            self.buckets.sum(),
            self.total.0,
            "invariant broken: line buckets do not add up to the batch total"
        );
    }

    fn refresh_status(&mut self) {
        if !self.is_funded() {
            return;
        }
        let b = &self.buckets;
        let pending = b.queued.0 + b.in_flight.0 + b.failed.0 + b.refunding.0;
        self.status = if pending > 0 {
            BatchStatus::Executing
        } else if b.refunded.0 > 0 {
            BatchStatus::PartlyRefunded
        } else {
            BatchStatus::Done
        };
    }

    pub fn mark_funded(&mut self) {
        assert_eq!(self.status, BatchStatus::Draft, "batch is not a draft");
        self.status = BatchStatus::Funded;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn line(amount: u128) -> Line {
        Line::from(LineInput {
            recipient: acc("bob.near"),
            amount: U128(amount),
            kind: LineKind::Near,
            dest: None,
            deadline_ms: None,
        })
    }

    fn funded(total: u128) -> Batch {
        let mut b = Batch::new(0, acc("ada.near"), "00".into(), total, 2, acc("ada.near"), 0);
        b.mark_funded();
        b
    }

    #[test]
    fn transition_table_is_exhaustive_and_closed() {
        use LineStatus::*;
        let all = [Queued, InFlight, Sent, Failed, Refunding, Refunded];
        let mut legal = 0;
        for f in all {
            for t in all {
                if allowed(f, t) {
                    legal += 1;
                }
            }
        }
        assert_eq!(legal, 7, "update this test when the table changes on purpose");
        // Terminal states never move.
        for t in all {
            assert!(!allowed(Sent, t));
            assert!(!allowed(Refunded, t));
        }
    }

    #[test]
    fn a_sent_line_can_never_be_sent_again() {
        let mut b = funded(10);
        let mut l = line(10);
        b.transition(&mut l, LineStatus::InFlight).unwrap();
        assert!(b.transition(&mut l, LineStatus::InFlight).is_err());
        b.transition(&mut l, LineStatus::Sent).unwrap();
        for to in [LineStatus::InFlight, LineStatus::Queued, LineStatus::Failed] {
            assert!(b.transition(&mut l, to).is_err());
        }
        assert_eq!(b.status, BatchStatus::Done);
    }

    #[test]
    fn nothing_moves_before_funding() {
        let mut b = Batch::new(0, acc("ada.near"), "00".into(), 10, 1, acc("ada.near"), 0);
        let mut l = line(10);
        assert_eq!(
            b.transition(&mut l, LineStatus::InFlight),
            Err(TransitionError::BatchNotFunded(BatchStatus::Draft))
        );
        assert_eq!(l.status, LineStatus::Queued);
    }

    #[test]
    fn buckets_track_every_move_and_status_follows() {
        let mut b = funded(30);
        let mut a = line(10);
        let mut c = line(20);
        b.transition(&mut a, LineStatus::InFlight).unwrap();
        b.transition(&mut c, LineStatus::InFlight).unwrap();
        b.transition(&mut a, LineStatus::Sent).unwrap();
        b.transition(&mut c, LineStatus::Failed).unwrap();
        assert_eq!(b.status, BatchStatus::Executing);
        b.transition(&mut c, LineStatus::Refunding).unwrap();
        // refund transfer bounced once
        b.transition(&mut c, LineStatus::Failed).unwrap();
        b.transition(&mut c, LineStatus::Refunding).unwrap();
        b.transition(&mut c, LineStatus::Refunded).unwrap();
        assert_eq!(b.buckets.sent.0, 10);
        assert_eq!(b.buckets.refunded.0, 20);
        assert_eq!(b.buckets.sum(), 30);
        assert_eq!(b.status, BatchStatus::PartlyRefunded);
    }

    fn share(a: &str, bps: u16) -> Share {
        Share { account: acc(a), bps }
    }

    #[test]
    fn split_validation() {
        assert!(validate_shares(&[share("a.near", 7000), share("b.near", 3000)]).is_ok());
        assert!(validate_shares(&[]).is_err());
        assert!(validate_shares(&[share("a.near", 9999)]).is_err());
        assert!(validate_shares(&[share("a.near", 5000), share("a.near", 5000)]).is_err());
        assert!(validate_shares(&[share("a.near", 10000), share("b.near", 0)]).is_err());
        let eleven: Vec<Share> = (0..11).map(|i| share(&format!("a{i}.near"), if i == 0 { 9000 } else { 100 })).collect();
        assert!(validate_shares(&eleven).is_err());
    }

    #[test]
    fn split_parts_always_add_up_and_never_overflow() {
        let shares = [share("shop.near", 7000), share("designer.near", 2000), share("dao.sputnik-dao.near", 1000)];
        assert_eq!(split_amount(25_000_000, &shares), vec![17_500_000, 5_000_000, 2_500_000]);
        // 1/3 splits leave a remainder: it goes to the first share.
        let thirds = [share("a.near", 3334), share("b.near", 3333), share("c.near", 3333)];
        assert_eq!(split_amount(10, &thirds), vec![4, 3, 3]);
        let mut seed: u64 = 7;
        for _ in 0..2000 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let amount = (seed as u128) * (seed as u128 % 1_000_003);
            let p = split_amount(amount, &thirds);
            assert_eq!(p.iter().sum::<u128>(), amount);
        }
        assert_eq!(split_amount(u128::MAX, &thirds).iter().fold(0u128, |a, b| a.checked_add(*b).unwrap()), u128::MAX);
    }

    /// Deterministic pseudo-random walk over legal moves: the invariant must
    /// hold after every single step, whatever order things happen in.
    #[test]
    fn invariant_holds_under_random_walks() {
        let mut seed: u64 = 0x9e3779b97f4a7c15;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        use LineStatus::*;
        let all = [Queued, InFlight, Sent, Failed, Refunding, Refunded];
        for _ in 0..200 {
            let n = (next() % 12 + 1) as usize;
            let mut lines: Vec<Line> = (0..n).map(|_| line((next() % 1_000_000 + 1) as u128)).collect();
            let total: u128 = lines.iter().map(|l| l.amount.0).sum();
            let mut b = funded(total);
            for _ in 0..100 {
                let i = (next() as usize) % n;
                let to = all[(next() as usize) % all.len()];
                let before = lines[i].status;
                let r = b.transition(&mut lines[i], to);
                assert_eq!(r.is_ok(), allowed(before, to));
                assert_eq!(b.buckets.sum(), total);
                let recount: u128 = lines
                    .iter()
                    .filter(|l| l.status == Sent)
                    .map(|l| l.amount.0)
                    .sum();
                assert_eq!(recount, b.buckets.sent.0);
            }
        }
    }
}
