import type { Account } from "near-api-js";
import { CascadeReader, appCalls, type Chain } from "@cascade/near";
import type { SettlerChain } from "./settler.js";

/** SettlerChain over near-api-js. The settler account pays its own gas. */
export function nearSettlerChain(chain: Chain, settler: Account, app: string): SettlerChain {
  const read = new CascadeReader(chain, app);
  const calls = appCalls(app);
  return {
    markInvoicePaid: (id, dep, amt, tx) => chain.send(settler, calls.markInvoicePaid(id, dep, amt, tx)),
    recordLinkPayment: (owner, dep, amt, tx, h) => chain.send(settler, calls.recordLinkPayment(owner, dep, amt, tx, h)),
    isDepositRecorded: (dep) => read.isDepositRecorded(dep),
    batch: (id) => read.batch(id),
    lines: (id) => read.lines(id),
    executeBatch: (id, limit) => chain.send(settler, calls.executeBatch(id, limit)),
    refundFailed: (id) => chain.send(settler, calls.refundFailed(id)),
  };
}
