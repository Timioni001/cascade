/**
 * Pay a deposit address from an injected EVM wallet (MetaMask, Rabby,
 * Coinbase Wallet...) via EIP-1193. No library: the ERC-20 call is 68 bytes.
 */

/** 1Click chain id -> EVM chain id. */
export const EVM_CHAIN_IDS: Record<string, number> = {
  eth: 1,
  base: 8453,
  arb: 42161,
  op: 10,
  pol: 137,
  bsc: 56,
  gnosis: 100,
  avax: 43114,
};

export function isEvmChain(chain: string): boolean {
  return chain in EVM_CHAIN_IDS;
}

export interface EvmTx {
  chainId: number;
  to: string;
  value: string; // hex
  data: string; // hex, "0x" for native
}

const hexAddr = /^0x[0-9a-fA-F]{40}$/;

/**
 * Build the transaction that sends `amount` (base units) of a token to `depositAddress`.
 * `tokenContract` null means the chain's native coin (ETH on Base, etc.).
 */
export function buildEvmTransfer(p: { chain: string; depositAddress: string; amount: bigint | string; tokenContract: string | null }): EvmTx {
  const chainId = EVM_CHAIN_IDS[p.chain];
  if (!chainId) throw new Error(`${p.chain} is not an EVM chain`);
  if (!hexAddr.test(p.depositAddress)) throw new Error("deposit address is not an EVM address");
  const amount = BigInt(p.amount);
  if (amount <= 0n) throw new Error("amount must be positive");
  if (!p.tokenContract) return { chainId, to: p.depositAddress, value: `0x${amount.toString(16)}`, data: "0x" };
  if (!hexAddr.test(p.tokenContract)) throw new Error("token contract is not an EVM address");
  const data =
    "0xa9059cbb" + // transfer(address,uint256)
    p.depositAddress.slice(2).toLowerCase().padStart(64, "0") +
    amount.toString(16).padStart(64, "0");
  return { chainId, to: p.tokenContract, value: "0x0", data };
}

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** Connect, switch to the right chain and send. Returns the transaction hash. */
export async function payWithEvmWallet(provider: Eip1193, tx: EvmTx): Promise<string> {
  const [from] = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!from) throw new Error("no account connected");
  const want = `0x${tx.chainId.toString(16)}`;
  const current = (await provider.request({ method: "eth_chainId" })) as string;
  if (current?.toLowerCase() !== want) {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  }
  return (await provider.request({
    method: "eth_sendTransaction",
    params: [{ from, to: tx.to, value: tx.value, data: tx.data }],
  })) as string;
}
