/**
 * Billing on top of Checkout: invoices, plans, subscriptions, customers.
 *
 * An invoice is a hosted page (/i/<id>) with line items and a due date. When
 * the customer presses Pay, it opens an ordinary checkout session (any coin,
 * any chain, exact dollars, on-chain receipt), so invoices inherit everything
 * sessions do: payout preference, fees, receipts, refunds.
 *
 * A subscription bills a plan every interval. Crypto has no card on file, so
 * renewal is explicit: Cascade issues the next invoice before the period
 * ends and the customer pays it (or prepays several periods at once). An
 * unpaid renewal makes the subscription past_due, then canceled after a
 * grace period. Every change is a signed webhook.
 */
import { formatUsd } from "@cascade/core";
import type { CheckoutSessionRecord, Merchant } from "@cascade/db";
import type { BillingEventType, Customer, CustomerSummary, Interval, Invoice, InvoiceItem, Plan, Subscription } from "@cascade/sdk";
import { CheckoutError, MAX_SESSION_USD, randomId, type Checkout } from "./checkout.js";

export interface InvoiceRecord {
  id: string;
  merchantId: string;
  number: string;
  customer: Customer;
  items: InvoiceItem[];
  amount: string;
  memo: string | null;
  dueDate: string;
  status: "open" | "paid" | "void";
  sessionId: string | null;
  receiptId: number | null;
  nearTx: string | null;
  subscriptionId: string | null;
  /** Periods this invoice pays for (subscriptions; >1 when prepaid). */
  periods: number;
  period: { start: string; end: string } | null;
  overdueNotified: boolean;
  createdAt: string;
  paidAt: string | null;
}

export interface PlanRecord {
  id: string;
  merchantId: string;
  name: string;
  amount: string;
  interval: Interval;
  createdAt: string;
}

export interface SubscriptionRecord {
  id: string;
  merchantId: string;
  planId: string;
  customer: Customer;
  status: Subscription["status"];
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  latestInvoiceId: string | null;
  pastDueSince: string | null;
  createdAt: string;
  canceledAt: string | null;
}

const INVOICE = "invoice";
const PLAN = "plan";
const SUB = "subscription";
const INTERVALS: Interval[] = ["day", "week", "month", "year"];
const DAY_MS = 86_400_000;
const MAX_PREPAID = 12;

/** `iso` plus `n` intervals, in UTC. Months clamp to the last day (Jan 31 + 1 month = Feb 28/29). */
export function addInterval(iso: string, interval: Interval, n: number): string {
  const d = new Date(iso);
  if (interval === "day") return new Date(d.getTime() + n * DAY_MS).toISOString();
  if (interval === "week") return new Date(d.getTime() + 7 * n * DAY_MS).toISOString();
  const months = interval === "month" ? n : 12 * n;
  const y = d.getUTCFullYear();
  const target = d.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, target + 1, 0)).getUTCDate();
  const out = new Date(d);
  out.setUTCDate(1);
  out.setUTCFullYear(y, target, Math.min(d.getUTCDate(), lastDay));
  return out.toISOString();
}

const intervalMs = (i: Interval) => ({ day: DAY_MS, week: 7 * DAY_MS, month: 30 * DAY_MS, year: 365 * DAY_MS })[i];
const isEmail = (s: string) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(s);

function cleanCustomer(c: unknown): Customer {
  const x = (c ?? {}) as { name?: unknown; email?: unknown };
  if (typeof x.name !== "string" || !x.name.trim() || x.name.length > 120) throw new CheckoutError(400, "customer.name must be 1-120 characters");
  if (x.email !== undefined && (typeof x.email !== "string" || !isEmail(x.email))) throw new CheckoutError(400, "customer.email is not an email address");
  return { name: x.name.trim(), ...(x.email ? { email: (x.email as string).toLowerCase() } : {}) };
}

