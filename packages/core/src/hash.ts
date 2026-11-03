import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { LineInput, LineKind } from "./types.js";

/**
 * Borsh encoding of `Vec<LineInput>`, byte-for-byte identical to the Rust
 * side (contracts/app/src/lib.rs `hash_lines`). Written by hand so the SDK
 * has no Borsh schema dependency; a shared test vector keeps both in sync.
 */
const KIND_TAG: Record<LineKind, number> = { Near: 0, CrossChain: 1, Private: 2 };

class Writer {
  private parts: Uint8Array[] = [];
  u8(v: number) {
    this.parts.push(Uint8Array.of(v));
  }
  u32(v: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    this.parts.push(b);
  }
  u64(v: bigint) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, v, true);
    this.parts.push(b);
  }
  u128(v: bigint) {
    if (v < 0n || v >= 1n << 128n) throw new Error("u128 out of range");
    this.u64(v & ((1n << 64n) - 1n));
    this.u64(v >> 64n);
  }
  string(s: string) {
    const b = utf8ToBytes(s);
    this.u32(b.length);
    this.parts.push(b);
  }
  bytes(): Uint8Array {
    const len = this.parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

export function encodeLines(lines: readonly LineInput[]): Uint8Array {
  const w = new Writer();
  w.u32(lines.length);
  for (const l of lines) {
    w.string(l.recipient);
    w.u128(BigInt(l.amount));
    w.u8(KIND_TAG[l.kind]);
    if (l.dest == null) w.u8(0);
    else {
      w.u8(1);
      w.string(l.dest);
    }
    if (l.deadline_ms == null) w.u8(0);
    else {
      w.u8(1);
      w.u64(BigInt(l.deadline_ms));
    }
  }
  return w.bytes();
}

/** Hex SHA-256 of the Borsh-encoded lines: the batch hash the funder must quote. */
export function hashLines(lines: readonly LineInput[]): string {
  return bytesToHex(sha256(encodeLines(lines)));
}

/** Hex SHA-256 of a canonical JSON document (sorted keys). Used for invoice metadata. */
export function hashDocument(doc: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(doc))));
}

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}
