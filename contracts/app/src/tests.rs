//! Unit tests for the contract bindings. Each safety rule from the README has
//! at least one test here; the sandbox suite (contracts/tests) repeats the
//! important ones against real receipts, the real Sputnik DAO and a mock USDC.

use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const USDC: &str = "usdc.near";
const APP: &str = "app.cascade.near";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(predecessor: &str) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(APP))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .block_timestamp(1_700_000_000_000_000_000)
        .prepaid_gas(Gas::from_tgas(300))
        .account_balance(NearToken::from_near(10));
    b
}

fn as_caller(who: &str) {
    testing_env!(ctx(who).build());
}

fn with_result(who: &str, ok: bool) {
    let r = if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed };
    testing_env!(ctx(who).build(), near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![r]);
}

fn setup() -> Cascade {
    as_caller("admin.near");
    let mut c = Cascade::new(acc("admin.near"), acc("settler.near"), acc(USDC), acc("sputnik-dao.near"), None);
    as_caller("ada.near");
    c.register_owner(OwnerKind::Account, vec![]);
    c
}

fn near_line(to: &str, amount: u128) -> LineInput {
    LineInput { recipient: acc(to), amount: U128(amount), kind: LineKind::Near, dest: None, deadline_ms: None }
}

fn fund(c: &mut Cascade, from: &str, b: &CreatedBatch) -> U128 {
    as_caller(USDC);
    let msg = format!(r#"{{"batch_id":{},"hash":"{}"}}"#, b.id, b.hash);
    match c.ft_on_transfer(acc(from), b.total, msg) {
        PromiseOrValue::Value(v) => v,
        _ => panic!("expected a value"),
    }
}

fn two_line_batch(c: &mut Cascade) -> CreatedBatch {
    as_caller("ada.near");
    c.create_batch(acc("ada.near"), vec![near_line("bob.near", 10), near_line("eve.near", 20)])
}

// ------------------------------------------------------------ rule 1

#[test]
fn rule1_no_line_is_paid_before_the_batch_is_funded() {
    let mut c = setup();
    let b = two_line_batch(&mut c);
    as_caller("anyone.near");
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.execute_batch(b.id, 8)));
    assert!(r.is_err(), "executing a draft must panic");
    assert!(c.get_lines(b.id, None, None).iter().all(|l| l.status == LineStatus::Queued));
}

#[test]
fn rule1_no_line_is_ever_paid_twice() {
    let mut c = setup();
    let b = two_line_batch(&mut c);
    assert_eq!(fund(&mut c, "ada.near", &b).0, 0);

    as_caller("anyone.near");
    assert_eq!(c.execute_batch(b.id, 8), 2);
    // A second crank before callbacks land must not dispatch anything again.
    as_caller("someone-else.near");
    assert_eq!(c.execute_batch(b.id, 8), 0);
    assert!(c.get_lines(b.id, None, None).iter().all(|l| l.status == LineStatus::InFlight));

    with_result(APP, true);
    assert!(c.on_line_sent(b.id, 0, Ok(())));
    // A duplicated callback for the same line is rejected.
    with_result(APP, true);
    let dup = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.on_line_sent(b.id, 0, Ok(()))));
    assert!(dup.is_err());
    assert_eq!(c.get_batch(b.id).unwrap().buckets.sent.0, 10);
}

// ------------------------------------------------------------ rule 2

#[test]
fn rule2_only_the_owner_can_fund_a_personal_batch() {
    let mut c = setup();
    let b = two_line_batch(&mut c);
    assert_eq!(fund(&mut c, "mallory.near", &b), b.total, "everything goes back");
    assert_eq!(c.get_batch(b.id).unwrap().status, BatchStatus::Draft);
    assert_eq!(fund(&mut c, "ada.near", &b).0, 0);
    assert_eq!(c.get_batch(b.id).unwrap().status, BatchStatus::Funded);
}