function cleanItems(items: unknown): InvoiceItem[] {
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) throw new CheckoutError(400, "items: 1 to 50 line items");
  return items.map((raw, i) => {
    const it = raw as { description?: unknown; quantity?: unknown; unitAmount?: unknown };
    if (typeof it.description !== "string" || !it.description.trim() || it.description.length > 200) throw new CheckoutError(400, `items[${i}].description must be 1-200 characters`);
    const q = it.quantity ?? 1;
    if (!Number.isInteger(q) || (q as number) < 1 || (q as number) > 10_000) throw new CheckoutError(400, `items[${i}].quantity must be a whole number from 1 to 10000`);
    if (typeof it.unitAmount !== "string" || !/^\d+$/.test(it.unitAmount) || BigInt(it.unitAmount) <= 0n) throw new CheckoutError(400, `items[${i}].unitAmount must be a positive integer of USDC base units`);
    return { description: it.description.trim(), quantity: q as number, unitAmount: it.unitAmount };
  });
}

export class Billing {
  constructor(readonly c: Checkout) {
    c.onPaid.push((s) => this.onSessionPaid(s));
  }

  private get store() {
    return this.c.cfg.store;
  }
  private now() {
    return (this.c.cfg.now ?? Date.now)();
  }
  private iso(ms = this.now()) {
    return new Date(ms).toISOString();
  }
  private today(ms = this.now()) {
    return this.iso(ms).slice(0, 10);
  }

  // ------------------------------------------------------------ invoices

  async createInvoice(
    m: Merchant,
    p: { customer: unknown; items: unknown; dueDate?: string; daysUntilDue?: number; memo?: string },
    sub?: { subscriptionId: string; periods: number; period: { start: string; end: string } | null },
  ): Promise<InvoiceRecord> {
    const customer = cleanCustomer(p.customer);
    const items = cleanItems(p.items);
    const amount = items.reduce((t, it) => t + BigInt(it.unitAmount) * BigInt(it.quantity), 0n);
    if (amount > MAX_SESSION_USD) throw new CheckoutError(400, "invoice total above the per-payment limit");
    if (p.memo !== undefined && (typeof p.memo !== "string" || p.memo.length > 1000)) throw new CheckoutError(400, "memo must be up to 1000 characters");
    let dueDate = p.dueDate;
    if (dueDate === undefined) {
      const days = p.daysUntilDue ?? 14;
      if (!Number.isInteger(days) || days < 0 || days > 365) throw new CheckoutError(400, "daysUntilDue must be 0-365");
      dueDate = this.today(this.now() + days * DAY_MS);
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(Date.parse(dueDate))) throw new CheckoutError(400, "dueDate must be YYYY-MM-DD");
    const seq = await this.store.hit(`invoice-number:${m.id}`, 1e15, 0);
    const inv: InvoiceRecord = {
      id: randomId("in_"), merchantId: m.id, number: `INV-${String(seq).padStart(4, "0")}`, customer, items, amount: amount.toString(),
      memo: p.memo?.trim() || null, dueDate, status: "open", sessionId: null, receiptId: null, nearTx: null,
      subscriptionId: sub?.subscriptionId ?? null, periods: sub?.periods ?? 1, period: sub?.period ?? null,
      overdueNotified: false, createdAt: this.iso(), paidAt: null,
    };
    await this.store.putDoc(INVOICE, inv.id, m.id, inv);
    await this.emit(m.id, "invoice.created", { invoice: await this.invoiceView(inv) });
    return inv;
  }

  async invoiceView(inv: InvoiceRecord): Promise<Invoice> {
    const m = (await this.store.getMerchant(inv.merchantId))!;
    return {
      id: inv.id, object: "invoice", number: inv.number, merchant: { name: m.name, account: m.account }, customer: inv.customer, items: inv.items,
      amount: inv.amount, amountFormatted: formatUsd(inv.amount), currency: "USD", memo: inv.memo, status: inv.status,
      overdue: inv.status === "open" && this.today() > inv.dueDate, dueDate: inv.dueDate, url: `${this.c.cfg.publicUrl}/i/${inv.id}`,
      sessionId: inv.sessionId, receipt: inv.receiptId !== null ? { id: inv.receiptId, nearTx: inv.nearTx } : null,
      subscriptionId: inv.subscriptionId, period: inv.period, createdAt: inv.createdAt, paidAt: inv.paidAt,
    };
  }

