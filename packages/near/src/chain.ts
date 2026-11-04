import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import type { Call } from "./calls.js";

export type NetworkId = "mainnet" | "testnet" | "sandbox";

export interface CascadeEvent {
  standard: string;
  event: string;
  data: Record<string, unknown>[];
}

export interface TxResult<T = unknown> {
  hash: string;
  ok: boolean;
  value: T | undefined;
  /** Every EVENT_JSON log from every receipt, in order. */
  events: CascadeEvent[];
  logs: string[];
  /** First failure message, if any receipt failed. */
  error?: string;
}

type Outcome = {
  transaction: { hash: string };
  status: { SuccessValue?: string; Failure?: unknown } | string;
  transaction_outcome: { outcome: { logs: string[] } };
  receipts_outcome: { outcome: { logs: string[]; executor_id: string; status: { SuccessValue?: string; Failure?: unknown } | string } }[];
};

function decodeValue(v: string | undefined): unknown {
  if (!v) return undefined;
  const s = Buffer.from(v, "base64").toString("utf8");
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * @param target For meta-transactions the outer transaction only runs the
 * delegate action, so its own status says nothing about the user's call.
 * Pass the inner receiver: success then means that contract's first receipt
 * did not fail, and the value is the last value that contract returned
 * (which follows promise chains like ft_transfer_call -> ft_resolve_transfer).
 */
export function parseOutcome<T>(o: Outcome, target?: string): TxResult<T> {
  const logs = [...o.transaction_outcome.outcome.logs, ...o.receipts_outcome.flatMap((r) => r.outcome.logs)];
  const events: CascadeEvent[] = [];
  for (const l of logs) {
    if (!l.startsWith("EVENT_JSON:")) continue;
    try {
      events.push(JSON.parse(l.slice("EVENT_JSON:".length)));
    } catch {
      /* not ours */
    }
  }
  const failure = o.receipts_outcome
    .map((r) => (typeof r.outcome.status === "object" ? r.outcome.status.Failure : undefined))
    .find((f) => f !== undefined);
  const top = typeof o.status === "object" ? o.status : {};
  let ok = top.Failure === undefined;
  let value = decodeValue(top.SuccessValue);
  if (target) {
    const mine = o.receipts_outcome.filter((r) => r.outcome.executor_id === target);
    const first = mine[0]?.outcome.status;
    ok = ok && mine.length > 0 && !(typeof first === "object" && first.Failure !== undefined);
    const vals = mine.map((r) => (typeof r.outcome.status === "object" ? r.outcome.status.SuccessValue : undefined)).filter((v) => v);
    value = decodeValue(vals.at(-1));
  }
  return {
    hash: o.transaction.hash,
    ok,
    value: value as T | undefined,
    events,
    logs,
    ...(failure !== undefined ? { error: JSON.stringify(failure) } : {}),
  };
}

/** Thin wrapper over near-api-js: views, accounts and sending `Call`s. */
export class Chain {
  readonly provider: JsonRpcProvider;

  constructor(
    readonly rpcUrl: string,
    readonly networkId: NetworkId,
  ) {
    this.provider = new JsonRpcProvider({ url: rpcUrl });
  }

  async view<T>(contractId: string, method: string, args: object = {}): Promise<T> {
    return (await this.provider.callFunction({ contractId, method, args } as never)) as T;
  }

  account(accountId: string, key?: KeyPairString | KeyPair): Account {
    if (!key) return new Account(accountId, this.provider);
    const kp = typeof key === "string" ? KeyPair.fromString(key) : key;
    return new Account(accountId, this.provider, new KeyPairSigner(kp));
  }

  /** Send a call from a full-access (or matching function-call) key. Never throws on contract failure: check `ok`. */
  async send<T = unknown>(account: Account, call: Call, opts: { target?: string } = {}): Promise<TxResult<T>> {
    const r = await account.signAndSendTransaction({
      receiverId: call.receiverId,
      actions: call.actions,
      waitUntil: "FINAL",
      throwOnFailure: false,
    });
    return parseOutcome<T>(r as unknown as Outcome, opts.target);
  }

  async txStatus(hash: string, sender: string): Promise<TxResult> {
    const r = await this.provider.viewTransactionStatus({ txHash: hash, accountId: sender, waitUntil: "FINAL" } as never);
    return parseOutcome(r as unknown as Outcome);
  }

  /**
   * EVENT_JSON events emitted by `executor` in a finished transaction, only
   * from its receipts that succeeded. Other contracts in the same transaction
   * cannot forge them: logs are attributed to the receipt's executor.
   */
  async eventsFrom(hash: string, sender: string, executor: string): Promise<CascadeEvent[]> {
    const o = (await this.provider.viewTransactionStatus({ txHash: hash, accountId: sender, waitUntil: "FINAL" } as never)) as unknown as Outcome;
    const out: CascadeEvent[] = [];
    for (const r of o.receipts_outcome) {
      if (r.outcome.executor_id !== executor) continue;
      if (typeof r.outcome.status === "object" && r.outcome.status.Failure !== undefined) continue;
      for (const l of r.outcome.logs) {
        if (!l.startsWith("EVENT_JSON:")) continue;
        try {
          out.push(JSON.parse(l.slice("EVENT_JSON:".length)));
        } catch {
          /* not an event */
        }
      }
    }
    return out;
  }

  async nearBalance(accountId: string): Promise<bigint> {
    const s = await this.account(accountId).getState();
    return BigInt((s as { balance: { available: bigint } }).balance.available);
  }

  async ftBalance(token: string, accountId: string): Promise<bigint> {
    return BigInt(await this.view<string>(token, "ft_balance_of", { account_id: accountId }));
  }
}
