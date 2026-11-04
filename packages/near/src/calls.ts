import { actions, type Action } from "near-api-js";
import type { AllowancePolicy, FundMsg, LineInput, MilestoneInput, OwnerKind, Share } from "@cascade/core";
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
    createEscrow: (p: { payee: string; payer: string; arbiter?: string | null; milestones: MilestoneInput[]; refundAfterMs: number; metadataHash: string }) =>
      fc(app, `create an escrow ${p.payer} -> ${p.payee}`, "create_escrow", {
        payee: p.payee, payer: p.payer, arbiter: p.arbiter ?? null, milestones: p.milestones, refund_after_ms: p.refundAfterMs, metadata_hash: p.metadataHash,
      }, 30n * TGAS),
    cancelEscrow: (id: number) => fc(app, `cancel escrow #${id}`, "cancel_escrow", { id }, 20n * TGAS),
    releaseMilestone: (id: number, idx: number) => fc(app, `release milestone ${idx + 1} of escrow #${id}`, "release_milestone", { id, idx }, 80n * TGAS),
    refundMilestone: (id: number, idx: number) => fc(app, `refund milestone ${idx + 1} of escrow #${id}`, "refund_milestone", { id, idx }, 80n * TGAS),
    setAllowance: (agent: string, policy: AllowancePolicy, purpose?: string) =>
      fc(app, `set spending limits for ${agent}`, "set_allowance", { agent, policy, purpose: purpose ?? null }, 20n * TGAS),
    agentPay: (owner: string, to: string, amount: bigint, memo: string) =>
      fc(app, `pay ${amount} to ${to} from ${owner}'s allowance`, "agent_pay", { owner, to, amount: amount.toString(), memo }, 80n * TGAS),
    revokeAllowance: (agent: string) => fc(app, `revoke ${agent}`, "revoke_allowance", { agent }, 50n * TGAS),
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
    /** Fund an escrow for exactly its total (anyone may; 1Click does it for a checkout). */
    fundEscrow: (app: string, amount: bigint, escrowId: number) =>
      fc(token, `fund escrow #${escrowId}`, "ft_transfer_call", { receiver_id: app, amount: amount.toString(), msg: JSON.stringify({ escrow: escrowId }) }, 100n * TGAS, 1n),
    /** Top up an agent's allowance (the caller is the owner). */
    fundAllowance: (app: string, amount: bigint, agent: string) =>
      fc(token, `top up ${agent}'s allowance`, "ft_transfer_call", { receiver_id: app, amount: amount.toString(), msg: JSON.stringify({ allowance: agent }) }, 100n * TGAS, 1n),
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