  private async invoiceById(id: string): Promise<InvoiceRecord> {
    const inv = /^in_[A-Za-z0-9]{10,40}$/.test(id) ? await this.store.getDoc<InvoiceRecord>(INVOICE, id) : null;
    if (!inv) throw new CheckoutError(404, "no such invoice");
    return inv;
  }

  async getInvoice(m: Merchant, id: string): Promise<InvoiceRecord> {
    const inv = await this.invoiceById(id);
    if (inv.merchantId !== m.id) throw new CheckoutError(404, "no such invoice");
    return inv;
  }

  listInvoices(m: Merchant): Promise<InvoiceRecord[]> {
    return this.store.listDocs<InvoiceRecord>(INVOICE, m.id).then((l) => l.reverse());
  }

  /** The hosted invoice page (public: the id is unguessable). */
  async publicInvoice(id: string): Promise<Invoice> {
    return this.invoiceView(await this.invoiceById(id));
  }

  /** The customer pressed Pay: reuse the invoice's open checkout session, or open a new one. */
  async payInvoice(id: string): Promise<{ sessionId: string; url: string }> {
    const inv = await this.invoiceById(id);
    if (inv.status === "paid") throw new CheckoutError(409, "this invoice is already paid");
    if (inv.status === "void") throw new CheckoutError(410, "this invoice was voided");
    if (inv.sessionId) {
      const s = await this.store.getSession(inv.sessionId);
      if (s && s.status !== "expired" && Date.parse(s.expiresAt) > this.now() + 10 * 60_000) return { sessionId: s.id, url: `${this.c.cfg.publicUrl}/c/${s.id}` };
    }
    const m = (await this.store.getMerchant(inv.merchantId))!;
    const s = await this.c.createSession(m, {
      amount: inv.amount, description: `Invoice ${inv.number}`, reference: inv.number, metadata: { invoice: inv.id }, expiresInMinutes: 1440,
      successUrl: `${this.c.cfg.publicUrl}/i/${inv.id}`,
    });
    await this.store.putDoc(INVOICE, inv.id, inv.merchantId, { ...(await this.invoiceById(id)), sessionId: s.id });
    return { sessionId: s.id, url: `${this.c.cfg.publicUrl}/c/${s.id}` };
  }

  async voidInvoice(m: Merchant, id: string): Promise<InvoiceRecord> {
    const inv = await this.getInvoice(m, id);
    if (inv.status !== "open") throw new CheckoutError(409, `invoice is ${inv.status}`);
    if (inv.sessionId) {
      const s = await this.store.getSession(inv.sessionId);
      const last = s?.attempts.at(-1);
      const rec = last ? await this.store.getPayment(last) : null;
      if (rec && !["PENDING_DEPOSIT", "REFUNDED", "FAILED"].includes(rec.status)) throw new CheckoutError(409, "a payment for this invoice is in progress");
    }
    const v = { ...inv, status: "void" as const };
    await this.store.putDoc(INVOICE, inv.id, m.id, v);
    await this.emit(m.id, "invoice.voided", { invoice: await this.invoiceView(v) });
    return v;
  }

  /** Checkout hook: a session paid. If it paid an invoice, close the invoice (and renew its subscription). */
  async onSessionPaid(s: CheckoutSessionRecord): Promise<void> {
    const id = s.metadata.invoice;
    if (!id) return;
    const inv = await this.store.getDoc<InvoiceRecord>(INVOICE, id);
    if (!inv || inv.status === "paid" || inv.merchantId !== s.merchantId) return;
    // A voided invoice that is paid anyway (payment was already in flight) is still recorded as paid: the money arrived.
    const paid: InvoiceRecord = { ...inv, status: "paid", sessionId: s.id, receiptId: s.receiptId, nearTx: s.nearTx, paidAt: s.paidAt ?? this.iso() };
    await this.store.putDoc(INVOICE, inv.id, inv.merchantId, paid);
    await this.emit(inv.merchantId, "invoice.paid", { invoice: await this.invoiceView(paid) });
    if (paid.subscriptionId) await this.applySubscriptionPayment(paid);
  }

