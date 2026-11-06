/**
 * The merchant's own NEAR wallet, through NEAR Connect (HOT, Meteor, Intear,
 * MyNearWallet, Nightly, OKX...). Cascade never holds this key: the wallet
 * signs, in its own sandboxed iframe or extension, and the dashboard only asks.
 *
 * Loaded on first use, so pages that never sign do not pay for it.
 */
import { API } from "./api";

type Connector = import("@hot-labs/near-connect").NearConnector;

export interface Deployment {
  network: "mainnet" | "testnet";
  app: string;
  usdc: string;
}

let deployment: Promise<Deployment> | null = null;
let connector: Promise<Connector> | null = null;

/** Contract ids and network, from the server this page is served with. */
export function getDeployment(): Promise<Deployment> {
  deployment ??= fetch(`${API}/health`).then(async (r) => {
    const j = (await r.json()) as Partial<Deployment>;
    if (!j.app || !j.usdc || (j.network !== "mainnet" && j.network !== "testnet")) throw new Error("this server does not publish its contracts");
    return j as Deployment;
  });
  return deployment;
}

function getConnector(): Promise<Connector> {
  connector ??= (async () => {
    const [{ NearConnector }, d] = await Promise.all([import("@hot-labs/near-connect"), getDeployment()]);
    return new NearConnector({ network: d.network, footerBranding: null });
  })();
  return connector;
}

/** The connected account, or null. Does not prompt. */
export async function connectedAccount(): Promise<string | null> {
  try {
    const { accounts } = await (await getConnector()).getConnectedWallet();
    return accounts[0]?.accountId ?? null;
  } catch {
    return null;
  }
}

/** Opens the wallet picker. Resolves with the account the person chose. */
export async function connectWallet(): Promise<string> {
  const c = await getConnector();
  const w = await c.connect();
  const [a] = await w.getAccounts();
  if (!a) throw new Error("the wallet returned no account");
  return a.accountId;
}

export async function disconnectWallet(): Promise<void> {
  await (await getConnector()).disconnect().catch(() => {});
}

const TGAS = "000000000000";

/** One function call, signed and sent by the wallet. Resolves with the transaction hash. */
export async function callContract(p: { contract: string; method: string; args: object; tgas?: number; deposit?: string }): Promise<string> {
  const w = await (await getConnector()).wallet();
  const out = await w.signAndSendTransaction({
    receiverId: p.contract,
    actions: [{ type: "FunctionCall", params: { methodName: p.method, args: p.args, gas: `${p.tgas ?? 100}${TGAS}`, deposit: p.deposit ?? "0" } }],
  });
  const failure = (out.status as { Failure?: unknown } | undefined)?.Failure;
  if (failure) throw new Error(`the transaction failed: ${JSON.stringify(failure).slice(0, 200)}`);
  return out.transaction.hash;
}

/** A NEP-413 signature over `message`, in the shape Cascade's API takes as `proof`. */
export async function signProof(message: string, recipient: string, issuedAt: string) {
  const w = await (await getConnector()).wallet();
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const s = await w.signMessage({ message, recipient, nonce });
  return { signer: s.accountId, publicKey: s.publicKey, signature: s.signature, nonce: btoa(String.fromCharCode(...nonce)), issuedAt };
}
