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
  receipts_outcome: { outcome: { logs: string[]; status: { SuccessValue?: string; Failure?: unknown } | string } }[];
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

export function parseOutcome<T>(o: Outcome): TxResult<T> {
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
  return {
    hash: o.transaction.hash,
    ok: top.Failure === undefined,
    value: decodeValue(top.SuccessValue) as T | undefined,
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
  async send<T = unknown>(account: Account, call: Call): Promise<TxResult<T>> {
    const r = await account.signAndSendTransaction({
      receiverId: call.receiverId,
      actions: call.actions,
      waitUntil: "FINAL",
      throwOnFailure: false,
    });
    return parseOutcome<T>(r as unknown as Outcome);
  }

  async txStatus(hash: string, sender: string): Promise<TxResult> {
    const r = await this.provider.viewTransactionStatus({ txHash: hash, accountId: sender, waitUntil: "FINAL" } as never);
    return parseOutcome(r as unknown as Outcome);
  }

  async nearBalance(accountId: string): Promise<bigint> {
    const s = await this.account(accountId).getState();
    return BigInt((s as { balance: { available: bigint } }).balance.available);
  }

  async ftBalance(token: string, accountId: string): Promise<bigint> {
    return BigInt(await this.view<string>(token, "ft_balance_of", { account_id: accountId }));
  }
}