#[test]
fn rule2_only_the_dao_can_fund_a_team_batch() {
    let mut c = setup();
    let dao = "studio.sputnik-dao.near";
    as_caller(dao);
    c.register_owner(OwnerKind::Dao, vec![acc("ada.near")]);
    // ada is a preparer: she can create the batch...
    as_caller("ada.near");
    let b = c.create_batch(acc(dao), vec![near_line("bob.near", 5)]);
    // ...but cannot fund it herself, even with the right amount and hash.
    assert_eq!(fund(&mut c, "ada.near", &b), b.total);
    assert_eq!(c.get_batch(b.id).unwrap().status, BatchStatus::Draft);
    assert_eq!(fund(&mut c, dao, &b).0, 0);
    assert_eq!(c.get_batch(b.id).unwrap().status, BatchStatus::Funded);
}

#[test]
fn rule2_a_dao_owner_must_be_a_sputnik_account() {
    let mut c = setup();
    as_caller("fake-dao.near");
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.register_owner(OwnerKind::Dao, vec![]);
    }));
    assert!(r.is_err());
}

#[test]
fn non_preparers_cannot_create_batches_or_invoices() {
    let mut c = setup();
    as_caller("mallory.near");
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.create_batch(acc("ada.near"), vec![near_line("mallory.near", 1)]);
    }));
    assert!(r.is_err());
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.create_invoice(acc("ada.near"), U128(1), "a".repeat(64));
    }));
    assert!(r.is_err());
}

// ------------------------------------------------------------ rule 3

#[test]
fn rule3_wrong_amount_or_hash_or_token_returns_everything() {
    let mut c = setup();
    let b = two_line_batch(&mut c);

    as_caller(USDC);
    let wrong_amount = format!(r#"{{"batch_id":{},"hash":"{}"}}"#, b.id, b.hash);
    match c.ft_on_transfer(acc("ada.near"), U128(b.total.0 - 1), wrong_amount) {
        PromiseOrValue::Value(v) => assert_eq!(v.0, b.total.0 - 1),
        _ => panic!(),
    }
    let wrong_hash = format!(r#"{{"batch_id":{},"hash":"{}"}}"#, b.id, "0".repeat(64));
    match c.ft_on_transfer(acc("ada.near"), b.total, wrong_hash) {
        PromiseOrValue::Value(v) => assert_eq!(v, b.total),
        _ => panic!(),
    }
    match c.ft_on_transfer(acc("ada.near"), b.total, "not json".into()) {
        PromiseOrValue::Value(v) => assert_eq!(v, b.total),
        _ => panic!(),
    }
    // Right everything, but called by a different token contract.
    as_caller("fake-usdc.near");
    let ok_msg = format!(r#"{{"batch_id":{},"hash":"{}"}}"#, b.id, b.hash);
    match c.ft_on_transfer(acc("ada.near"), b.total, ok_msg) {
        PromiseOrValue::Value(v) => assert_eq!(v, b.total),
        _ => panic!(),
    }
    assert_eq!(c.get_batch(b.id).unwrap().status, BatchStatus::Draft);
    // Funding twice: the second transfer is returned in full.
    assert_eq!(fund(&mut c, "ada.near", &b).0, 0);
    assert_eq!(fund(&mut c, "ada.near", &b), b.total);
}

// ------------------------------------------------------------ rule 4

#[test]
fn rule4_buckets_always_add_up_through_failure_and_refund() {
    let mut c = setup();
    let b = two_line_batch(&mut c);
    fund(&mut c, "ada.near", &b);
    as_caller("anyone.near");
    c.execute_batch(b.id, 8);
    let check = |c: &Cascade| {
        let batch = c.get_batch(b.id).unwrap();
        assert_eq!(batch.buckets.sum(), batch.total.0);
        let lines = c.get_lines(b.id, None, None);
        let by = |s: LineStatus| lines.iter().filter(|l| l.status == s).map(|l| l.amount.0).sum::<u128>();
        assert_eq!(by(LineStatus::Sent), batch.buckets.sent.0);
        assert_eq!(by(LineStatus::Refunded), batch.buckets.refunded.0);
        assert_eq!(by(LineStatus::Queued), batch.buckets.queued.0);
    };
    check(&c);
    with_result(APP, true);
    c.on_line_sent(b.id, 0, Ok(()));
    check(&c);
    with_result(APP, false);
    c.on_line_sent(b.id, 1, Err(PromiseError::Failed));
    check(&c);
    assert_eq!(c.get_batch(b.id).unwrap().status, BatchStatus::Executing);

    as_caller("anyone.near");
    let _ = c.refund_failed(b.id);
    check(&c);
    // A refund transfer that bounces puts the line back to Failed.
    with_result(APP, false);
    c.on_refund(b.id, vec![1], Err(PromiseError::Failed));
    check(&c);
    as_caller("anyone.near");
    let _ = c.refund_failed(b.id);
    with_result(APP, true);
    c.on_refund(b.id, vec![1], Ok(()));
    check(&c);
    let batch = c.get_batch(b.id).unwrap();
    assert_eq!(batch.status, BatchStatus::PartlyRefunded);
    assert_eq!(batch.buckets.sent.0 + batch.buckets.refunded.0, batch.total.0);
}

#[test]
fn expired_quotes_are_never_paid_and_can_be_refunded() {
    let mut c = setup();
    as_caller("ada.near");
    let now_ms = 1_700_000_000_000u64;
    let quoted = LineInput {
        recipient: acc("a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"),
        amount: U128(7),
        kind: LineKind::CrossChain,
        dest: Some("sol:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU".into()),
        deadline_ms: Some(now_ms + 1000),
    };
    let b = c.create_batch(acc("ada.near"), vec![quoted]);
    fund(&mut c, "ada.near", &b);
    // Two seconds later the quote is dead.
    let mut late = ctx("anyone.near");
    late.block_timestamp((now_ms + 2000) * 1_000_000);
    testing_env!(late.build());
    assert_eq!(c.execute_batch(b.id, 8), 0);
    let l = &c.get_lines(b.id, None, None)[0];
    assert_eq!(l.status, LineStatus::Failed);
    assert_eq!(c.get_batch(b.id).unwrap().buckets.failed.0, 7);
}

#[test]
fn quoted_lines_need_a_deadline() {
    let mut c = setup();
    as_caller("ada.near");
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.create_batch(
            acc("ada.near"),
            vec![LineInput { recipient: acc("bob.near"), amount: U128(1), kind: LineKind::CrossChain, dest: None, deadline_ms: None }],
        );
    }));
    assert!(r.is_err());
}

