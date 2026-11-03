import {
  USDC_BY_CHAIN, formatDest, hashDocument, isAccountId, type Batch, type CreatedBatch, type Invoice, type LineInput,
} from "@cascade/core";
import type { BatchDoc, BatchLineDoc, InvoiceDoc, PaymentRecord, Store } from "@cascade/db";
import { CascadeReader, appCalls, daoCalls, ftCalls, type Call, type Chain } from "@cascade/near";
import { incomingQuote, outgoingQuote, type OneClick, type QuoteResponse } from "@cascade/oneclick";
import { fundBatchProposal, registerOwnerProposal } from "@cascade/sputnik";
import { expectOk, type Executor } from "./executor.js";

export interface EngineConfig {
  chain: Chain;
  oneclick: OneClick;
  store: Store;
  app: string;
  usdc: string;
  /** Public base URL for links in proposals, e.g. https://cascade.link */
  publicUrl?: string;
  now?: () => number;
}

export interface NewInvoice {
  owner: string;
  amount: bigint;
  title: string;
  client: { name: string; email?: string };
  items?: InvoiceDoc["items"];
  dueDate?: string;
  memo?: string;
}

export interface PayeeInput {
  name: string;
  /** "near" or a 1Click chain id (sol, base, eth, arb...) */
  chain: string;
  address: string;
  /** USDC base units the payee should receive */
  amount: bigint;
  private?: boolean;
}

/**
 * Cascade's use cases. Stateless apart from the store; every on-chain write
 * goes through an `Executor` the caller supplies, so the same code serves
 * the web app (gasless), the demo and the tests.
 */
export class Engine {
  readonly reader: CascadeReader;
  private readonly now: () => number;

  constructor(readonly cfg: EngineConfig) {
    this.reader = new CascadeReader(cfg.chain, cfg.app);
    this.now = cfg.now ?? Date.now;
  }

  private iso() {
    return new Date(this.now()).toISOString();
  }

  // ----------------------------------------------------------- owners

  registerPerson(exec: Executor) {
    return exec(appCalls(this.cfg.app).registerOwner("Account", [])).then((r) => expectOk(r, "register"));
  }

  /** Call for a DAO member to propose that the DAO registers with Cascade. */
  proposeRegisterDao(dao: string, preparers: string[]): Call {
    return daoCalls(dao).addProposal(registerOwnerProposal(this.cfg.app, preparers));
  }

  // ----------------------------------------------------------- getting paid

  async createInvoice(exec: Executor, inv: NewInvoice): Promise<{ invoice: Invoice; doc: InvoiceDoc }> {
    const body = {
      owner: inv.owner,
      amount: inv.amount.toString(),
      title: inv.title,
      client: inv.client,
      items: inv.items ?? [{ description: inv.title, quantity: 1, unitPrice: inv.amount.toString() }],
      ...(inv.dueDate ? { dueDate: inv.dueDate } : {}),
      ...(inv.memo ? { memo: inv.memo } : {}),
    };
    const metadataHash = hashDocument(body);
    const r = expectOk(await exec<Invoice>(appCalls(this.cfg.app).createInvoice(inv.owner, inv.amount, metadataHash)), "create invoice");
    const invoice = r.value!;
    const doc: InvoiceDoc = { id: invoice.id, ...body, metadataHash, createdAt: this.iso() };
    await this.cfg.store.putInvoice(doc);
    return { invoice, doc };
  }

  /**
   * What the payer sees after choosing a coin. `dry: true` is a free preview
   * (no deposit address). `dry: false` reserves a deposit address and starts
   * tracking it; only call it when the payer confirms.
   */
  async quoteForPayer(p: {
    owner: string;
    amount: bigint;
    payAsset: string;
    payChain: string;
    refundTo: string;
    payer: string;
    invoiceId?: number;
    dry: boolean;
  }): Promise<QuoteResponse> {
    if (p.invoiceId !== undefined) {
      const inv = await this.reader.invoice(p.invoiceId);
      if (!inv || inv.owner !== p.owner) throw new Error("no such invoice for this owner");
      if (inv.status !== "Open") throw new Error(`invoice is ${inv.status.toLowerCase()}`);
      if (BigInt(inv.amount) !== p.amount) throw new Error("amount does not match the invoice");
    }
    const q = await this.cfg.oneclick.quote(
      incomingQuote({ payAsset: p.payAsset, owner: p.owner, amountOut: p.amount, refundTo: p.refundTo, dry: p.dry, now: this.now() }),
    );
    if (!p.dry) {
      const addr = q.quote.depositAddress;
      if (!addr) throw new Error("1Click returned no deposit address");
      const rec: PaymentRecord = {
        depositAddress: addr, direction: "in", owner: p.owner, invoiceId: p.invoiceId ?? null, batchId: null, lineIdx: null,
        counterparty: p.payer, originChain: p.payChain, destChain: "near", quote: q, status: "PENDING_DEPOSIT",
        recorded: false, nearTx: null, destTx: null, amountOut: null, refundReason: null, createdAt: this.iso(), updatedAt: this.iso(),
      };
      await this.cfg.store.putPayment(rec);
    }
    return q;
  }

