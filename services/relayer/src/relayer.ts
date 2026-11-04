import { isValidName, RESERVED_NAMES } from "@cascade/core";
import {
  CascadeReader, DaoReader, decodeSignedDelegate, factoryCalls, relayCall, type Chain, type TxResult,
} from "@cascade/near";
import type { Account } from "near-api-js";
import { checkDelegate, type RelayPolicyConfig } from "./policy.js";
import { DEFAULT_LIMITS, RateLimiter, type LimitRule, type Limiter } from "@cascade/core";

export interface RelayerDeps {
  chain: Chain;
  /** The account that pays gas. Must also be the factory's configured relayer. */
  payer: Account;
  app: string;
  usdc: string;
  factory: string;
  /** Sputnik DAO factory, e.g. sputnik-dao.near */
  daoFactory: string;
  limits?: Partial<typeof DEFAULT_LIMITS>;
  limiter?: Limiter;
  /** Optional human check for sign-ups (e.g. Cloudflare Turnstile). */
  verifyHuman?: (token: string | undefined, ip: string) => Promise<boolean>;
}

export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RelayContext {
  ip: string;
  humanToken?: string;
}

/**
 * Pays network fees for Cascade users (NEP-366), and creates their names.
 * It cannot move anyone's money: it only submits what users signed, and only
 * for calls the policy allows.
 */
export class Relayer {
  private readonly limits: typeof DEFAULT_LIMITS;
  private readonly limiter: Limiter;
  private readonly policy: RelayPolicyConfig;
  private readonly reader: CascadeReader;
  private readonly daoCache = new Map<string, boolean>();

  /** The account that signs and pays for every relayed transaction. */
  get account(): string {
    return this.d.payer.accountId;
  }

  constructor(private readonly d: RelayerDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...d.limits };
    this.limiter = d.limiter ?? new RateLimiter();
    this.reader = new CascadeReader(d.chain, d.app);
    this.policy = {
      app: d.app,
      usdc: d.usdc,
      maxGas: 300n * 10n ** 12n,
      maxTotalGas: 300n * 10n ** 12n,
      daoFactory: d.daoFactory,
      proposalKind: async (dao, id) => (await new DaoReader(d.chain, dao).proposal(id)).kind,
      isRegisteredDao: async (acct) => {
        const hit = this.daoCache.get(acct);
        if (hit !== undefined) return hit;
        const o = await this.reader.owner(acct).catch(() => null);
        const yes = o?.kind === "Dao";
        if (yes) this.daoCache.set(acct, true); // registration never goes away; only cache positives
        return yes;
      },
    };
  }

  private async limit(key: string, rule: LimitRule, what: string) {
    if (!(await this.limiter.take(key, rule))) throw new RelayError(429, `too many ${what}, try again later`);
  }

  async relay(signedDelegateB64: string, ctx: RelayContext): Promise<TxResult> {
    let decoded;
    try {
      decoded = decodeSignedDelegate(signedDelegateB64);
    } catch {
      throw new RelayError(400, "not a signed delegate action");
    }
    const v = await checkDelegate(decoded.summary, this.policy);
    if (!v.ok) throw new RelayError(403, v.reason);
    await this.limit(`ip:${ctx.ip}`, this.limits.relayPerIp, "requests from this address");
    await this.limit(`acct:${decoded.summary.senderId}`, this.limits.relayPerAccount, "requests for this account");
    return this.d.chain.send(this.d.payer, relayCall(decoded.raw), { target: decoded.summary.receiverId });
  }

  async createName(req: { name: string; publicKey: string; appKey?: string }, ctx: RelayContext): Promise<TxResult<boolean> & { accountId: string }> {
    const name = req.name.trim().toLowerCase();
    if (!isValidName(name) || RESERVED_NAMES.has(name)) throw new RelayError(400, "names are 2-32 lowercase letters, digits, - or _");
    if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(req.publicKey)) throw new RelayError(400, "bad public key");
    if (req.appKey && !/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(req.appKey)) throw new RelayError(400, "bad app key");
    if (this.d.verifyHuman && !(await this.d.verifyHuman(ctx.humanToken, ctx.ip))) throw new RelayError(403, "human check failed");
    if (!(await this.limiter.peek(`names:${ctx.ip}`, this.limits.namesPerIp))) throw new RelayError(429, "too many names from this address today");
    const accountId = `${name}.${this.d.factory}`;
    const exists = await this.d.chain.account(accountId).getState().then(() => true, () => false);
    if (exists) throw new RelayError(409, "that name is taken");
    await this.limit(`names:${ctx.ip}`, this.limits.namesPerIp, "names from this address today");
    const r = await this.d.chain.send<boolean>(this.d.payer, factoryCalls(this.d.factory).createName(name, req.publicKey, req.appKey));
    if (!r.ok || r.value !== true) throw new RelayError(502, `could not create ${accountId}: ${r.error ?? "factory refused"}`);
    return { ...r, accountId };
  }
}