// ------------------------------------------------------------ invoices

#[test]
fn invoices_settler_only_and_each_deposit_recorded_once() {
    let mut c = setup();
    as_caller("ada.near");
    let inv = c.create_invoice(acc("ada.near"), U128(100), "ab".repeat(32));
    assert_eq!(inv.status, InvoiceStatus::Open);

    as_caller("ada.near");
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.mark_invoice_paid(inv.id, "dep1".into(), U128(100), "tx".into());
    }));
    assert!(r.is_err(), "owners cannot mark their own invoices paid");

    as_caller("settler.near");
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.mark_invoice_paid(inv.id, "dep1".into(), U128(99), "tx".into());
    }));
    assert!(r.is_err(), "underpayment is refused");

    as_caller("settler.near");
    let paid = c.mark_invoice_paid(inv.id, "dep1".into(), U128(100), "tx".into());
    assert_eq!(paid.status, InvoiceStatus::Paid);
    assert!(c.is_deposit_recorded("dep1".into()));

    // The same deposit cannot be counted again, for an invoice or a link.
    as_caller("settler.near");
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.record_link_payment(acc("ada.near"), "dep1".into(), U128(5), "tx2".into(), "cd".repeat(32));
    }));
    assert!(r.is_err());
    as_caller("settler.near");
    let link = c.record_link_payment(acc("ada.near"), "dep2".into(), U128(5), "tx2".into(), "cd".repeat(32));
    assert_eq!(link.source, InvoiceSource::Link);
    assert_eq!(link.status, InvoiceStatus::Paid);
}

#[test]
fn void_only_open_invoices() {
    let mut c = setup();
    as_caller("ada.near");
    let inv = c.create_invoice(acc("ada.near"), U128(1), "ab".repeat(32));
    as_caller("ada.near");
    assert_eq!(c.void_invoice(inv.id).status, InvoiceStatus::Void);
    as_caller("settler.near");
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.mark_invoice_paid(inv.id, "d".into(), U128(1), "t".into());
    }));
    assert!(r.is_err());
}

