import { describe, expect, it } from "vitest";
import { approvals, fundBatchProposal, payrollPolicy, registerOwnerProposal, verifyFundingProposal } from "../src/index.js";

const batch = { id: 4, hash: "ab".repeat(32), total: "1234000000", line_count: 3 };
const cfg = { usdc: "usdc.near", cascade: "app.cascade.near" };

describe("sputnik helpers", () => {
  it("builds a 2-of-3 payroll policy with a zero bond", () => {
    const p = payrollPolicy({ finance: ["ada.near"], approvers: ["b.near", "c.near", "d.near"], threshold: 2 });
    expect(p.default_vote_policy.threshold).toBe("2");
    expect(p.proposal_bond).toBe("0");
    expect(p.roles.map((r) => r.name)).toEqual(["finance", "approvers"]);
    expect(() => payrollPolicy({ finance: [], approvers: ["b"], threshold: 2 })).toThrow();
  });

  it("funding proposal round-trips through the verifier", () => {
    const prop = fundBatchProposal({ ...cfg, batch });
    expect(prop.description).toContain("1234.00 USDC");
    expect(verifyFundingProposal(prop, batch, cfg)).toEqual([]);
  });

  it("verifier catches a tampered amount, hash, receiver or token", () => {
    expect(verifyFundingProposal(fundBatchProposal({ ...cfg, batch: { ...batch, total: "1" } }), batch, cfg)).toContainEqual(expect.stringContaining("amount"));
    expect(verifyFundingProposal(fundBatchProposal({ ...cfg, batch: { ...batch, hash: "00".repeat(32) } }), batch, cfg)).toContain("batch hash does not match");
    expect(verifyFundingProposal(fundBatchProposal({ usdc: "fake.near", cascade: cfg.cascade, batch }), batch, cfg)[0]).toContain("not the USDC contract");
    expect(verifyFundingProposal(fundBatchProposal({ usdc: cfg.usdc, cascade: "evil.near", batch }), batch, cfg)[0]).toContain("not Cascade");
    expect(verifyFundingProposal(registerOwnerProposal(cfg.cascade, []), batch, cfg).length).toBeGreaterThan(0);
  });

  it("lists approvers", () => {
    expect(approvals({ votes: { "c.near": "Approve", "b.near": "Approve", "d.near": "Reject" } })).toEqual(["b.near", "c.near"]);
  });
});
