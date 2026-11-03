import { actions, type Action } from "near-api-js";
import type { FundMsg, LineInput, OwnerKind, Share } from "@cascade/core";
import { actProposalArgs, type ProposalInput, type ProposalKind, type VoteAction } from "@cascade/sputnik";

/**
 * A call is just "these actions on that receiver". Builders here never sign
 * or send anything, so the same call can go out directly from a full key, or
 * be wrapped in a NEP-366 meta-transaction and relayed for free.
 */
export interface Call {
  receiverId: string;
  actions: Action[];
  /** Human summary for logs and confirmation screens. */
  label: string;
}

export const TGAS = 1_000_000_000_000n;
const fc = (receiverId: string, label: string, method: string, args: object, gas: bigint, deposit = 0n): Call => ({
  receiverId,
  label,
  actions: [actions.functionCall(method, args, gas, deposit)],
});

export function appCalls(app: string) {
  return {
    registerOwner: (kind: OwnerKind, preparers: string[]) =>
      fc(app, `register as ${kind === "Dao" ? "a team" : "a person"}`, "register_owner", { kind, preparers }, 20n * TGAS),
    createInvoice: (owner: string, amount: bigint, metadataHash: string) =>
      fc(app, `create invoice for ${owner}`, "create_invoice", { owner, amount: amount.toString(), metadata_hash: metadataHash }, 20n * TGAS),
    voidInvoice: (id: number) => fc(app, `void invoice #${id}`, "void_invoice", { id }, 20n * TGAS),
    markInvoicePaid: (id: number, depositAddress: string, amountOut: bigint, destTx: string) =>
      fc(app, `mark invoice #${id} paid`, "mark_invoice_paid", { id, deposit_address: depositAddress, amount_out: amountOut.toString(), dest_tx: destTx }, 20n * TGAS),
    recordLinkPayment: (owner: string, depositAddress: string, amountOut: bigint, destTx: string, metadataHash: string) =>
      fc(app, `record link payment for ${owner}`, "record_link_payment", {
        owner, deposit_address: depositAddress, amount_out: amountOut.toString(), dest_tx: destTx, metadata_hash: metadataHash,
      }, 20n * TGAS),
    createBatch: (owner: string, lines: LineInput[]) =>
      fc(app, `create batch of ${lines.length} for ${owner}`, "create_batch", { owner, lines }, 100n * TGAS),
    cancelBatch: (id: number) => fc(app, `cancel batch #${id}`, "cancel_batch", { id }, 20n * TGAS),
    setBatchProposal: (id: number, proposalId: number) =>
      fc(app, `link batch #${id} to proposal ${proposalId}`, "set_batch_proposal", { id, proposal_id: proposalId }, 20n * TGAS),
    executeBatch: (id: number, limit = 8) =>
      fc(app, `pay up to ${limit} lines of batch #${id}`, "execute_batch", { id, limit }, 300n * TGAS),
    refundFailed: (id: number) => fc(app, `refund failed lines of batch #${id}`, "refund_failed", { id }, 100n * TGAS),
    createSplit: (owner: string, shares: Share[]) => fc(app, `create a revenue split for ${owner}`, "create_split", { owner, shares }, 30n * TGAS),
  };
}

export function ftCalls(token: string) {
  return {
    /** Fund a batch: the owner sends exactly the total, quoting the hash. */
    fundBatch: (app: string, total: bigint, msg: FundMsg) =>
      fc(token, `fund batch #${msg.batch_id}`, "ft_transfer_call", { receiver_id: app, amount: total.toString(), msg: JSON.stringify(msg) }, 100n * TGAS, 1n),
    /** Pay into a revenue split (what 1Click does with customRecipientMsg). */
    payToSplit: (app: string, amount: bigint, splitId: number) =>
      fc(token, `pay ${amount} into split #${splitId}`, "ft_transfer_call", { receiver_id: app, amount: amount.toString(), msg: JSON.stringify({ split: splitId }) }, 100n * TGAS, 1n),
    transfer: (to: string, amount: bigint, memo?: string) =>
      fc(token, `send ${amount} to ${to}`, "ft_transfer", { receiver_id: to, amount: amount.toString(), ...(memo ? { memo } : {}) }, 15n * TGAS, 1n),
    storageDeposit: (account: string, deposit = 1_250_000_000_000_000_000_000n) =>
      fc(token, `register ${account} with token`, "storage_deposit", { account_id: account, registration_only: true }, 10n * TGAS, deposit),
    mint: (account: string, amount: bigint) =>
      fc(token, `mint ${amount} to ${account}`, "mint", { account_id: account, amount: amount.toString() }, 10n * TGAS),
    setBlocked: (account: string, blocked: boolean) =>
      fc(token, `${blocked ? "block" : "unblock"} ${account}`, "set_blocked", { account_id: account, blocked }, 10n * TGAS),
  };
}

export function daoCalls(dao: string) {
  return {
    addProposal: (p: ProposalInput, bond = 0n) => fc(dao, `propose on ${dao}`, "add_proposal", { proposal: p }, 50n * TGAS, bond),
    act: (id: number, action: VoteAction, kind: ProposalKind) =>
      fc(dao, `${action} proposal ${id} on ${dao}`, "act_proposal", actProposalArgs(id, action, kind), 300n * TGAS),
  };
}

export function factoryCalls(factory: string) {
  return {
    createName: (name: string, publicKey: string, appKey?: string) =>
      fc(factory, `create ${name}.${factory}`, "create_name", { name, public_key: publicKey, ...(appKey ? { app_key: appKey } : {}) }, 100n * TGAS),
  };
}
