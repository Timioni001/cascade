/**
 * Cascade Checkout: Stripe-style sessions on top of NEAR Intents.
 *
 * A merchant (any registered Cascade owner: a person or a DAO) creates a
 * session for an exact USD amount. The customer picks any coin on any chain;
 * 1Click delivers exactly that much USDC straight to the merchant's NEAR
 * account or DAO. The settler records an on-chain receipt bound to the
 * session, and the merchant gets a signed webhook to fulfil the order.
 *
 * Cascade never holds checkout money: 1Click's recipient is the merchant.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { verifyMessage } from "near-api-js/nep413";
import { CHAINS, USDC_BY_CHAIN, assetSymbol, formatUsd, hashDocument, isAccountId } from "@cascade/core";
import type { ApiKey, CheckoutSessionRecord, KeyRole, Merchant, PaymentRecord, Payout, Store, WebhookDelivery } from "@cascade/db";
import { CascadeReader, type Chain } from "@cascade/near";
import { incomingQuote, type OneClick, type Token } from "@cascade/oneclick";
import { payoutMessage, signWebhook, SIGNATURE_HEADER, type CheckoutSession, type PayAsset, type PaymentPreview, type WebhookEvent, type CheckoutEventType } from "@cascade/sdk";

/** A revenue split as the dashboard shows it. `received` is USDC base units paid into it through checkout. */
export interface SplitView {
  id: number;
  owner: string;
  createdBy: string;
  createdAt: string;
  shares: { account: string; bps: number }[];
  payments: number;
  received: string;
}

export class CheckoutError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CheckoutError";
  }
}

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** Unguessable id: a session id is a capability for the public checkout page. */
export function randomId(prefix: string, bytes = 18): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return prefix + Array.from(b, (x) => ALPHABET[x % 62]).join("");
}

export const sha256Hex = (s: string) => bytesToHex(sha256(utf8ToBytes(s)));

/** Placeholder refund addresses for *dry* (preview) quotes only. Real quotes always use the payer's address. */
const PREVIEW_REFUND: Record<string, string> = {
  sol: "11111111111111111111111111111111",
  btc: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  near: "preview.near",
  tron: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
};
const previewRefund = (chain: string) => PREVIEW_REFUND[chain] ?? "0x000000000000000000000000000000000000dEaD";

export const ONBOARDING_RECIPIENT = "cascade-checkout";
export const MAX_SESSION_USD = 100_000n * 1_000_000n;
export const MAX_ATTEMPTS = 5;
const WEBHOOK_MAX_ATTEMPTS = 8;

/** The exact text a merchant signs (NEP-413) to prove control of `account`. */
export function onboardingMessage(p: { account: string; name: string; issuedAt: string }): string {
  return `Cascade Checkout merchant onboarding\naccount: ${p.account}\nname: ${p.name}\nissued: ${p.issuedAt}`;
}

export { payoutMessage };

/** Payout destinations: USDC on these chains (1Click delivers it directly). */
export const PAYOUT_CHAINS = Object.keys(USDC_BY_CHAIN);

export function validatePayout(p: Payout): void {
  if (!PAYOUT_CHAINS.includes(p.chain)) throw new CheckoutError(400, `payout chain must be one of ${PAYOUT_CHAINS.join(", ")}`);
  const ok = p.chain === "near" ? isAccountId(p.address) : CHAINS[p.chain]!.address.test(p.address);
  if (!ok) throw new CheckoutError(400, `not a ${CHAINS[p.chain]?.name ?? p.chain} address`);
}

export interface OnboardingProof {
  signer: string; // NEAR account that signed (the owner, or a preparer of a DAO owner)
  publicKey: string; // ed25519:...
  signature: string; // base64
  nonce: string; // base64, 32 bytes
  issuedAt: string; // ISO, must be within 10 minutes
}

export interface CheckoutConfig {
  store: Store;
  oneclick: OneClick;
  chain: Chain;
  app: string;
  /** Base URL of the hosted checkout page, e.g. https://cascade.link */
  publicUrl: string;
  keyMode?: "test" | "live";
  now?: () => number;
  /** Verify a NEP-413 proof. Defaults to near-api-js verifyMessage against the chain. */
  verifyProof?: (p: OnboardingProof, message: string) => Promise<boolean>;
  /**
   * Cascade's fee: a 1Click app fee paid by the customer on top of the exact
   * amount the merchant receives. `recipient` is an account inside NEAR Intents.
   */
  fee?: { recipient: string; bps: number };
  /** USDC token contract on NEAR: enables agents paying directly from an on-chain allowance (x402). */
  usdc?: string;
  /** The relayer account: it signs agents' gasless payments, so it is where their transactions are looked up. */
  relayer?: string;
}