/// Fixed vector shared with packages/core/test/hash.test.ts. If you change the
/// line encoding, both tests must change together.
#[test]
fn line_hash_vector() {
    as_caller("ada.near");
    let lines = vec![
        near_line("bob.near", 1_500_000),
        LineInput {
            recipient: acc("a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"),
            amount: U128(250_000_000),
            kind: LineKind::Private,
            dest: Some("base:0x2527D02599Ba641c19FEa793cD0F167589a0f10D".into()),
            deadline_ms: Some(1_800_000_000_000),
        },
    ];
    let h = hash_lines(&lines);
    println!("LINE_HASH_VECTOR={h}");
    assert_eq!(h, include_str!("../../../packages/core/test/line-hash-vector.txt").trim());
}

// ------------------------------------------------------------ splits

fn split_msg(id: u64) -> String {
    format!(r#"{{"split":{id}}}"#)
}

#[test]
fn split_payments_become_funded_batches_that_add_up() {
    let mut c = setup();
    as_caller("ada.near");
    let rule = c.create_split(
        acc("ada.near"),
        vec![Share { account: acc("ada.near"), bps: 7000 }, Share { account: acc("bob.near"), bps: 2000 }, Share { account: acc("team.sputnik-dao.near"), bps: 1000 }],
    );
    // Anyone may pay into a split, e.g. intents.near delivering a checkout payment.
    as_caller(USDC);
    match c.ft_on_transfer(acc("intents.near"), U128(25_000_000), split_msg(rule.id)) {
        PromiseOrValue::Value(v) => assert_eq!(v.0, 0),
        _ => panic!(),
    }
    let b = c.get_batch(0).unwrap();
    assert_eq!(b.status, BatchStatus::Funded);
    assert_eq!(b.owner, acc("ada.near"));
    assert_eq!(b.total.0, 25_000_000);
    let lines = c.get_lines(0, None, None);
    let amounts: Vec<u128> = lines.iter().map(|l| l.amount.0).collect();
    assert_eq!(amounts, vec![17_500_000, 5_000_000, 2_500_000]);
    assert_eq!(b.hash, hash_lines(&lines.iter().map(|l| LineInput { recipient: l.recipient.clone(), amount: l.amount, kind: l.kind, dest: None, deadline_ms: None }).collect::<Vec<_>>()));
    // It pays out like any batch.
    as_caller("anyone.near");
    assert_eq!(c.execute_batch(0, 8), 3);
}

#[test]
fn split_rejections_return_everything() {
    let mut c = setup();
    as_caller("ada.near");
    let rule = c.create_split(acc("ada.near"), vec![Share { account: acc("ada.near"), bps: 10000 }]);
    as_caller(USDC);
    for (amt, msg) in [(1_000_000u128, split_msg(99)), (9_999, split_msg(rule.id)), (1_000_000, r#"{"split":0,"x":1}"#.to_string())] {
        match c.ft_on_transfer(acc("payer.near"), U128(amt), msg) {
            PromiseOrValue::Value(v) => assert_eq!(v.0, amt),
            _ => panic!(),
        }
    }
    as_caller("fake-usdc.near");
    match c.ft_on_transfer(acc("payer.near"), U128(1_000_000), split_msg(rule.id)) {
        PromiseOrValue::Value(v) => assert_eq!(v.0, 1_000_000),
        _ => panic!(),
    }
    assert!(c.get_batch(0).is_none());
}

#[test]
fn only_owner_or_preparer_creates_valid_splits() {
    let mut c = setup();
    as_caller("mallory.near");
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.create_split(acc("ada.near"), vec![Share { account: acc("mallory.near"), bps: 10000 }]);
    }));
    assert!(r.is_err());
    as_caller("ada.near");
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.create_split(acc("ada.near"), vec![Share { account: acc("ada.near"), bps: 5000 }]);
    }));
    assert!(r.is_err(), "shares must add up to 100%");
}

// ------------------------------------------------------------ escrow

const NOW_MS: u64 = 1_700_000_000_000;