  /** The payer (or their wallet) tells us the deposit tx hash to speed things up. */
  async submitDeposit(depositAddress: string, txHash: string) {
    return this.cfg.oneclick.submitDeposit({ depositAddress, txHash });
  }

  // ----------------------------------------------------------- paying out

  /**
   * Turn payees into locked batch lines. Cross-chain and private payees get a
   * real 1Click quote now; its deposit address becomes the line's recipient
   * and its deadline is enforced by the contract.
   */
  async quoteLines(owner: string, payees: PayeeInput[], deadlineMs?: number): Promise<{ lines: LineInput[]; docs: BatchLineDoc[]; quotes: (QuoteResponse | null)[] }> {
    const lines: LineInput[] = [];
    const docs: BatchLineDoc[] = [];
    const quotes: (QuoteResponse | null)[] = [];
    for (const p of payees) {
      if (p.amount <= 0n) throw new Error(`amount for ${p.name} must be positive`);
      if (p.chain === "near" && !p.private) {
        if (!isAccountId(p.address)) throw new Error(`${p.address} is not a NEAR account`);
        lines.push({ recipient: p.address, amount: p.amount.toString(), kind: "Near", dest: null, deadline_ms: null });
        docs.push({ name: p.name, chain: "near", address: p.address, amount: p.amount.toString(), private: false, depositAddress: null });
        quotes.push(null);
        continue;
      }
      const destAsset = USDC_BY_CHAIN[p.chain];
      if (!destAsset) throw new Error(`cannot pay out on ${p.chain} yet`);
      const q = await this.cfg.oneclick.quote(
        outgoingQuote({ destAsset, recipient: p.address, owner, mode: "recipient_gets", amount: p.amount, private: p.private ?? false, dry: false, now: this.now(), ...(deadlineMs ? { deadlineMs } : {}) }),
      );
      const dep = q.quote.depositAddress;
      if (!dep || !q.quote.deadline) throw new Error("1Click returned no deposit address");
      lines.push({
        recipient: dep,
        amount: q.quote.amountIn,
        kind: p.private ? "Private" : "CrossChain",
        dest: formatDest(p.chain, p.address),
        deadline_ms: Date.parse(q.quote.deadline),
      });
      docs.push({ name: p.name, chain: p.chain, address: p.address, amount: p.amount.toString(), private: p.private ?? false, depositAddress: dep });
      quotes.push(q);
    }
    return { lines, docs, quotes };
  }

  async createBatch(exec: Executor, p: { owner: string; title: string; payees: PayeeInput[]; deadlineMs?: number }): Promise<CreatedBatch> {
    const ownerInfo = await this.reader.owner(p.owner);
    if (!ownerInfo) throw new Error(`${p.owner} is not registered with Cascade`);
    const { lines, docs, quotes } = await this.quoteLines(p.owner, p.payees, p.deadlineMs);
    const created = expectOk(await exec<CreatedBatch>(appCalls(this.cfg.app).createBatch(p.owner, lines)), "create batch").value!;
    const doc: BatchDoc = { id: created.id, owner: p.owner, ownerKind: ownerInfo.kind, title: p.title, lines: docs, proposalId: null, approvers: [], createdAt: this.iso() };
    await this.cfg.store.putBatch(doc);
    for (const [i, q] of quotes.entries()) {
      if (!q) continue;
      const d = docs[i]!;
      await this.cfg.store.putPayment({
        depositAddress: d.depositAddress!, direction: "out", owner: p.owner, invoiceId: null, batchId: created.id, lineIdx: i,
        counterparty: d.name, originChain: "near", destChain: d.chain, quote: q, status: "PENDING_DEPOSIT", recorded: false,
        nearTx: null, destTx: null, amountOut: null, refundReason: null, createdAt: this.iso(), updatedAt: this.iso(),
      });
    }
    return created;
  }

  /** A person funds their own batch (signed by them, relayed for free). */
  fundCall(batch: Pick<Batch, "id" | "hash" | "total">): Call {
    return ftCalls(this.cfg.usdc).fundBatch(this.cfg.app, BigInt(batch.total), { batch_id: batch.id, hash: batch.hash });
  }

  /** A team member proposes that the DAO funds a batch. */
  proposeFundingCall(dao: string, batch: Batch): Call {
    const link = this.cfg.publicUrl ? `${this.cfg.publicUrl}/team/${dao}/batches/${batch.id}` : undefined;
    return daoCalls(dao).addProposal(fundBatchProposal({ usdc: this.cfg.usdc, cascade: this.cfg.app, batch, ...(link ? { link } : {}) }));
  }

  async linkProposal(exec: Executor, batchId: number, proposalId: number) {
    expectOk(await exec(appCalls(this.cfg.app).setBatchProposal(batchId, proposalId)), "link proposal");
    const doc = await this.cfg.store.getBatch(batchId);
    if (doc) await this.cfg.store.putBatch({ ...doc, proposalId });
  }
}