export interface NewSession {
  amount: string; // USDC base units
  description: string;
  reference?: string;
  metadata?: Record<string, string>;
  successUrl?: string;
  cancelUrl?: string;
  expiresInMinutes?: number;
  /** On-chain revenue split (create_split) that receives the payment instead of the merchant account. */
  splitId?: number;
  /** On-chain escrow (payee = this merchant) the payment funds; amount must equal its total. */
  escrowId?: number;
}

/** How a quote's refunds are routed: to the payer on their chain, or (x402 without an address) into the merchant's Intents account. */
export type RefundRoute = { refundTo: string; type: "ORIGIN_CHAIN" | "INTENTS" };

export class Checkout {
  readonly reader: CascadeReader;
  private readonly now: () => number;
  private assetsCache: { at: number; assets: PayAsset[] } | null = null;
  /** Called once when a session becomes paid (billing closes invoices here). Must be idempotent. */
  readonly onPaid: ((s: CheckoutSessionRecord) => Promise<void>)[] = [];

  constructor(readonly cfg: CheckoutConfig) {
    this.reader = new CascadeReader(cfg.chain, cfg.app);
    this.now = cfg.now ?? Date.now;
  }

  private iso(ms = this.now()) {
    return new Date(ms).toISOString();
  }

  // ------------------------------------------------------------ merchants

