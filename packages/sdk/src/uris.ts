/**
 * Payment-request URIs that phone wallets understand. Encoded in a QR code,
 * they open the payer's wallet with the address, amount and token filled in.
 *
 *   EVM:     EIP-681   ethereum:<to>@<chainId>?value=<wei>
 *                      ethereum:<token>@<chainId>/transfer?address=<to>&uint256=<units>
 *   Solana:  Solana Pay  solana:<to>?amount=<decimal>&spl-token=<mint>&label=..&message=..&memo=..
 *   Bitcoin: BIP-21    bitcoin:<to>?amount=<BTC decimal>&label=..&message=..
 */
import { EVM_CHAIN_IDS } from "./evm.js";

export interface UriInput {
  chain: string; // 1Click chain id: base, eth, arb, sol, btc, ...
  depositAddress: string;
  amount: string | bigint; // base units
  decimals: number;
  tokenContract: string | null; // null = native coin
  label?: string;
  message?: string;
  memo?: string | null;
}

/** 1234500, 6 -> "1.2345" (exact; no float). */
export function unitsToDecimal(units: string | bigint, decimals: number): string {
  const v = BigInt(units);
  if (v < 0n) throw new Error("negative amount");
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

const q = (params: Record<string, string | undefined | null>) => {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`);
  return parts.length ? `?${parts.join("&")}` : "";
};

/** A wallet-openable URI for this payment, or null when the chain has no widely supported standard. */
export function paymentUri(p: UriInput): string | null {
  const amount = BigInt(p.amount);
  const evmChain = EVM_CHAIN_IDS[p.chain];
  if (evmChain) {
    if (!p.tokenContract) return `ethereum:${p.depositAddress}@${evmChain}${q({ value: amount.toString() })}`;
    return `ethereum:${p.tokenContract}@${evmChain}/transfer${q({ address: p.depositAddress, uint256: amount.toString() })}`;
  }
  if (p.chain === "sol") {
    return `solana:${p.depositAddress}${q({
      amount: unitsToDecimal(amount, p.decimals),
      "spl-token": p.tokenContract ?? undefined,
      label: p.label,
      message: p.message,
      memo: p.memo ?? undefined,
    })}`;
  }
  if (p.chain === "btc") {
    return `bitcoin:${p.depositAddress}${q({ amount: unitsToDecimal(amount, 8), label: p.label, message: p.message })}`;
  }
  return null;
}
