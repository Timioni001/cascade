import { matches, type BatchDoc, type InvoiceDoc, type PaymentFilter, type PaymentRecord, type Store } from "./records.js";

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements Store {
  private invoices = new Map<number, InvoiceDoc>();
  private payments = new Map<string, PaymentRecord>();
  private batches = new Map<number, BatchDoc>();

  async putInvoice(doc: InvoiceDoc) {
    this.invoices.set(doc.id, clone(doc));
  }
  async getInvoice(id: number) {
    const d = this.invoices.get(id);
    return d ? clone(d) : null;
  }
  async listInvoices(owner: string) {
    return [...this.invoices.values()].filter((d) => d.owner === owner).map(clone);
  }
  async putPayment(rec: PaymentRecord) {
    this.payments.set(rec.depositAddress, clone(rec));
  }
  async getPayment(addr: string) {
    const r = this.payments.get(addr);
    return r ? clone(r) : null;
  }
  async listPayments(f?: PaymentFilter) {
    return [...this.payments.values()].filter((p) => matches(p, f)).map(clone);
  }
  async putBatch(doc: BatchDoc) {
    this.batches.set(doc.id, clone(doc));
  }
  async getBatch(id: number) {
    const d = this.batches.get(id);
    return d ? clone(d) : null;
  }
  async listBatches(owner?: string) {
    return [...this.batches.values()].filter((b) => owner === undefined || b.owner === owner).map(clone);
  }
}