  private async verify(p: OnboardingProof, message: string): Promise<boolean> {
    if (this.cfg.verifyProof) return this.cfg.verifyProof(p, message);
    try {
      await verifyMessage({
        signerAccountId: p.signer,
        signerPublicKey: p.publicKey,
        payload: { message, recipient: ONBOARDING_RECIPIENT, nonce: Uint8Array.from(Buffer.from(p.nonce, "base64")) },
        signature: Uint8Array.from(Buffer.from(p.signature, "base64")),
        provider: this.cfg.chain.provider,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Onboard `account` (a registered Cascade owner) as a merchant. The proof
   * must be signed by the account itself, or, for a DAO, by one of the
   * preparers the DAO approved. Returns the secret key once; only its hash is stored.
   */
  async onboard(p: { account: string; name: string; webhookUrl?: string | null; proof: OnboardingProof }): Promise<{ merchant: Merchant; secretKey: string }> {
    const name = p.name.trim();
    if (!isAccountId(p.account)) throw new CheckoutError(400, "account is not a NEAR account id");
    if (name.length < 2 || name.length > 80) throw new CheckoutError(400, "name must be 2-80 characters");
    if (p.webhookUrl) validateWebhookUrl(p.webhookUrl);
    this.checkProofShape(p.proof);

    const owner = await this.reader.owner(p.account);
    if (!owner) throw new CheckoutError(400, `${p.account} is not registered with Cascade`);
    const allowed = p.proof.signer === p.account || (owner.kind === "Dao" && owner.preparers.includes(p.proof.signer));
    if (!allowed) throw new CheckoutError(403, `${p.proof.signer} cannot act for ${p.account}`);
    if (!(await this.verify(p.proof, onboardingMessage({ account: p.account, name, issuedAt: p.proof.issuedAt })))) {
      throw new CheckoutError(401, "signature does not verify for that account and key");
    }
    // Atomic in the store, so a replay is refused even on another instance.
    if (!(await this.cfg.store.claimOnce(`nep413:${p.proof.nonce}`, 20 * 60_000, this.now()))) throw new CheckoutError(400, "proof already used");
    if (await this.cfg.store.findMerchantByAccount(p.account)) throw new CheckoutError(409, "this account is already a merchant");

    const merchant: Merchant = {
      id: randomId("mrc_"),
      account: p.account,
      name,
      webhookUrl: p.webhookUrl ?? null,
      webhookSecret: randomId("whsec_", 24),
      verifiedBy: p.proof.signer,
      createdAt: this.iso(),
    };
    await this.cfg.store.putMerchant(merchant);
    return { merchant, secretKey: await this.issueKey(merchant.id) };
  }

  private checkProofShape(proof: OnboardingProof) {
    const issued = Date.parse(proof.issuedAt);
    if (!Number.isFinite(issued) || Math.abs(this.now() - issued) > 10 * 60_000) throw new CheckoutError(400, "proof is expired or from the future");
    if (Buffer.from(proof.nonce, "base64").length !== 32) throw new CheckoutError(400, "nonce must be 32 bytes");
  }

  /**
   * Change where checkout payments settle. Needs a NEP-413 signature from the
   * merchant's account (or a DAO preparer), not just the secret key. Sessions
   * already created keep the destination they were created with.
   */
  async setPayout(m: Merchant, payout: Payout | null, proof: OnboardingProof): Promise<Merchant> {
    if (payout?.chain === "near" && payout.address === m.account) payout = null;
    if (payout) validatePayout(payout);
    this.checkProofShape(proof);
    const owner = await this.reader.owner(m.account);
    const allowed = proof.signer === m.account || (owner?.kind === "Dao" && owner.preparers.includes(proof.signer));
    if (!allowed) throw new CheckoutError(403, `${proof.signer} cannot act for ${m.account}`);
    if (!(await this.verify(proof, payoutMessage({ account: m.account, payout, issuedAt: proof.issuedAt })))) {
      throw new CheckoutError(401, "signature does not verify for that account and key");
    }
    if (!(await this.cfg.store.claimOnce(`nep413:${proof.nonce}`, 20 * 60_000, this.now()))) throw new CheckoutError(400, "proof already used");
    const next = { ...m, payout };
    await this.cfg.store.putMerchant(next);
    return next;
  }

  /** Issue a secret key. Only its hash is stored; the key itself is returned once. */
  async issueKey(merchantId: string, role: KeyRole = "full", label: string | null = null): Promise<string> {
    if (role !== "full" && role !== "read") throw new CheckoutError(400, "role must be full or read");
    if (label !== null && label.length > 60) throw new CheckoutError(400, "label is at most 60 characters");
    // Read-only keys look different, so they are easy to tell apart in config files.
    const key = randomId(`${role === "read" ? "rk" : "sk"}_${this.cfg.keyMode ?? "test"}_`, 24);
    const rec: ApiKey = { hash: sha256Hex(key), prefix: key.slice(0, 14), merchantId, createdAt: this.iso(), revokedAt: null, role, label };
    await this.cfg.store.putApiKey(rec);
    await this.cfg.store.putDoc("apikey", rec.prefix, merchantId, rec);
    return key;
  }

  async listKeys(m: Merchant): Promise<Omit<ApiKey, "hash">[]> {
    const keys = await this.cfg.store.listDocs<ApiKey>("apikey", m.id);
    return Promise.all(keys.map(async (k) => {
      const live = (await this.cfg.store.getApiKey(k.hash)) ?? k;
      const { hash: _h, ...rest } = live;
      return { ...rest, role: live.role ?? "full" };
    }));
  }

  /** Revoke a key by its prefix. A key cannot revoke itself (so a merchant cannot lock itself out by mistake). */
  async revokeKey(m: Merchant, prefix: string, current: string): Promise<void> {
    const k = await this.cfg.store.getDoc<ApiKey>("apikey", prefix);
    if (!k || k.merchantId !== m.id) throw new CheckoutError(404, "no such key");
    if (k.hash === current) throw new CheckoutError(400, "a key cannot revoke itself");
    const live = (await this.cfg.store.getApiKey(k.hash)) ?? k;
    await this.cfg.store.putApiKey({ ...live, revokedAt: live.revokedAt ?? this.iso() });
  }

  async authenticate(authorization: string | undefined | null): Promise<Merchant> {
    return (await this.authenticateKey(authorization)).merchant;
  }

  /** The merchant and the key's role. Secret keys start with sk_, read-only keys with rk_. */
  async authenticateKey(authorization: string | undefined | null): Promise<{ merchant: Merchant; role: KeyRole; hash: string }> {
    const key = authorization?.replace(/^Bearer\s+/i, "").trim();
    if (!key || !/^(sk|rk)_/.test(key)) throw new CheckoutError(401, "missing or malformed secret key");
    const hash = sha256Hex(key);
    const rec = await this.cfg.store.getApiKey(hash);
    if (!rec || rec.revokedAt) throw new CheckoutError(401, "invalid secret key");
    const m = await this.cfg.store.getMerchant(rec.merchantId);
    if (!m) throw new CheckoutError(401, "invalid secret key");
    return { merchant: m, role: rec.role ?? "full", hash };
  }

  async updateMerchant(m: Merchant, p: { name?: string; webhookUrl?: string | null }): Promise<Merchant> {
    if (p.webhookUrl) validateWebhookUrl(p.webhookUrl);
    const next = { ...m, ...(p.name ? { name: p.name.trim().slice(0, 80) } : {}), ...(p.webhookUrl !== undefined ? { webhookUrl: p.webhookUrl } : {}) };
    await this.cfg.store.putMerchant(next);
    return next;
  }

  // ------------------------------------------------------------ revenue splits

  /**
   * Add a split the merchant's account created on-chain (create_split, signed
   * by its own wallet) to its dashboard. The chain is the source of truth: the
   * split must exist and belong to the merchant's account.
   */
  async registerSplit(m: Merchant, id: number): Promise<SplitView> {
    if (!Number.isInteger(id) || id < 0) throw new CheckoutError(400, "split id must be a non-negative integer");
    const rule = await this.reader.split(id);
    if (!rule) throw new CheckoutError(404, `no split #${id} on the contract`);
    if (rule.owner !== m.account) throw new CheckoutError(403, `split #${id} belongs to ${rule.owner}, not ${m.account}`);
    await this.cfg.store.putDoc("split", String(id), m.id, { id, addedAt: this.iso() });
    return (await this.listSplits(m)).find((s) => s.id === id)!;
  }

  /** The merchant's splits, read from the contract, with what checkout has paid into each. */
  async listSplits(m: Merchant): Promise<SplitView[]> {
    const docs = await this.cfg.store.listDocs<{ id: number }>("split", m.id);
    const sessions = await this.cfg.store.listSessions(m.id, 1000);
    const out: SplitView[] = [];
    for (const d of docs.reverse()) {
      const rule = await this.reader.split(d.id).catch(() => null);
      if (!rule) continue;
      const paid = sessions.filter((s) => s.splitId === d.id && s.status === "paid");
      out.push({
        id: rule.id, owner: rule.owner, createdBy: rule.created_by, createdAt: new Date(rule.created_at_ms).toISOString(),
        shares: rule.shares, payments: paid.length, received: paid.reduce((t, s) => t + BigInt(s.amount), 0n).toString(),
      });
    }
    return out;
  }

  // ------------------------------------------------------------ sessions

  async createSession(m: Merchant, p: NewSession, idempotencyKey?: string): Promise<CheckoutSessionRecord> {
    if (idempotencyKey) {
      if (idempotencyKey.length > 200) throw new CheckoutError(400, "idempotency key too long");
      const prior = await this.cfg.store.findSessionByIdempotencyKey(m.id, idempotencyKey);
      if (prior) {
        if (prior.amount !== p.amount || prior.description !== p.description) throw new CheckoutError(409, "idempotency key reused with different parameters");
        return prior;
      }
    }
    if (!/^\d+$/.test(p.amount) || BigInt(p.amount) <= 0n) throw new CheckoutError(400, "amount must be a positive integer of USDC base units");
    if (BigInt(p.amount) > MAX_SESSION_USD) throw new CheckoutError(400, "amount above the per-session limit");
    if (!p.description || p.description.length > 300) throw new CheckoutError(400, "description must be 1-300 characters");
    if (p.reference && p.reference.length > 200) throw new CheckoutError(400, "reference too long");
    const meta = p.metadata ?? {};
    if (Object.keys(meta).length > 20 || Object.entries(meta).some(([k, v]) => k.length > 40 || typeof v !== "string" || v.length > 500)) {
      throw new CheckoutError(400, "metadata: up to 20 string keys of 40 chars and values of 500 chars");
    }
    for (const u of [p.successUrl, p.cancelUrl]) if (u && !/^https?:\/\//.test(u)) throw new CheckoutError(400, "redirect URLs must be http(s)");
    if (p.splitId !== undefined) {
      const split = Number.isInteger(p.splitId) && p.splitId >= 0 ? await this.reader.split(p.splitId) : null;
      if (!split) throw new CheckoutError(400, "no such split");
      if (split.owner !== m.account) throw new CheckoutError(403, "that split belongs to another owner");
    }
    if (p.escrowId !== undefined) {
      if (p.splitId !== undefined) throw new CheckoutError(400, "a session pays a split or an escrow, not both");
      await this.checkEscrowFundable(m, p.escrowId, p.amount);
      // One open session per escrow: a second delivery would be refused by the
      // contract. Asking again returns the open session, so the funding link is
      // stable; a session already being paid is still an error.
      for (const o of await this.cfg.store.listSessions(m.id, 1000)) {
        if (o.escrowId !== p.escrowId || Date.parse(o.expiresAt) <= this.now()) continue;
        if (o.status === "open") return o;
        if (o.status === "processing") throw new CheckoutError(409, `escrow #${p.escrowId} is being funded right now (${o.id})`);
      }
    }
    const minutes = Math.min(Math.max(p.expiresInMinutes ?? 60, 5), 1440);
    const s: CheckoutSessionRecord = {
      id: randomId("cs_"),
      merchantId: m.id,
      owner: m.account,
      amount: p.amount,
      description: p.description,
      reference: p.reference ?? null,
      metadata: meta,
      successUrl: p.successUrl ?? null,
      cancelUrl: p.cancelUrl ?? null,
      status: "open",
      attempts: [],
      receiptId: null,
      nearTx: null,
      idempotencyKey: idempotencyKey ?? null,
      createdAt: this.iso(),
      expiresAt: this.iso(this.now() + minutes * 60_000),
      paidAt: null,
      splitId: p.splitId ?? null,
      escrowId: p.escrowId ?? null,
      // Splits and escrows settle into the contract on NEAR; otherwise the merchant's preference applies.
      payout: p.splitId !== undefined || p.escrowId !== undefined ? null : (m.payout ?? null),
    };
    await this.cfg.store.putSession(s);
    return s;
  }

  private async checkEscrowFundable(m: Pick<Merchant, "account">, id: number, amount: string) {
    const e = Number.isInteger(id) && id >= 0 ? await this.reader.escrow(id) : null;
    if (!e) throw new CheckoutError(400, "no such escrow");
    if (e.payee !== m.account) throw new CheckoutError(403, "that escrow pays someone else");
    if (e.status !== "AwaitingFunds") throw new CheckoutError(409, `escrow #${id} is ${e.status}`);
    if (e.total !== amount) throw new CheckoutError(400, `amount must equal the escrow total (${e.total})`);
  }

  async getSession(id: string): Promise<CheckoutSessionRecord> {
    const s = /^cs_[A-Za-z0-9]{10,40}$/.test(id) ? await this.cfg.store.getSession(id) : null;
    if (!s) throw new CheckoutError(404, "no such checkout session");
    return s;
  }

  async view(s: CheckoutSessionRecord): Promise<CheckoutSession> {
    const m = (await this.cfg.store.getMerchant(s.merchantId))!;
    const last = s.attempts.at(-1);
    const rec = last ? await this.cfg.store.getPayment(last) : null;
    const q = rec?.quote.quote;
    return {
      id: s.id,
      object: "checkout.session",
      merchant: { name: m.name, account: m.account },
      amount: s.amount,
      amountFormatted: formatUsd(s.amount),
      currency: "USD",
      description: s.description,
      reference: s.reference,
      metadata: s.metadata,
      status: s.status,
      url: `${this.cfg.publicUrl}/c/${s.id}`,
      successUrl: s.successUrl,
      cancelUrl: s.cancelUrl,
      payment:
        rec && q
          ? {
              depositAddress: rec.depositAddress,
              depositMemo: q.depositMemo ?? null,
              asset: rec.quote.quoteRequest.originAsset,
              chain: rec.originChain,
              amountIn: q.amountIn,
              amountInFormatted: q.amountInFormatted,
              deadline: q.deadline ?? rec.quote.quoteRequest.deadline,
              status: rec.status,
            }
          : null,
      receipt: s.receiptId !== null ? { id: s.receiptId, nearTx: s.nearTx, contract: this.cfg.app } : null,
      split: s.splitId !== null && s.splitId !== undefined ? { id: s.splitId, shares: (await this.splitShares(s.splitId)) ?? [] } : null,
      escrowId: s.escrowId ?? null,
      payout: s.payout ?? null,
      feeBps: this.cfg.fee?.bps ?? 0,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      paidAt: s.paidAt,
    };
  }

  private splitCache = new Map<number, { account: string; bps: number }[]>();
  private async splitShares(id: number) {
    if (!this.splitCache.has(id)) {
      const r = await this.reader.split(id);
      if (r) this.splitCache.set(id, r.shares); // splits are immutable
    }
    return this.splitCache.get(id) ?? null;
  }

  // ------------------------------------------------------------ paying

  /**
   * The one place a checkout quote is built. Recipient is the merchant, or the
   * Cascade contract with msg {"split": id} for a split session; the merchant
   * always receives exactly `amount` (EXACT_OUTPUT); any Cascade fee is added
   * on top for the payer.
   */
  quoteFor(s: CheckoutSessionRecord, a: PayAsset, refund: RefundRoute, dry: boolean) {
    const split = s.splitId !== null && s.splitId !== undefined;
    const escrow = s.escrowId !== null && s.escrowId !== undefined;
    const payout = !split && !escrow ? (s.payout ?? null) : null;
    const msg = split ? JSON.stringify({ split: s.splitId }) : escrow ? JSON.stringify({ escrow: s.escrowId }) : null;
    return incomingQuote({
      payAsset: a.assetId,
      owner: msg ? this.cfg.app : (payout?.address ?? s.owner),
      ...(payout ? { destAsset: USDC_BY_CHAIN[payout.chain]! } : {}),
      amountOut: BigInt(s.amount),
      refundTo: refund.refundTo,
      refundType: refund.type,
      dry,
      now: this.now(),
      ...(msg ? { recipientMsg: msg } : {}),
      ...(this.cfg.fee ? { appFee: this.cfg.fee } : {}),
    });
  }

  async assets(): Promise<PayAsset[]> {
    if (this.assetsCache && this.now() - this.assetsCache.at < 60_000) return this.assetsCache.assets;
    const tokens: Token[] = await this.cfg.oneclick.tokens();
    const assets = tokens
      .filter((t) => t.price > 0)
      .map((t) => ({
        assetId: t.assetId,
        chain: t.blockchain,
        symbol: t.symbol || assetSymbol(t.assetId),
        decimals: t.decimals,
        contractAddress: t.contractAddress ?? null,
        priceUsd: t.price,
      }));
    this.assetsCache = { at: this.now(), assets };
    return assets;
  }

  async asset(assetId: string): Promise<PayAsset> {
    const a = (await this.assets()).find((x) => x.assetId === assetId);
    if (!a) throw new CheckoutError(400, "unsupported payment asset");
    return a;
  }

  assertPayable(s: CheckoutSessionRecord) {
    if (s.status === "paid") throw new CheckoutError(409, "this session is already paid");
    if (s.status === "expired" || Date.parse(s.expiresAt) <= this.now()) throw new CheckoutError(410, "this session has expired");
  }

  /** Free price preview (dry quote): no deposit address is reserved. */
  async preview(id: string, assetId: string): Promise<PaymentPreview> {
    const s = await this.getSession(id);
    this.assertPayable(s);
    const a = await this.asset(assetId);
    const q = await this.cfg.oneclick.quote(this.quoteFor(s, a, { refundTo: previewRefund(a.chain), type: "ORIGIN_CHAIN" }, true));
    return { asset: a, amountIn: q.quote.amountIn, amountInFormatted: q.quote.amountInFormatted, amountInUsd: q.quote.amountInUsd, amountOut: q.quote.amountOut, timeEstimateSeconds: q.quote.timeEstimate };
  }

  /** The payer confirmed: reserve a one-time deposit address. Refunds (if any) go to `refundTo`, the payer's own address. */
  async startPayment(id: string, p: { assetId: string; refundTo: string }): Promise<CheckoutSession> {
    if (!p.refundTo || p.refundTo.length > 128) throw new CheckoutError(400, "refundTo (your own address on the paying chain) is required");
    const s = await this.getSession(id);
    await this.reserve(s, await this.asset(p.assetId), { refundTo: p.refundTo, type: "ORIGIN_CHAIN" });
    return this.view(await this.getSession(id));
  }

  /** Reserve a deposit address for one payment attempt and start tracking it. */
  async reserve(s: CheckoutSessionRecord, a: PayAsset, refund: RefundRoute): Promise<PaymentRecord> {
    this.assertPayable(s);
    const fresh = await this.getSession(s.id);
    if (fresh.attempts.length >= MAX_ATTEMPTS) throw new CheckoutError(429, "too many payment attempts for this session");
    // Re-check right before money can move: the escrow must still be waiting for exactly this amount.
    if (fresh.escrowId !== null && fresh.escrowId !== undefined) await this.checkEscrowFundable({ account: fresh.owner }, fresh.escrowId, fresh.amount);
    const q = await this.cfg.oneclick.quote(this.quoteFor(fresh, a, refund, false));
    const dep = q.quote.depositAddress;
    if (!dep) throw new CheckoutError(502, "1Click returned no deposit address");
    const rec: PaymentRecord = {
      depositAddress: dep, direction: "in", owner: s.owner, invoiceId: null, sessionId: s.id, batchId: null, lineIdx: null,
      counterparty: s.reference ? `checkout ${s.reference}` : `checkout ${s.id}`, originChain: a.chain, destChain: s.payout?.chain ?? "near", quote: q,
      status: "PENDING_DEPOSIT", recorded: false, nearTx: null, destTx: null, amountOut: null, refundReason: null,
      createdAt: this.iso(), updatedAt: this.iso(),
    };
    await this.cfg.store.putPayment(rec);
    const latest = await this.getSession(s.id);
    await this.cfg.store.putSession({ ...latest, attempts: [...latest.attempts, dep] });
    return rec;
  }

  /** The attempt that delivered the money, once the session is paid. */
  async paidAttempt(s: CheckoutSessionRecord): Promise<PaymentRecord | null> {
    for (const dep of [...s.attempts].reverse()) {
      const rec = await this.cfg.store.getPayment(dep);
      if (rec?.status === "SUCCESS") return rec;
    }
    return null;
  }

  /**
   * Everything needed to check a receipt without trusting Cascade: the
   * on-chain record, the hash that binds it to this session, and 1Click's
   * delivery details.
   */
  async receipt(id: string) {
    const s = await this.getSession(id);
    if (s.status !== "paid" || s.receiptId === null) throw new CheckoutError(404, "this session has no receipt yet");
    const onchain = await this.reader.invoice(s.receiptId);
    const expectedHash = Checkout.receiptHash(s);
    const rec = await this.paidAttempt(s);
    const d = rec?.quote;
    return {
      session: await this.view(s),
      contract: this.cfg.app,
      onchain,
      expectedHash,
      hashMatches: onchain?.metadata_hash === expectedHash,
      depositMatches: onchain?.settlement?.deposit_address === rec?.depositAddress,
      delivery: rec
        ? {
            status: rec.status,
            paidWith: d ? { asset: d.quoteRequest.originAsset, symbol: assetSymbol(d.quoteRequest.originAsset), chain: rec.originChain, amount: d.quote.amountInFormatted } : null,
            depositAddress: rec.depositAddress,
            nearTx: rec.nearTx,
            quoteSignature: d?.signature ?? null,
          }
        : null,
      // Paid by an AI agent: the mandate it acted under, read from the chain now.
      mandate: rec?.agent ? await this.mandate(rec.agent.owner, rec.agent.agent) : null,
    };
  }

  private async mandate(owner: string, agent: string) {
    const a = await this.reader.allowance(owner, agent).catch(() => null);
    if (!a) return null;
    return {
      owner, agent, purpose: a.purpose, authorizedAt: new Date(a.authorized_at_ms).toISOString(),
      perPaymentMax: a.policy.per_payment_max, dailyMax: a.policy.daily_max, expiresAt: new Date(a.policy.expires_at_ms).toISOString(),
      payees: a.policy.payees, totalSpent: a.total_spent, payments: a.payments, revoked: a.revoked,
    };
  }

  /** The payer's wallet returned a tx hash: tell 1Click to look for it now. */
  async submitDeposit(id: string, txHash: string): Promise<CheckoutSession> {
    const s = await this.getSession(id);
    const dep = s.attempts.at(-1);
    if (!dep) throw new CheckoutError(400, "no payment started");
    if (!/^[0-9a-zA-Z]{20,128}$/.test(txHash.replace(/^0x/, ""))) throw new CheckoutError(400, "bad transaction hash");
    await this.cfg.oneclick.submitDeposit({ depositAddress: dep, txHash }).catch(() => undefined);
    return this.view(s);
  }

  /** Hash bound into the on-chain receipt: proves which session a receipt paid. */
  static receiptHash(s: Pick<CheckoutSessionRecord, "id" | "merchantId" | "amount" | "reference" | "payout">): string {
    // The destination is bound in too when it is not the default, so a receipt also proves where the money went.
    return hashDocument({ kind: "checkout", session: s.id, merchant: s.merchantId, amount: s.amount, reference: s.reference, ...(s.payout ? { payout: s.payout } : {}) });
  }

  // ------------------------------------------------------------ settler hooks

  /** Settler recorded a session payment on-chain. */
  async onRecorded(rec: PaymentRecord, receiptId: number | null, nearTx: string): Promise<void> {
    if (!rec.sessionId) return;
    const s = await this.cfg.store.getSession(rec.sessionId);
    if (!s || s.status === "paid") return;
    const paid: CheckoutSessionRecord = { ...s, status: "paid", receiptId, nearTx, paidAt: this.iso() };
    await this.cfg.store.putSession(paid);
    await this.enqueue(paid, "checkout.session.completed");
    for (const f of this.onPaid) await f(paid);
  }

  /** 1Click refunded a session payment to the payer; the session stays open for another try. */
  async onRefunded(rec: PaymentRecord): Promise<void> {
    if (!rec.sessionId) return;
    const s = await this.cfg.store.getSession(rec.sessionId);
    if (!s) return;
    await this.enqueue(s, "checkout.payment.refunded", rec.refundReason ?? undefined);
  }

  /** Sessions past expiry with no payment in flight become expired. */
  async expireSessions(): Promise<number> {
    let n = 0;
    for (const m of await this.cfg.store.listMerchants()) {
      for (const s of await this.cfg.store.listSessions(m.id, 1000)) {
        if (s.status !== "open" || Date.parse(s.expiresAt) > this.now()) continue;
        const last = s.attempts.at(-1);
        const rec = last ? await this.cfg.store.getPayment(last) : null;
        if (rec && !["PENDING_DEPOSIT", "REFUNDED", "FAILED"].includes(rec.status)) continue; // money is moving: wait
        const exp = { ...s, status: "expired" as const };
        await this.cfg.store.putSession(exp);
        await this.enqueue(exp, "checkout.session.expired");
        n++;
      }
    }
    return n;
  }

  // ------------------------------------------------------------ webhooks

  /** Queue a signed webhook for the session's merchant (no-op if they have no webhook URL). */
  async enqueue(s: CheckoutSessionRecord, type: CheckoutEventType, refundReason?: string, refund?: { id: string; amount: string; destTx: string | null }) {
    await this.enqueueEvent(s.merchantId, {
      id: randomId("evt_"),
      type,
      created: this.iso(),
      data: { session: await this.view(s), ...(refundReason ? { refundReason } : {}), ...(refund ? { refund } : {}) },
    });
  }

  /** Queue any signed event for a merchant (no-op without a webhook URL). */
  async enqueueEvent(merchantId: string, event: WebhookEvent) {
    const m = await this.cfg.store.getMerchant(merchantId);
    if (!m?.webhookUrl) return;
    const type = event.type;
    const d: WebhookDelivery = {
      id: event.id, merchantId: m.id, type, body: JSON.stringify(event), attempts: 0,
      nextAttemptAt: this.iso(), status: "pending", lastError: null, createdAt: this.iso(),
    };
    await this.cfg.store.putWebhook(d);
  }

  /**
   * Send due webhooks. 2xx = delivered. Anything else is retried with
   * exponential backoff (10s, 20s, 40s ... ~21 min), then marked failed.
   */
  async deliverWebhooks(f: typeof fetch = fetch): Promise<{ delivered: number; failed: number }> {
    let delivered = 0;
    let failed = 0;
    for (const d of await this.cfg.store.listDueWebhooks(this.iso())) {
      const m = await this.cfg.store.getMerchant(d.merchantId);
      if (!m?.webhookUrl) {
        await this.cfg.store.putWebhook({ ...d, status: "failed", lastError: "no webhook URL" });
        continue;
      }
      let error: string | null = null;
      try {
        const r = await f(m.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json", [SIGNATURE_HEADER]: await signWebhook(m.webhookSecret, d.body, Math.floor(this.now() / 1000)), "user-agent": "Cascade-Webhooks/1" },
          body: d.body,
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        if (r.status < 200 || r.status >= 300) error = `HTTP ${r.status}`;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const attempts = d.attempts + 1;
      if (!error) {
        await this.cfg.store.putWebhook({ ...d, attempts, status: "delivered", lastError: null });
        delivered++;
      } else if (attempts >= WEBHOOK_MAX_ATTEMPTS) {
        await this.cfg.store.putWebhook({ ...d, attempts, status: "failed", lastError: error });
        failed++;
      } else {
        await this.cfg.store.putWebhook({ ...d, attempts, lastError: error, nextAttemptAt: this.iso(this.now() + 10_000 * 2 ** (attempts - 1)) });
      }
    }
    return { delivered, failed };
  }
}

/** Webhook URLs must be https (http allowed only for localhost, for development). */
export function validateWebhookUrl(u: string): void {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    throw new CheckoutError(400, "webhookUrl is not a URL");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new CheckoutError(400, "webhookUrl must be https");
}

/** Plug checkout (and refunds) into the settler (services/settler SettlerHooks). */
export function checkoutHooks(
  c: Checkout,
  f: typeof fetch = fetch,
  refunds?: { onOutgoing(rec: PaymentRecord): Promise<void>; refreshFunding(): Promise<void> },
  billing?: { tick(): Promise<unknown> },
) {
  return {
    receiptHash: async (rec: PaymentRecord) => {
      if (!rec.sessionId || rec.direction !== "in") return null;
      const s = await c.cfg.store.getSession(rec.sessionId);
      return s ? Checkout.receiptHash(s) : null;
    },
    recorded: (rec: PaymentRecord, receiptId: number | null, tx: string) => c.onRecorded(rec, receiptId, tx),
    refunded: (rec: PaymentRecord) => c.onRefunded(rec),
    outgoing: async (rec: PaymentRecord) => {
      await refunds?.onOutgoing(rec);
    },
    afterTick: async () => {
      await refunds?.refreshFunding();
      await billing?.tick();
      await c.expireSessions();
      await c.deliverWebhooks(f);
    },
  };
}
