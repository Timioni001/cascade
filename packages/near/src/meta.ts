import { deserialize } from "borsh";
import { SCHEMA, encodeSignedDelegate, actions, type Account, type SignedDelegate } from "near-api-js";
import type { Call } from "./calls.js";

/**
 * NEP-366 meta-transactions. The user's key signs a DelegateAction ("call X
 * on Y, valid until block N, nonce K"). Anyone can wrap it in a transaction
 * and pay the gas; NEAR checks the user's signature and nonce, so the relayer
 * cannot change what is called.
 */
export async function signMeta(account: Account, call: Call, blockHeightTtl = 120): Promise<string> {
  const { signedDelegate } = await account.createSignedMetaTransaction({
    receiverId: call.receiverId,
    actions: call.actions,
    blockHeightTtl,
  });
  return Buffer.from(encodeSignedDelegate(signedDelegate)).toString("base64");
}

/** What the relayer needs to know about a signed delegate before paying for it. */
export interface DelegateSummary {
  senderId: string;
  receiverId: string;
  maxBlockHeight: bigint;
  publicKey: string;
  calls: { method: string; args: unknown; gas: bigint; deposit: bigint }[];
  /** Any non-FunctionCall action present (transfer, add key, deploy...). */
  otherActions: string[];
}

type RawAction = Record<string, unknown>;
type RawDelegate = {
  delegateAction: {
    senderId: string;
    receiverId: string;
    actions: RawAction[];
    nonce: bigint;
    maxBlockHeight: bigint;
    publicKey: { ed25519Key?: { data: Uint8Array }; secp256k1Key?: { data: Uint8Array } };
  };
  signature: unknown;
};

export function decodeSignedDelegate(b64: string): { raw: SignedDelegate; summary: DelegateSummary } {
  const bytes = Buffer.from(b64, "base64");
  const raw = deserialize((SCHEMA as unknown as { SignedDelegate: never }).SignedDelegate, bytes) as unknown as RawDelegate;
  const da = raw.delegateAction;
  const calls: DelegateSummary["calls"] = [];
  const otherActions: string[] = [];
  for (const a of da.actions) {
    const [kind, body] = Object.entries(a).find(([, v]) => v !== undefined && v !== null) ?? ["unknown", undefined];
    if (kind === "functionCall") {
      const f = body as { methodName: string; args: Uint8Array; gas: bigint; deposit: bigint };
      let args: unknown;
      try {
        args = JSON.parse(Buffer.from(f.args).toString("utf8"));
      } catch {
        args = undefined;
      }
      calls.push({ method: f.methodName, args, gas: BigInt(f.gas), deposit: BigInt(f.deposit) });
    } else {
      otherActions.push(kind);
    }
  }
  const pk = da.publicKey.ed25519Key ? `ed25519:${bs58(da.publicKey.ed25519Key.data)}` : "secp256k1";
  return {
    raw: raw as unknown as SignedDelegate,
    summary: {
      senderId: da.senderId,
      receiverId: da.receiverId,
      maxBlockHeight: BigInt(da.maxBlockHeight),
      publicKey: pk,
      calls,
      otherActions,
    },
  };
}

/** Wrap a decoded delegate into the relayer's own transaction. */
export function relayCall(raw: SignedDelegate): Call {
  const sd = raw as unknown as { delegateAction: never; signature: never };
  return {
    receiverId: (raw as unknown as RawDelegate).delegateAction.senderId,
    label: "relay meta-transaction",
    actions: [actions.signedDelegate({ delegateAction: sd.delegateAction, signature: sd.signature })],
  };
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
