/**
 * Asset ids and chain metadata used by Cascade. Asset ids were read from the
 * live 1Click token list (GET /v0/tokens) on 2026-11-03; see docs/research.md.
 */
export const USDC_NEAR_CONTRACT = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const USDC_NEAR_ASSET = `nep141:${USDC_NEAR_CONTRACT}`;

export interface ChainInfo {
  id: string;
  name: string;
  /** Address shape hint for form validation. */
  address: RegExp;
  explorerTx: (hash: string) => string;
}

const evm = /^0x[0-9a-fA-F]{40}$/;

export const CHAINS: Record<string, ChainInfo> = {
  near: { id: "near", name: "NEAR", address: /^.{2,64}$/, explorerTx: (h) => `https://nearblocks.io/txns/${h}` },
  eth: { id: "eth", name: "Ethereum", address: evm, explorerTx: (h) => `https://etherscan.io/tx/${h}` },
  base: { id: "base", name: "Base", address: evm, explorerTx: (h) => `https://basescan.org/tx/${h}` },
  arb: { id: "arb", name: "Arbitrum", address: evm, explorerTx: (h) => `https://arbiscan.io/tx/${h}` },
  op: { id: "op", name: "Optimism", address: evm, explorerTx: (h) => `https://optimistic.etherscan.io/tx/${h}` },
  pol: { id: "pol", name: "Polygon", address: evm, explorerTx: (h) => `https://polygonscan.com/tx/${h}` },
  bsc: { id: "bsc", name: "BNB Chain", address: evm, explorerTx: (h) => `https://bscscan.com/tx/${h}` },
  sol: { id: "sol", name: "Solana", address: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, explorerTx: (h) => `https://solscan.io/tx/${h}` },
  btc: { id: "btc", name: "Bitcoin", address: /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/, explorerTx: (h) => `https://mempool.space/tx/${h}` },
  tron: { id: "tron", name: "Tron", address: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, explorerTx: (h) => `https://tronscan.org/#/transaction/${h}` },
};

export function chainName(id: string): string {
  return CHAINS[id]?.name ?? id;
}

export function explorerTx(chain: string, hash: string): string | null {
  return CHAINS[chain]?.explorerTx(hash) ?? null;
}

export function nearExplorerTx(hash: string, network: "mainnet" | "testnet" | "sandbox" = "mainnet"): string | null {
  if (network === "sandbox") return null;
  return network === "mainnet" ? `https://nearblocks.io/txns/${hash}` : `https://testnet.nearblocks.io/txns/${hash}`;
}

/** USDC on each chain we offer as a payout destination (from /v0/tokens). */
export const USDC_BY_CHAIN: Record<string, string> = {
  near: USDC_NEAR_ASSET,
  eth: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
  base: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  arb: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  sol: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
};

/** `dest` strings on lines look like "sol:7xKX...". */
export function formatDest(chain: string, address: string): string {
  return `${chain}:${address}`;
}

export function parseDest(dest: string): { chain: string; address: string } | null {
  const i = dest.indexOf(":");
  if (i <= 0) return null;
  return { chain: dest.slice(0, i), address: dest.slice(i + 1) };
}