  // ------------------------------------------------------------ plans and subscriptions

  async createPlan(m: Merchant, p: { name?: unknown; amount?: unknown; interval?: unknown }): Promise<PlanRecord> {
    if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 80) throw new CheckoutError(400, "name must be 1-80 characters");
    if (typeof p.amount !== "string" || !/^\d+$/.test(p.amount) || BigInt(p.amount) <= 0n || BigInt(p.amount) > MAX_SESSION_USD) throw new CheckoutError(400, "amount must be a positive integer of USDC base units");
    if (!INTERVALS.includes(p.interval as Interval)) throw new CheckoutError(400, `interval must be one of ${INTERVALS.join(", ")}`);
    const plan: PlanRecord = { id: randomId("plan_"), merchantId: m.id, name: p.name.trim(), amount: p.amount, interval: p.interval as Interval, createdAt: this.iso() };
    await this.store.putDoc(PLAN, plan.id, m.id, plan);
    return plan;
  }

  planView(p: PlanRecord): Plan {
    return { id: p.id, object: "plan", name: p.name, amount: p.amount, amountFormatted: formatUsd(p.amount), interval: p.interval, createdAt: p.createdAt };
  }

  listPlans(m: Merchant): Promise<PlanRecord[]> {
    return this.store.listDocs<PlanRecord>(PLAN, m.id);
  }

  private async plan(m: Merchant | string, id: string): Promise<PlanRecord> {
    const p = await this.store.getDoc<PlanRecord>(PLAN, id);
    if (!p || p.merchantId !== (typeof m === "string" ? m : m.id)) throw new CheckoutError(404, "no such plan");
    return p;
  }

  /**
   * Start a subscription: the first invoice covers `prepaidPeriods` periods
   * (default 1, up to 12). The period starts when it is paid.
   */
  async createSubscription(m: Merchant, p: { planId?: unknown; customer?: unknown; prepaidPeriods?: unknown; daysUntilDue?: number }): Promise<SubscriptionRecord> {
    const plan = await this.plan(m, typeof p.planId === "string" ? p.planId : "");
    const customer = cleanCustomer(p.customer);
    const periods = p.prepaidPeriods ?? 1;
    if (!Number.isInteger(periods) || (periods as number) < 1 || (periods as number) > MAX_PREPAID) throw new CheckoutError(400, `prepaidPeriods must be 1-${MAX_PREPAID}`);
    const sub: SubscriptionRecord = {
      id: randomId("sub_"), merchantId: m.id, planId: plan.id, customer, status: "incomplete", currentPeriodStart: null, currentPeriodEnd: null,
      cancelAtPeriodEnd: false, latestInvoiceId: null, pastDueSince: null, createdAt: this.iso(), canceledAt: null,
    };
    await this.store.putDoc(SUB, sub.id, m.id, sub);
    const inv = await this.createInvoice(
      m,
      { customer, items: [{ description: `${plan.name}, ${periods} ${plan.interval}${periods === 1 ? "" : "s"}`, quantity: periods, unitAmount: plan.amount }], daysUntilDue: p.daysUntilDue ?? 3 },
      { subscriptionId: sub.id, periods: periods as number, period: null },
    );
    const withInv = { ...sub, latestInvoiceId: inv.id };
    await this.store.putDoc(SUB, sub.id, m.id, withInv);
    return withInv;
  }

  async subscriptionView(s: SubscriptionRecord): Promise<Subscription> {
    return {
      id: s.id, object: "subscription", plan: this.planView(await this.plan(s.merchantId, s.planId)), customer: s.customer, status: s.status,
      currentPeriodStart: s.currentPeriodStart, currentPeriodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      latestInvoiceId: s.latestInvoiceId, createdAt: s.createdAt, canceledAt: s.canceledAt,
    };
  }

  async getSubscription(m: Merchant, id: string): Promise<SubscriptionRecord> {
    const s = /^sub_[A-Za-z0-9]{10,40}$/.test(id) ? await this.store.getDoc<SubscriptionRecord>(SUB, id) : null;
    if (!s || s.merchantId !== m.id) throw new CheckoutError(404, "no such subscription");
    return s;
  }

  listSubscriptions(m: Merchant): Promise<SubscriptionRecord[]> {
    return this.store.listDocs<SubscriptionRecord>(SUB, m.id).then((l) => l.reverse());
  }

  /** Cancel now (voids the open invoice), or at the end of the paid period. */
  async cancelSubscription(m: Merchant, id: string, atPeriodEnd = false): Promise<SubscriptionRecord> {
    const s = await this.getSubscription(m, id);
    if (s.status === "canceled") return s;
    if (atPeriodEnd && s.status === "active") {
      const next = { ...s, cancelAtPeriodEnd: true };
      await this.store.putDoc(SUB, s.id, m.id, next);
      return next;
    }
    const inv = s.latestInvoiceId ? await this.store.getDoc<InvoiceRecord>(INVOICE, s.latestInvoiceId) : null;
    if (inv?.status === "open") await this.voidInvoice(m, inv.id).catch(() => undefined);
    return this.cancel(s);
  }

  private async cancel(s: SubscriptionRecord): Promise<SubscriptionRecord> {
    const next: SubscriptionRecord = { ...s, status: "canceled", canceledAt: this.iso() };
    await this.store.putDoc(SUB, s.id, s.merchantId, next);
    await this.emit(s.merchantId, "subscription.canceled", { subscription: await this.subscriptionView(next) });
    return next;
  }

  private async applySubscriptionPayment(inv: InvoiceRecord) {
    const s = await this.store.getDoc<SubscriptionRecord>(SUB, inv.subscriptionId!);
    if (!s || s.status === "canceled") return;
    const plan = await this.plan(s.merchantId, s.planId);
    const first = s.status === "incomplete";
    // Periods run back to back: a late renewal does not shift the schedule, a first payment starts it.
    const start = first || !s.currentPeriodEnd ? inv.paidAt! : s.currentPeriodEnd;
    const end = addInterval(start, plan.interval, inv.periods);
    const next: SubscriptionRecord = { ...s, status: "active", pastDueSince: null, currentPeriodStart: start, currentPeriodEnd: end };
    await this.store.putDoc(SUB, s.id, s.merchantId, next);
    await this.emit(s.merchantId, first ? "subscription.activated" : "subscription.renewed", { subscription: await this.subscriptionView(next) });
  }

  // ------------------------------------------------------------ the clock

  /**
   * Runs with every settler tick: issues renewal invoices ahead of each
   * period end, marks unpaid ones past_due, cancels after the grace period,
   * and sends one invoice.overdue reminder per invoice.
   */
  async tick(): Promise<{ renewals: number; pastDue: number; canceled: number; overdue: number }> {
    const out = { renewals: 0, pastDue: 0, canceled: 0, overdue: 0 };
    const now = this.now();
    for (const s of await this.store.listDocs<SubscriptionRecord>(SUB)) {
      if (s.status !== "active" && s.status !== "past_due") continue;
      if (!s.currentPeriodEnd) continue;
      const plan = await this.plan(s.merchantId, s.planId);
      const end = Date.parse(s.currentPeriodEnd);
      const lead = Math.min(3 * DAY_MS, intervalMs(plan.interval) / 2);
      const latest = s.latestInvoiceId ? await this.store.getDoc<InvoiceRecord>(INVOICE, s.latestInvoiceId) : null;

      if (s.cancelAtPeriodEnd) {
        if (now >= end) {
          await this.cancel(s);
          out.canceled++;
        }
        continue;
      }
      if (s.status === "active" && now >= end - lead && latest?.status !== "open") {
        const m = (await this.store.getMerchant(s.merchantId))!;
        const period = { start: s.currentPeriodEnd, end: addInterval(s.currentPeriodEnd, plan.interval, 1) };
        const inv = await this.createInvoice(
          m,
          { customer: s.customer, items: [{ description: `${plan.name}, ${period.start.slice(0, 10)} to ${period.end.slice(0, 10)}`, quantity: 1, unitAmount: plan.amount }], dueDate: s.currentPeriodEnd.slice(0, 10) },
          { subscriptionId: s.id, periods: 1, period },
        );
        await this.store.putDoc(SUB, s.id, s.merchantId, { ...s, latestInvoiceId: inv.id });
        out.renewals++;
        continue;
      }
      if (s.status === "active" && now >= end && latest?.status === "open") {
        const next = { ...s, status: "past_due" as const, pastDueSince: this.iso() };
        await this.store.putDoc(SUB, s.id, s.merchantId, next);
        await this.emit(s.merchantId, "subscription.past_due", { subscription: await this.subscriptionView(next) });
        out.pastDue++;
        continue;
      }
      const grace = Math.max(DAY_MS, Math.min(7 * DAY_MS, intervalMs(plan.interval)));
      if (s.status === "past_due" && s.pastDueSince && now >= Date.parse(s.pastDueSince) + grace) {
        if (latest?.status === "open") await this.voidInvoice((await this.store.getMerchant(s.merchantId))!, latest.id).catch(() => undefined);
        await this.cancel((await this.store.getDoc<SubscriptionRecord>(SUB, s.id))!);
        out.canceled++;
      }
    }
    const today = this.today();
    for (const inv of await this.store.listDocs<InvoiceRecord>(INVOICE)) {
      if (inv.status !== "open" || inv.overdueNotified || today <= inv.dueDate) continue;
      const next = { ...inv, overdueNotified: true };
      await this.store.putDoc(INVOICE, inv.id, inv.merchantId, next);
      await this.emit(inv.merchantId, "invoice.overdue", { invoice: await this.invoiceView(next) });
      out.overdue++;
    }
    return out;
  }

  // ------------------------------------------------------------ customers

  /** Everyone this merchant has billed, by email (or name), with lifetime totals. */
  async customers(m: Merchant): Promise<CustomerSummary[]> {
    const by = new Map<string, CustomerSummary>();
    const key = (c: Customer) => c.email ?? `name:${c.name.toLowerCase()}`;
    const entry = (c: Customer, at: string) => {
      const k = key(c);
      const e = by.get(k) ?? { ...c, invoices: 0, paid: "0", outstanding: "0", subscriptions: 0, lastActivity: at };
      if (at > e.lastActivity) e.lastActivity = at;
      by.set(k, e);
      return e;
    };
    for (const inv of await this.store.listDocs<InvoiceRecord>(INVOICE, m.id)) {
      const e = entry(inv.customer, inv.paidAt ?? inv.createdAt);
      e.invoices++;
      if (inv.status === "paid") e.paid = (BigInt(e.paid) + BigInt(inv.amount)).toString();
      if (inv.status === "open") e.outstanding = (BigInt(e.outstanding) + BigInt(inv.amount)).toString();
    }
    for (const s of await this.store.listDocs<SubscriptionRecord>(SUB, m.id)) {
      const e = entry(s.customer, s.createdAt);
      if (s.status === "active" || s.status === "past_due") e.subscriptions++;
    }
    return [...by.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  }

  private emit(merchantId: string, type: BillingEventType, data: { invoice?: Invoice; subscription?: Subscription }) {
    return this.c.enqueueEvent(merchantId, { id: randomId("evt_"), type, created: this.iso(), data });
  }
}
