import type { Account } from "near-api-js";
import { signMeta, type Call, type Chain, type TxResult } from "@cascade/near";

/**
 * How a call reaches the chain. The engine never cares which one it gets:
 * - `direct`: the account signs and pays (settler, relayer, scripts);
 * - `gasless`: the user's key signs a NEP-366 delegate action and the relayer
 *   pays. This is how every user action in Cascade runs.
 */
export type Executor = <T = unknown>(call: Call) => Promise<TxResult<T>>;

export function directExecutor(chain: Chain, account: Account): Executor {
  return (call) => chain.send(account, call);
}

/** Anything that accepts a base64 signed delegate: the HTTP relayer client or an in-process Relayer. */
export interface RelaySink {
  relay(signedDelegateB64: string): Promise<TxResult>;
}

export function gaslessExecutor(account: Account, sink: RelaySink): Executor {
  return async <T>(call: Call) => (await sink.relay(await signMeta(account, call))) as TxResult<T>;
}

/** HTTP client for services/relayer. */
export class RelayerClient implements RelaySink {
  constructor(private readonly baseUrl: string) {}
  async relay(signedDelegate: string): Promise<TxResult> {
    const r = await fetch(`${this.baseUrl}/relay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signedDelegate }) });
    const j = (await r.json()) as TxResult & { error?: string };
    if (!r.ok) throw new Error(`relayer: ${j.error ?? r.status}`);
    return { ...j, logs: [] };
  }
  async createName(name: string, publicKey: string, appKey?: string): Promise<{ accountId: string; hash: string }> {
    const r = await fetch(`${this.baseUrl}/names`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, publicKey, appKey }) });
    const j = (await r.json()) as { accountId: string; hash: string; error?: string };
    if (!r.ok) throw new Error(`relayer: ${j.error ?? r.status}`);
    return j;
  }
}

/** Throw with the chain's message if a transaction failed. */
export function expectOk<T>(r: TxResult<T>, what: string): TxResult<T> {
  if (!r.ok) throw new Error(`${what} failed: ${r.error ?? "unknown error"}`);
  return r;
}
