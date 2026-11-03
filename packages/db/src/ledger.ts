import { assetSymbol, formatUsd } from "@cascade/core";
import { plainStatus } from "@cascade/oneclick";
import type { Batch, Line } from "@cascade/core";
import type { Store } from "./records.js";

/**
 * The accountant's CSV. One row per money movement, in or out, with every
 * number an accountant would otherwise have to ask for.
 */
export interface LedgerRow {
  date: string; // YYYY-MM-DD (UTC)
  direction: "in" | "out";
  counterparty: string;
  reference: string; // "Invoice #3", "Payment link", "Payroll #4 line 2"
  status: string; // Paid / Pending / Refunded / Failed
  gross_usd: string; // what the payer paid, in USD
  fee_usd: string; // gross - net
  net_usdc: string; // what arrived (in) or left (out) in USDC
  paid_with: string; // e.g. "0.0022 ETH on base"
  rate: string; // USD per unit of the payment asset
  origin_chain: string;
  destination_chain: string;
  near_tx: string;
  destination_tx: string;
  deposit_address: string;
  proposal_id: string;
  approvers: string;
}

export const LEDGER_COLUMNS: (keyof LedgerRow)[] = [
  "date", "direction", "counterparty", "reference", "status", "gross_usd", "fee_usd", "net_usdc", "paid_with",
  "rate", "origin_chain", "destination_chain", "near_tx", "destination_tx", "deposit_address", "proposal_id", "approvers",
];

const usd = (s: string | undefined) => (s ? Number(s).toFixed(2) : "");
/** USDC base units -> dollars rounded to cents, for the USD columns. */
const cents = (units: string | bigint) => (Number(BigInt(units)) / 1e6).toFixed(2);

export interface ChainLineSource {
  batch(id: number): Promise<Batch | null>;
  lines(id: number): Promise<Line[]>;
}

export async function ledgerRows(store: Store, owner: string, opts: { month?: string; chain?: ChainLineSource } = {}): Promise<LedgerRow[]> {
  const rows: LedgerRow[] = [];
  const inMonth = (iso: string) => !opts.month || iso.startsWith(opts.month);

  for (const p of await store.listPayments({ owner, direction: "in" })) {
    if (!inMonth(p.createdAt)) continue;
    const q = p.quote.quote;
    const net = p.amountOut ?? q.amountOut;
    const gross = Number(q.amountInUsd);
    const rate = Number(q.amountInFormatted) > 0 ? (gross / Number(q.amountInFormatted)).toFixed(2) : "";
    rows.push({
      date: p.createdAt.slice(0, 10),
      direction: "in",
      counterparty: p.counterparty,
      reference: p.invoiceId !== null ? `Invoice #${p.invoiceId}` : "Payment link",
      status: plainStatus(p.status),
      gross_usd: usd(q.amountInUsd),
      fee_usd: (gross - Number(formatUsd(net))).toFixed(2),
      net_usdc: formatUsd(net),
      paid_with: `${q.amountInFormatted} ${assetSymbol(p.quote.quoteRequest.originAsset)} on ${p.originChain}`,
      rate,
      origin_chain: p.originChain,
      destination_chain: "near",
      near_tx: p.nearTx ?? "",
      destination_tx: p.destTx ?? "",
      deposit_address: p.depositAddress,
      proposal_id: "",
      approvers: "",
    });
  }

  for (const b of await store.listBatches(owner)) {
    if (!inMonth(b.createdAt)) continue;
    const onChain = opts.chain ? await opts.chain.lines(b.id) : [];
    for (const [i, l] of b.lines.entries()) {
      const p = l.depositAddress ? await store.getPayment(l.depositAddress) : null;
      const chainLine = onChain[i];
      const status = p ? plainStatus(p.status) : chainLine ? ({ Sent: "Paid", Refunded: "Refunded", Failed: "Failed" } as Record<string, string>)[chainLine.status] ?? "Pending" : "Pending";
      const sent = chainLine?.amount ?? p?.quote.quote.amountIn ?? l.amount;
      rows.push({
        date: b.createdAt.slice(0, 10),
        direction: "out",
        counterparty: l.name,
        reference: `${b.ownerKind === "Dao" ? "Payroll" : "Batch"} #${b.id} line ${i + 1}`,
        status,
        gross_usd: cents(sent),
        fee_usd: (Number(formatUsd(sent)) - Number(formatUsd(l.amount))).toFixed(2),
        net_usdc: formatUsd(l.amount),
        paid_with: `${formatUsd(sent)} USDC on near`,
        rate: "1.00",
        origin_chain: "near",
        destination_chain: l.chain,
        near_tx: p?.nearTx ?? "",
        destination_tx: p?.destTx ?? "",
        deposit_address: l.depositAddress ?? "",
        proposal_id: b.proposalId === null ? "" : String(b.proposalId),
        approvers: b.approvers.join(" "),
      });
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

function cell(v: string): string {
  // Quote when needed; neutralise spreadsheet formulas (CSV injection).
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: LedgerRow[]): string {
  return [LEDGER_COLUMNS.join(","), ...rows.map((r) => LEDGER_COLUMNS.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}
