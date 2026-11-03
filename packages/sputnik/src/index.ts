/**
 * Helpers for Sputnik DAO v2 (the contract deployed under sputnik-dao.near).
 * Cascade never replaces the DAO: the DAO keeps custody and decides. Cascade
 * only proposes calls (register as an owner, fund a batch) and helps members
 * vote on them without paying fees.
 *
 * Shapes follow near-daos/sputnik-dao-contract sputnikdao2 and were checked
 * against the wasm deployed on mainnet (see contracts/res/README.md).
 */
import { formatUsd, type Batch, type FundMsg } from "@cascade/core";

export type WeightOrRatio = string | [number, number];

export interface VotePolicy {
  weight_kind: "RoleWeight" | "TokenWeight";
  quorum: string;
  threshold: WeightOrRatio;
}

export type RoleKind = "Everyone" | { Member: string } | { Group: string[] };

export interface RolePermission {
  name: string;
  kind: RoleKind;
  permissions: string[];
  vote_policy: Record<string, VotePolicy>;
}

export interface Policy {
  roles: RolePermission[];
  default_vote_policy: VotePolicy;
  proposal_bond: string;
  proposal_period: string;
  bounty_bond: string;
  bounty_forgiveness_period: string;
}

export interface ActionCall {
  method_name: string;
  /** base64 of the JSON args */
  args: string;
  deposit: string;
  gas: string;
}

export interface FunctionCallKind {
  FunctionCall: { receiver_id: string; actions: ActionCall[] };
}

export type ProposalKind = FunctionCallKind | Record<string, unknown> | string;

export interface ProposalInput {
  description: string;
  kind: ProposalKind;
}

export type ProposalStatus = "InProgress" | "Approved" | "Rejected" | "Removed" | "Expired" | "Moved" | "Failed";
export type VoteAction = "VoteApprove" | "VoteReject" | "VoteRemove" | "Finalize";

export interface Proposal {
  id: number;
  proposer: string;
  description: string;
  kind: ProposalKind;
  status: ProposalStatus;
  vote_counts: Record<string, [string, string, string]>;
  votes: Record<string, "Approve" | "Reject" | "Remove">;
  submission_time: string;
}

const DAY_NS = 86_400n * 1_000_000_000n;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s: string): unknown => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

export const TGAS = 1_000_000_000_000n;

/**
 * The demo team policy: a `finance` role that may only add proposals, and an
 * `approvers` role that votes. `threshold` approvals are needed (2 of 3 in the
 * demo). The bond is 0 so preparers can propose through a function-call key.
 */
export function payrollPolicy(p: {
  finance: string[];
  approvers: string[];
  threshold: number;
  proposalPeriodDays?: number;
  proposalBond?: bigint;
}): Policy {
  if (p.threshold < 1 || p.threshold > p.approvers.length) throw new Error("threshold must be between 1 and the number of approvers");
  const vote: VotePolicy = { weight_kind: "RoleWeight", quorum: "0", threshold: String(p.threshold) };
  return {
    roles: [
      { name: "finance", kind: { Group: p.finance }, permissions: ["*:AddProposal"], vote_policy: {} },
      {
        name: "approvers",
        kind: { Group: p.approvers },
        permissions: ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"],
        vote_policy: {},
      },
    ],
    default_vote_policy: vote,
    proposal_bond: (p.proposalBond ?? 0n).toString(),
    proposal_period: (BigInt(p.proposalPeriodDays ?? 7) * DAY_NS).toString(),
    bounty_bond: "0",
    bounty_forgiveness_period: DAY_NS.toString(),
  };
}

/** Args for the DAO contract's `new` (or the factory's `create` after base64). */
export function daoInitArgs(name: string, purpose: string, policy: Policy) {
  return { config: { name, purpose, metadata: "" }, policy };
}

/** Args for sputnik-dao.near `create` on mainnet. */
export function factoryCreateArgs(name: string, purpose: string, policy: Policy) {
  return { name, args: b64(daoInitArgs(name, purpose, policy)) };
}

