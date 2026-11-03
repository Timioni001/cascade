import type { DelegateSummary } from "@cascade/near";

/**
 * What the relayer is willing to pay gas for. Everything else is refused.
 *
 * The relayer can only submit what the user signed (NEP-366), so this policy
 * is about cost and abuse, not custody: it stops our gas from being spent on
 * other people's contracts.
 */
export interface RelayPolicyConfig {
  app: string;
  usdc: string;
  /** Max gas per function call action. */
  maxGas: bigint;
  /** Max total gas per delegate. */
  maxTotalGas: bigint;
  /** Is `account` registered with Cascade as a DAO owner? */
  isRegisteredDao: (account: string) => Promise<boolean>;
  /** Sputnik factory account, e.g. sputnik-dao.near. DAOs are its sub-accounts. */
  daoFactory: string;
  /** The kind of proposal `id` as stored on `dao` (view get_proposal), or null. */
  proposalKind: (dao: string, id: number) => Promise<unknown>;
}

/** Methods on the app contract a user may call through the relayer. */
export const APP_METHODS = new Set([
  "register_owner",
  "create_invoice",
  "void_invoice",
  "create_batch",
  "cancel_batch",
  "set_batch_proposal",
  "execute_batch",
  "refund_failed",
]);

export const DAO_METHODS = new Set(["add_proposal", "act_proposal"]);

export type Verdict = { ok: true; kind: "app" | "fund" | "dao" | "dao-onboarding" } | { ok: false; reason: string };

type FcKind = { FunctionCall?: { receiver_id?: string; actions?: { method_name?: string; deposit?: string }[] } };

/** Is this proposal kind exactly "call app.register_owner, nothing else"? */
export function isRegistrationKind(kind: unknown, app: string): boolean {
  const fc = (kind as FcKind | undefined)?.FunctionCall;
  return (
    fc?.receiver_id === app &&
    fc.actions?.length === 1 &&
    fc.actions[0]?.method_name === "register_owner" &&
    (fc.actions[0]?.deposit ?? "0") === "0"
  );
}

export async function checkDelegate(d: DelegateSummary, cfg: RelayPolicyConfig): Promise<Verdict> {
  if (d.otherActions.length > 0) return { ok: false, reason: `only function calls are relayed (got ${d.otherActions.join(", ")})` };
  if (d.calls.length === 0) return { ok: false, reason: "no actions" };
  if (d.calls.length > 4) return { ok: false, reason: "too many actions" };
  let total = 0n;
  for (const c of d.calls) {
    if (c.gas > cfg.maxGas) return { ok: false, reason: `gas ${c.gas} above limit` };
    total += c.gas;
  }
  if (total > cfg.maxTotalGas) return { ok: false, reason: "total gas above limit" };

  if (d.receiverId === cfg.app) {
    for (const c of d.calls) {
      if (!APP_METHODS.has(c.method)) return { ok: false, reason: `method ${c.method} is not relayed` };
      if (c.deposit !== 0n) return { ok: false, reason: "app calls carry no deposit" };
    }
    return { ok: true, kind: "app" };
  }

  if (d.receiverId === cfg.usdc) {
    // The only token call we pay for: a person funding their own batch.
    // The 1 yoctoNEAR comes from the user's own balance, not ours.
    for (const c of d.calls) {
      if (c.method !== "ft_transfer_call") return { ok: false, reason: `token method ${c.method} is not relayed` };
      if (c.deposit !== 1n) return { ok: false, reason: "ft_transfer_call needs exactly 1 yoctoNEAR" };
      const a = c.args as { receiver_id?: string } | undefined;
      if (a?.receiver_id !== cfg.app) return { ok: false, reason: "tokens may only be sent to Cascade" };
    }
    return { ok: true, kind: "fund" };
  }

  if (await cfg.isRegisteredDao(d.receiverId)) {
    for (const c of d.calls) {
      if (!DAO_METHODS.has(c.method)) return { ok: false, reason: `DAO method ${c.method} is not relayed` };
      if (c.deposit !== 0n) return { ok: false, reason: "DAO calls are relayed only with a zero bond" };
    }
    return { ok: true, kind: "dao" };
  }

  // A Sputnik DAO that has not joined yet: the only thing we pay for is the
  // proposal (and the votes) to register it with Cascade. Votes are checked
  // against the proposal as stored on the DAO: the deployed Sputnik v2 does
  // not reject an act_proposal whose `proposal` argument differs from the
  // stored one (contracts/tests/safety.test.ts proves this), so the argument
  // cannot be trusted.
  if (d.receiverId.endsWith(`.${cfg.daoFactory}`)) {
    for (const c of d.calls) {
      const a = c.args as { proposal?: { kind?: unknown }; id?: unknown } | undefined;
      if (c.deposit !== 0n) return { ok: false, reason: "DAO calls are relayed only with a zero bond" };
      if (c.method === "add_proposal" && isRegistrationKind(a?.proposal?.kind, cfg.app)) continue;
      if (c.method === "act_proposal" && typeof a?.id === "number") {
        const stored = await cfg.proposalKind(d.receiverId, a.id).catch(() => null);
        if (isRegistrationKind(stored, cfg.app)) continue;
      }
      return { ok: false, reason: "this DAO is not registered with Cascade yet; only its registration proposal is relayed" };
    }
    return { ok: true, kind: "dao-onboarding" };
  }

  return { ok: false, reason: `receiver ${d.receiverId} is not Cascade, USDC or a registered DAO` };
}
