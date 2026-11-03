import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  splitAmount, validateShares,
  accountToName, canonicalJson, encodeLines, formatUsd, hashLines, isAccountId, isValidName, parseUsd,
  type LineInput,
} from "../src/index.js";

describe("money", () => {
  it("parses and formats dollars without floating point", () => {
    expect(parseUsd("12.5")).toBe(12_500_000n);
    expect(parseUsd("$1,000.000001")).toBe(1_000_000_001n);
    expect(formatUsd(12_500_000n)).toBe("12.50");
    expect(formatUsd(1n)).toBe("0.000001");
    expect(formatUsd(300_000_000n)).toBe("300.00");
    for (const bad of ["", "-1", "1.0000001", "abc", "1e3"]) expect(() => parseUsd(bad)).toThrow();
  });
});

describe("line hash", () => {
  const lines: LineInput[] = [
    { recipient: "bob.near", amount: "1500000", kind: "Near", dest: null, deadline_ms: null },
    {
      recipient: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      amount: "250000000",
      kind: "Private",
      dest: "base:0x2527D02599Ba641c19FEa793cD0F167589a0f10D",
      deadline_ms: 1_800_000_000_000,
    },
  ];

  it("matches the vector the Rust contract test checks", () => {
    const vector = readFileSync(fileURLToPath(new URL("./line-hash-vector.txt", import.meta.url)), "utf8").trim();
    expect(hashLines(lines)).toBe(vector);
  });

  it("encodes Borsh layout exactly", () => {
    const one = encodeLines([{ recipient: "ab", amount: "1", kind: "CrossChain", dest: null, deadline_ms: 2 }]);
    expect(Array.from(one)).toEqual([
      1, 0, 0, 0, // vec len
      2, 0, 0, 0, 97, 98, // "ab"
      1, ...Array(15).fill(0), // u128 1
      1, // CrossChain
      0, // dest None
      1, 2, 0, 0, 0, 0, 0, 0, 0, // Some(2u64)
    ]);
  });

  it("changes when anything changes", () => {
    const h = hashLines(lines);
    expect(hashLines([{ ...lines[0]!, amount: "1500001" }, lines[1]!])).not.toBe(h);
    expect(hashLines([lines[1]!, lines[0]!])).not.toBe(h);
  });
});

describe("accounts", () => {
  it("validates names like the factory", () => {
    expect(isValidName("ada")).toBe(true);
    expect(isValidName("a")).toBe(false);
    expect(isValidName("a--b")).toBe(false);
    expect(isValidName("Ada")).toBe(false);
    expect(isAccountId("ada.cascade.near")).toBe(true);
    expect(accountToName("ada.cascade.near", "cascade.near")).toBe("ada");
    expect(accountToName("x.ada.cascade.near", "cascade.near")).toBe(null);
  });
  it("canonical json sorts keys", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });
});

describe("splits (mirror of the contract)", () => {
  it("matches the Rust vectors and always adds up", () => {
    const s = (a: string, bps: number) => ({ account: a, bps });
    expect(splitAmount(25_000_000n, [s("shop", 7000), s("designer", 2000), s("dao", 1000)])).toEqual([17_500_000n, 5_000_000n, 2_500_000n]);
    expect(splitAmount(10n, [s("a", 3334), s("b", 3333), s("c", 3333)])).toEqual([4n, 3n, 3n]);
    expect(validateShares([s("a", 5000)])).toMatch(/100%/);
    expect(validateShares([s("a", 5000), s("a", 5000)])).toMatch(/once/);
    expect(validateShares([s("a", 10000)])).toBeNull();
  });
});