export function functionCallProposal(description: string, receiver_id: string, calls: { method: string; args: unknown; deposit?: bigint; gas?: bigint }[]): ProposalInput {
  return {
    description,
    kind: {
      FunctionCall: {
        receiver_id,
        actions: calls.map((c) => ({
          method_name: c.method,
          args: b64(c.args),
          deposit: (c.deposit ?? 0n).toString(),
          gas: (c.gas ?? 50n * TGAS).toString(),
        })),
      },
    },
  };
}

/** Proposal: the DAO registers itself as a Cascade owner and names its preparers. */
export function registerOwnerProposal(cascade: string, preparers: string[]): ProposalInput {
  return functionCallProposal(
    `Use Cascade for payments. Preparers (can draft invoices and payroll, cannot move money): ${preparers.join(", ") || "none"}`,
    cascade,
    [{ method: "register_owner", args: { kind: "Dao", preparers }, gas: 20n * TGAS }],
  );
}

export const FUND_GAS = 100n * TGAS;

/** Proposal: the DAO sends exactly the batch total to Cascade, quoting the batch hash. */
export function fundBatchProposal(p: { usdc: string; cascade: string; batch: Pick<Batch, "id" | "hash" | "total" | "line_count">; link?: string }): ProposalInput {
  const msg: FundMsg = { batch_id: p.batch.id, hash: p.batch.hash };
  return functionCallProposal(
    [
      `Cascade payroll #${p.batch.id}: ${p.batch.line_count} payment(s), ${formatUsd(p.batch.total)} USDC.`,
      `Batch hash ${p.batch.hash}.`,
      p.link ? `Review: ${p.link}` : "",
    ].filter(Boolean).join(" "),
    p.usdc,
    [{ method: "ft_transfer_call", args: { receiver_id: p.cascade, amount: p.batch.total, msg: JSON.stringify(msg) }, deposit: 1n, gas: FUND_GAS }],
  );
}

/**
 * Check that a proposal does exactly one thing: fund `batch` in full, via the
 * configured USDC contract, into the Cascade contract. The approver UI shows
 * the result next to the vote buttons.
 */
export function verifyFundingProposal(proposal: Pick<Proposal, "kind">, batch: Pick<Batch, "id" | "hash" | "total">, cfg: { usdc: string; cascade: string }): string[] {
  const problems: string[] = [];
  const fc = (proposal.kind as FunctionCallKind).FunctionCall;
  if (!fc) return ["not a function call proposal"];
  if (fc.receiver_id !== cfg.usdc) problems.push(`calls ${fc.receiver_id}, not the USDC contract ${cfg.usdc}`);
  if (fc.actions.length !== 1) problems.push(`has ${fc.actions.length} actions, expected 1`);
  const a = fc.actions[0];
  if (!a) return problems;
  if (a.method_name !== "ft_transfer_call") problems.push(`calls ${a.method_name}, not ft_transfer_call`);
  if (a.deposit !== "1") problems.push("must attach exactly 1 yoctoNEAR");
  let args: { receiver_id?: string; amount?: string; msg?: string } = {};
  try {
    args = unb64(a.args) as typeof args;
  } catch {
    return [...problems, "arguments are not JSON"];
  }
  if (args.receiver_id !== cfg.cascade) problems.push(`sends to ${args.receiver_id}, not Cascade`);
  if (args.amount !== batch.total) problems.push(`amount ${args.amount} != batch total ${batch.total}`);
  try {
    const m = JSON.parse(args.msg ?? "") as FundMsg;
    if (m.batch_id !== batch.id) problems.push(`funds batch ${m.batch_id}, not ${batch.id}`);
    if (m.hash !== batch.hash) problems.push("batch hash does not match");
  } catch {
    problems.push("msg is not a Cascade funding message");
  }
  return problems;
}

/** Args for `act_proposal`. Sputnik v2 also requires the proposal kind, so a vote cannot be replayed onto a different proposal. */
export function actProposalArgs(id: number, action: VoteAction, kind: ProposalKind, memo?: string) {
  return { id, action, proposal: kind, ...(memo ? { memo } : {}) };
}

export function approvals(p: Pick<Proposal, "votes">): string[] {
  return Object.entries(p.votes).filter(([, v]) => v === "Approve").map(([k]) => k).sort();
}

/** The methods a member's function-call key may call on their DAO through the relayer. */
export const DAO_RELAY_METHODS = ["add_proposal", "act_proposal"] as const;