fn transfer(c: &mut Cascade, from: &str, amount: u128, msg: String) -> u128 {
    as_caller(USDC);
    match c.ft_on_transfer(acc(from), U128(amount), msg) {
        PromiseOrValue::Value(v) => v.0,
        _ => panic!("expected a value"),
    }
}

fn panics(f: impl FnOnce()) -> bool {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err()
}

fn milestone(title: &str, amount: u128) -> MilestoneInput {
    MilestoneInput { title: title.into(), amount: U128(amount) }
}

fn escrow(c: &mut Cascade) -> Escrow {
    as_caller("ada.near");
    c.create_escrow(
        acc("ada.near"),
        acc("client.near"),
        None,
        vec![milestone("Design", 400_000), milestone("Build", 600_000)],
        NOW_MS + 30 * 86_400_000,
        "a".repeat(64),
    )
}

#[test]
fn escrow_is_created_by_a_party_and_funded_for_exactly_its_total() {
    let mut c = setup();
    as_caller("mallory.near");
    assert!(panics(|| {
        c.create_escrow(acc("ada.near"), acc("client.near"), None, vec![milestone("x", 10_000)], NOW_MS + 7_200_000, "a".repeat(64));
    }));
    as_caller("ada.near");
    assert!(panics(|| {
        c.create_escrow(acc("ada.near"), acc("client.near"), None, vec![milestone("x", 10_000)], NOW_MS + 60_000, "a".repeat(64));
    }));
    let e = escrow(&mut c);
    assert_eq!((e.total.0, e.status), (1_000_000, EscrowStatus::AwaitingFunds));
    assert_eq!(transfer(&mut c, "client.near", 999_999, r#"{"escrow":0}"#.into()), 999_999);
    assert_eq!(transfer(&mut c, "client.near", 1_000_000, r#"{"escrow":7}"#.into()), 1_000_000);
    // Anyone may fund (1Click delivering a checkout payment), but only once.
    assert_eq!(transfer(&mut c, "intents.near", 1_000_000, r#"{"escrow":0}"#.into()), 0);
    assert_eq!(transfer(&mut c, "client.near", 1_000_000, r#"{"escrow":0}"#.into()), 1_000_000);
    let e = c.get_escrow(0).unwrap();
    assert_eq!((e.status, e.funded_by), (EscrowStatus::Funded, Some(acc("intents.near"))));
    as_caller("ada.near");
    assert!(panics(|| c.cancel_escrow(0)));
}

#[test]
fn only_the_payer_releases_a_milestone_and_only_once() {
    let mut c = setup();
    escrow(&mut c);
    transfer(&mut c, "client.near", 1_000_000, r#"{"escrow":0}"#.into());
    for who in ["ada.near", "mallory.near"] {
        as_caller(who);
        assert!(panics(|| c.release_milestone(0, 0)), "{who} must not release");
    }
    as_caller("client.near");
    c.release_milestone(0, 0);
    assert_eq!(c.get_escrow(0).unwrap().milestones[0].status, MilestoneStatus::Releasing);
    assert!(panics(|| c.release_milestone(0, 0)));
    with_result(APP, true);
    assert!(c.on_milestone_sent(0, 0, Ok(())));
    let e = c.get_escrow(0).unwrap();
    assert_eq!((e.milestones[0].status, e.held()), (MilestoneStatus::Released, 600_000));
}

#[test]
fn a_failed_release_keeps_the_money_in_escrow() {
    let mut c = setup();
    escrow(&mut c);
    transfer(&mut c, "client.near", 1_000_000, r#"{"escrow":0}"#.into());
    as_caller("client.near");
    c.release_milestone(0, 1);
    with_result(APP, false);
    assert!(!c.on_milestone_sent(0, 1, Err(PromiseError::Failed)));
    let e = c.get_escrow(0).unwrap();
    assert_eq!((e.milestones[1].status, e.held()), (MilestoneStatus::Pending, 1_000_000));
}

#[test]
fn refunds_go_to_the_payer_payee_may_refund_anyone_after_the_date() {
    let mut c = setup();
    escrow(&mut c);
    transfer(&mut c, "client.near", 1_000_000, r#"{"escrow":0}"#.into());
    as_caller("client.near");
    assert!(panics(|| c.refund_milestone(0, 0)), "the payer cannot take money back before the date");
    as_caller("ada.near");
    c.refund_milestone(0, 0);
    with_result(APP, true);
    c.on_milestone_sent(0, 0, Ok(()));
    let mut late = ctx("anyone.near");
    late.block_timestamp((NOW_MS + 31 * 86_400_000) * 1_000_000);
    testing_env!(late.build());
    c.refund_milestone(0, 1);
    with_result(APP, true);
    c.on_milestone_sent(0, 1, Ok(()));
    let e = c.get_escrow(0).unwrap();
    assert_eq!(e.status, EscrowStatus::Closed);
    assert!(e.milestones.iter().all(|m| m.status == MilestoneStatus::Refunded));
}

// ------------------------------------------------------------ agent allowances

fn policy(per: u128, daily: u128) -> AllowancePolicy {
    AllowancePolicy { per_payment_max: U128(per), daily_max: U128(daily), expires_at_ms: NOW_MS + 86_400_000 * 30, payees: vec![] }
}

#[test]
fn an_agent_spends_only_within_its_owners_limits() {
    let mut c = setup();
    as_caller("ada.near");
    c.set_allowance(acc("bot.ada.near"), policy(100_000, 250_000));
    assert_eq!(transfer(&mut c, "ada.near", 1_000_000, r#"{"allowance":"bot.ada.near"}"#.into()), 0);
    assert_eq!(transfer(&mut c, "eve.near", 5, r#"{"allowance":"bot.ada.near"}"#.into()), 5, "only the owner's own allowance can be topped up");

    as_caller("mallory.near");
    assert!(panics(|| c.agent_pay(acc("ada.near"), acc("mallory.near"), U128(1), "x".into())), "not the agent");
    as_caller("bot.ada.near");
    assert!(panics(|| c.agent_pay(acc("ada.near"), acc("shop.near"), U128(100_001), "x".into())));
    c.agent_pay(acc("ada.near"), acc("shop.near"), U128(100_000), "x402:cs_1".into());
    c.agent_pay(acc("ada.near"), acc("shop.near"), U128(100_000), "x402:cs_2".into());
    assert!(panics(|| c.agent_pay(acc("ada.near"), acc("shop.near"), U128(60_000), "x".into())), "daily limit");
    let a = c.get_allowance(acc("ada.near"), acc("bot.ada.near")).unwrap();
    assert_eq!((a.balance.0, a.spent_today.0, a.payments), (800_000, 200_000, 2));

    // A failed transfer gives back balance and daily room.
    with_result(APP, false);
    c.on_agent_paid(acc("ada.near"), acc("bot.ada.near"), acc("shop.near"), U128(100_000), "x402:cs_2".into(), NOW_MS / 86_400_000, Err(PromiseError::Failed));
    let a = c.get_allowance(acc("ada.near"), acc("bot.ada.near")).unwrap();
    assert_eq!((a.balance.0, a.spent_today.0), (900_000, 100_000));
}

#[test]
fn revoking_stops_the_agent_and_returns_the_balance() {
    let mut c = setup();
    as_caller("ada.near");
    c.set_allowance(acc("bot.ada.near"), policy(100_000, 250_000));
    transfer(&mut c, "ada.near", 500_000, r#"{"allowance":"bot.ada.near"}"#.into());
    as_caller("ada.near");
    c.revoke_allowance(acc("bot.ada.near"));
    let a = c.get_allowance(acc("ada.near"), acc("bot.ada.near")).unwrap();
    assert_eq!((a.revoked, a.balance.0), (true, 0));
    as_caller("bot.ada.near");
    assert!(panics(|| c.agent_pay(acc("ada.near"), acc("shop.near"), U128(1), "x".into())));
    assert_eq!(transfer(&mut c, "ada.near", 5, r#"{"allowance":"bot.ada.near"}"#.into()), 5, "a revoked allowance takes no new money");
    as_caller("ada.near");
    assert!(panics(|| {
        c.set_allowance(acc("ada.near"), policy(1, 1));
    }), "an owner cannot be its own agent");
}
