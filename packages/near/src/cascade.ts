import type { Allowance, AppConfig, Batch, Escrow, Invoice, Line, Owner, SplitRule } from "@cascade/core";
import type { Proposal, Policy } from "@cascade/sputnik";
import type { Chain } from "./chain.js";

/** Typed read-only access to the Cascade app contract. */
export class CascadeReader {
  constructor(
    readonly chain: Chain,
    readonly app: string,
  ) {}
  config() {
    return this.chain.view<AppConfig>(this.app, "get_config");
  }
  owner(id: string) {
    return this.chain.view<Owner | null>(this.app, "get_owner", { id });
  }
  invoice(id: number) {
    return this.chain.view<Invoice | null>(this.app, "get_invoice", { id });
  }
  batch(id: number) {
    return this.chain.view<Batch | null>(this.app, "get_batch", { id });
  }
  lines(id: number, from = 0, limit = 50) {
    return this.chain.view<Line[]>(this.app, "get_lines", { id, from, limit });
  }
  split(id: number) {
    return this.chain.view<SplitRule | null>(this.app, "get_split", { id });
  }
  escrow(id: number) {
    return this.chain.view<Escrow | null>(this.app, "get_escrow", { id });
  }
  allowance(owner: string, agent: string) {
    return this.chain.view<Allowance | null>(this.app, "get_allowance", { owner, agent });
  }
  isDepositRecorded(depositAddress: string) {
    return this.chain.view<boolean>(this.app, "is_deposit_recorded", { deposit_address: depositAddress });
  }
}

export class DaoReader {
  constructor(
    readonly chain: Chain,
    readonly dao: string,
  ) {}
  policy() {
    return this.chain.view<Policy>(this.dao, "get_policy");
  }
  proposal(id: number) {
    return this.chain.view<Proposal>(this.dao, "get_proposal", { id });
  }
  lastProposalId() {
    return this.chain.view<number>(this.dao, "get_last_proposal_id");
  }
}
