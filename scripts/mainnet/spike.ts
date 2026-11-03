/**
 * pnpm spike <name> [options]       (network from .env; start on testnet where possible)
 *
 * One small, real experiment per question in docs/spikes.md. Defaults are
 * ~$1. Anything above $5 is refused unless you pass --allow-more. Every NEAR
 * transaction is shown and needs a typed "yes"; payments from other chains
 * you send yourself from your own wallet.
 *
 *   incoming  --refund-to <your address on the paying chain> [--asset <1Click asset id>] [--amount 1] [--to <NEAR account>]
 *   expired   same as incoming, with a 3-minute deadline: send AFTER it expires to see what 1Click does
 *   outgoing  --recipient <address on --chain> [--chain base] [--amount 1]       (signs from SPIKE_ACCOUNT_ID)
 *   private   same as outgoing with Confidential Intents (needs ONECLICK_JWT)
 *   name      [--name spike-<random>]   relayer creates <name>.<root> with the deployed factory
 *   relay     the name from `name` registers with Cascade through the relayer (fee-free)
 *
 * Results (no keys) are appended to deployments/<network>-spikes.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair, type KeyPairString } from "near-api-js";
import { USDC_BY_CHAIN, USDC_NEAR_ASSET, formatUsd, parseUsd } from "@cascade/core";
import { Chain, type Call, appCalls, decodeSignedDelegate, factoryCalls, ftCalls, parseOutcome, relayCall, signMeta } from "@cascade/near";
import { HttpOneClick, incomingQuote, isTerminal, outgoingQuote, type OneClick, type QuoteRequest, type StatusResponse } from "@cascade/oneclick";
import { describeActions, cliIo, type Io } from "./io.js";
import { DEPLOY_DIR } from "./deploy.js";
import { loadEnv, readConfig, saveKeyToEnv, type NetConfig } from "./env.js";

const MAX_USD = parseUsd("5");

interface Args {
  [k: string]: string | boolean | undefined;
}

function parseArgs(argv: string[]): { cmd: string; a: Args } {
  const [cmd = "", ...rest] = argv;
  const a: Args = {};
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i]!;
    if (!k.startsWith("--")) continue;
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) a[k.slice(2)] = true;
    else {
      a[k.slice(2)] = next;
      i++;
    }
  }
  return { cmd, a };
}

const str = (a: Args, k: string, d?: string): string => {
  const v = a[k];
  if (typeof v === "string") return v;
  if (d !== undefined) return d;
  throw new Error(`--${k} is required`);
};

function amountOf(a: Args): bigint {
  const v = parseUsd(str(a, "amount", "1"));
  if (v > MAX_USD && !a["allow-more"]) throw new Error("spikes are capped at $5; pass --allow-more if you really mean it");
  return v;
}

export function recordSpike(network: string, entry: Record<string, unknown>, dir = DEPLOY_DIR) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${network}-spikes.json`);
  const list = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as unknown[]) : [];
  list.push({ at: new Date().toISOString(), ...entry });
  writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
  return file;
}

/** Poll /v0/status until a terminal state (or `maxMinutes`), printing each change. */
export async function watch(oc: OneClick, io: Io, depositAddress: string, maxMinutes = 45, intervalMs = 5000): Promise<StatusResponse | null> {
  let last = "";
  const until = Date.now() + maxMinutes * 60_000;
  while (Date.now() < until) {
    try {
      const s = await oc.status(depositAddress);
      if (s.status !== last) {
        io.log(`${new Date().toISOString().slice(11, 19)}  ${s.status}`);
        last = s.status;
      }
      if (isTerminal(s.status)) return s;
    } catch (e) {
      io.warn(`status: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  io.warn(`stopped watching after ${maxMinutes} minutes (last status ${last}); re-run later with: pnpm spike status --deposit ${depositAddress}`);
  return null;
}

function summarize(s: StatusResponse) {
  const d = s.swapDetails;
  return {
    status: s.status,
    amountIn: d.amountInFormatted,
    amountOut: d.amountOutFormatted,
    refunded: d.refundedAmountFormatted,
    refundReason: d.refundReason,
    nearTxHashes: d.nearTxHashes,
    originTx: d.originChainTxHashes.map((t) => t.explorerUrl || t.hash),
    destinationTx: d.destinationChainTxHashes.map((t) => t.explorerUrl || t.hash),
  };
}

function showQuote(io: Io, req: QuoteRequest, q: { quote: { amountInFormatted: string; amountInUsd: string; amountOutFormatted: string; timeEstimate: number } }) {
  io.log(`${req.swapType}: pay ${q.quote.amountInFormatted} of ${req.originAsset}`);
  io.log(`  ≈ $${Number(q.quote.amountInUsd).toFixed(2)}, receive ${q.quote.amountOutFormatted} of ${req.destinationAsset}`);
  io.log(`  recipient ${req.recipient} · refunds to ${req.refundTo} · ~${q.quote.timeEstimate}s`);
}

// ------------------------------------------------------------ spikes

async function incoming(cfg: NetConfig, io: Io, oc: OneClick, a: Args, expired: boolean) {
  const amount = amountOf(a);
  const to = str(a, "to", cfg.root.id);
  const asset = str(a, "asset", USDC_BY_CHAIN.base!);
  const refundTo = str(a, "refund-to");
  const deadlineMs = expired ? 3 * 60_000 : undefined;
  // 1Click answers "400 Internal server error" when the NEAR recipient does not exist (docs/research.md).
  const exists = await new Chain(cfg.rpc, cfg.network).account(to).getState().then(() => true, () => false);
  if (!exists) throw new Error(`${to} does not exist on ${cfg.network}; 1Click cannot deliver to it. Deploy first, or pass --to <existing account>`);
  io.step(`${expired ? "Expired quote" : "Incoming"}: $${formatUsd(amount)} USDC on NEAR to ${to}`);
  const dryReq = incomingQuote({ payAsset: asset, owner: to, amountOut: amount, refundTo, dry: true, ...(deadlineMs ? { deadlineMs } : {}) });
  const dry = await oc.quote(dryReq);
  showQuote(io, dryReq, dry);
  if (dry.quoteRequest.appFees?.length) io.warn(`no partner JWT: 1Click adds ${dry.quoteRequest.appFees.map((f) => f.fee).join("+")} bps`);
  const ok = await io.approve({ title: "Reserve a one-time deposit address (real quote; nothing is sent yet)", signer: "1Click API", receiver: to, details: [`asset ${asset}`, `exact output ${formatUsd(amount)} USDC`, `deadline in ${expired ? "3 minutes" : "1 hour"}`] });
  if (!ok) return;
  const real = await oc.quote({ ...dryReq, dry: false });
  const dep = real.quote.depositAddress!;
  io.step("Send it from your own wallet");
  io.log(`amount:  ${real.quote.amountInFormatted} (exactly; base units ${real.quote.amountIn})`);
  io.log(`asset:   ${asset}`);
  io.log(`to:      ${dep}${real.quote.depositMemo ? `   memo ${real.quote.depositMemo}` : ""}`);
  io.log(`before:  ${real.quote.deadline}`);
  if (expired) io.warn("this spike tests a LATE deposit: wait until the deadline above has passed, then send");
  const hash = (await io.ask("Paste the transaction hash once sent (or press Enter to just watch):")).trim();
  if (hash) await oc.submitDeposit({ txHash: hash, depositAddress: dep }).then(() => io.log("submitted to /v0/deposit/submit"), (e: Error) => io.warn(e.message));
  const s = await watch(oc, io, dep, expired ? 90 : 45);
  const file = recordSpike(cfg.network, { spike: expired ? "expired" : "incoming", to, asset, amount: formatUsd(amount), depositAddress: dep, correlationId: real.correlationId, signature: real.signature, deadline: real.quote.deadline, ...(s ? summarize(s) : { status: "unknown (stopped watching)" }) });
  io.log(`recorded in ${file}`);
}

async function outgoing(cfg: NetConfig, io: Io, oc: OneClick, a: Args, priv: boolean) {
  const amount = amountOf(a);
  const chainId = str(a, "chain", "base");
  const recipient = str(a, "recipient");
  const destAsset = USDC_BY_CHAIN[chainId];
  if (!destAsset) throw new Error(`no USDC asset known for chain ${chainId}`);
  const sender = process.env.SPIKE_ACCOUNT_ID?.trim();
  const senderKey = process.env.SPIKE_PRIVATE_KEY?.trim() as KeyPairString | undefined;
  if (!sender || !senderKey) throw new Error("set SPIKE_ACCOUNT_ID and SPIKE_PRIVATE_KEY in .env: a NEAR account of yours holding a few USDC");
  if (priv && !cfg.oneclickJwt) throw new Error("private payments need ONECLICK_JWT (1Click refuses confidential quotes without it)");
  if (cfg.network !== "mainnet") io.warn("1Click only works on mainnet: this will quote mainnet assets");
  const chain = new Chain(cfg.rpc, cfg.network);
  const acct = chain.account(sender, senderKey);
  const bal = await chain.ftBalance(USDC_NEAR_ASSET.slice("nep141:".length), sender);
  io.step(`${priv ? "Private outgoing" : "Outgoing"}: $${formatUsd(amount)} from ${sender} to ${recipient} on ${chainId}`);
  io.log(`${sender} holds ${formatUsd(bal)} USDC`);
  const req = outgoingQuote({ destAsset, recipient, owner: sender, mode: "sender_pays", amount, private: priv, dry: true, deadlineMs: 60 * 60_000 });
  const dry = await oc.quote(req);
  showQuote(io, req, dry);
  if (bal < amount) throw new Error("not enough USDC");
  const okQuote = await io.approve({ title: "Reserve a deposit address (real quote)", signer: "1Click API", receiver: recipient, details: [`${formatUsd(amount)} USDC in, refunds to ${sender}`, `confidentiality ${req.confidentiality}`] });
  if (!okQuote) return;
  const real = await oc.quote({ ...req, dry: false });
  const dep = real.quote.depositAddress!;
  const usdc = USDC_NEAR_ASSET.slice("nep141:".length);
  const reg = await chain.view<unknown>(usdc, "storage_balance_of", { account_id: dep });
  io.log(`deposit address ${dep}: ${reg ? "already registered with USDC" : "NOT registered with USDC"}`);
  const txs: Record<string, string> = {};
  const send = async (title: string, call: Call, spendOther?: string) => {
    const approved = await io.approve({ title, signer: sender, receiver: call.receiverId, details: describeActions(call.actions), ...(spendOther ? { spendOther } : {}) });
    if (!approved) throw new Error(`not approved: ${title}`);
    const raw = await acct.signAndSendTransaction({ receiverId: call.receiverId, actions: call.actions, waitUntil: "FINAL", throwOnFailure: false });
    const r = parseOutcome(raw as never);
    if (!r.ok) throw new Error(`${title} failed: ${r.error}`);
    txs[title] = r.hash;
    io.log(`✓ ${title}: tx ${r.hash}`);
    return r.hash;
  };
  if (!reg) await send("register deposit address with USDC", ftCalls(usdc).storageDeposit(dep), "0.00125 NEAR");
  const hash = await send("send USDC to the deposit address", ftCalls(usdc).transfer(dep, BigInt(real.quote.amountIn), "cascade spike"), `${formatUsd(real.quote.amountIn)} USDC`);
  await oc.submitDeposit({ txHash: hash, depositAddress: dep, nearSenderAccount: sender }).catch((e: Error) => io.warn(e.message));
  const s = await watch(oc, io, dep);
  const file = recordSpike(cfg.network, {
    spike: priv ? "private" : "outgoing", from: sender, chain: chainId, recipient, amount: formatUsd(amount), depositAddress: dep,
    depositWasRegistered: Boolean(reg), confidentiality: req.confidentiality, correlationId: real.correlationId, nearTxs: txs, ...(s ? summarize(s) : { status: "unknown" }),
  });
  io.log(`recorded in ${file}`);
  if (priv) io.log("Now check what is public: the NEAR tx above, and the destination tx. Write what you see into docs/spikes.md.");
}

async function name(cfg: NetConfig, io: Io, a: Args) {
  if (!cfg.relayer.key) throw new Error("RELAYER_PRIVATE_KEY is required (run pnpm deploy:cascade first)");
  const chain = new Chain(cfg.rpc, cfg.network);
  const n = str(a, "name", `spike-${Math.random().toString(36).slice(2, 8)}`);
  const kp = KeyPair.fromRandom("ed25519");
  const appKey = KeyPair.fromRandom("ed25519");
  const call = factoryCalls(cfg.root.id).createName(n, kp.getPublicKey().toString(), appKey.getPublicKey().toString());
  io.step(`Create ${n}.${cfg.root.id} through the factory (relayer pays)`);
  const ok = await io.approve({ title: `create_name(${n})`, signer: cfg.relayer.id, receiver: cfg.root.id, details: describeActions(call.actions), spendOther: "the factory funds the new account with 0.01 NEAR + USDC registration" });
  if (!ok) return;
  const r = await chain.send<boolean>(chain.account(cfg.relayer.id, cfg.relayer.key), call);
  if (!r.ok || r.value !== true) throw new Error(`create_name failed: ${r.error ?? "returned false"}`);
  const id = `${n}.${cfg.root.id}`;
  saveKeyToEnv("SPIKE_NAME_ACCOUNT_ID", id);
  saveKeyToEnv("SPIKE_NAME_PRIVATE_KEY", kp.toString());
  saveKeyToEnv("SPIKE_NAME_APP_KEY", appKey.toString());
  io.log(`✓ ${id} created, tx ${r.hash}. Its keys were saved to .env.`);
  recordSpike(cfg.network, { spike: "name", account: id, tx: r.hash });
}

async function relay(cfg: NetConfig, io: Io) {
  const id = process.env.SPIKE_NAME_ACCOUNT_ID;
  const appKey = process.env.SPIKE_NAME_APP_KEY as KeyPairString | undefined;
  if (!id || !appKey) throw new Error("run `pnpm spike name` first");
  if (!cfg.relayer.key) throw new Error("RELAYER_PRIVATE_KEY is required");
  const chain = new Chain(cfg.rpc, cfg.network);
  const user = chain.account(id, appKey);
  const before = await chain.nearBalance(id);
  const b64 = await signMeta(user, appCalls(cfg.app).registerOwner("Account", []));
  const d = decodeSignedDelegate(b64);
  io.step(`${id} signs register_owner with its limited app key; the relayer submits and pays`);
  const call = relayCall(d.raw);
  const ok = await io.approve({ title: "relay NEP-366 delegate action", signer: cfg.relayer.id, receiver: id, details: [`inner: ${d.summary.receiverId}.${d.summary.calls.map((c) => c.method).join(",")}`, ...describeActions(call.actions).slice(0, 1)] });
  if (!ok) return;
  const r = await chain.send(chain.account(cfg.relayer.id, cfg.relayer.key), call, { target: cfg.app });
  if (!r.ok) throw new Error(`relay failed: ${r.error}`);
  const owner = await chain.view(cfg.app, "get_owner", { id });
  const after = await chain.nearBalance(id);
  io.log(`✓ tx ${r.hash}; owner: ${JSON.stringify(owner)}; user's NEAR change: ${Number(before - after) / 1e24}`);
  recordSpike(cfg.network, { spike: "relay", account: id, tx: r.hash, userNearSpent: (before - after).toString() });
}

// ------------------------------------------------------------ CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  loadEnv();
  const { cmd, a } = parseArgs(process.argv.slice(2));
  const cfg = readConfig();
  const io = cliIo({ network: cfg.network, dryRun: Boolean(a["dry-run"]) });
  const oc = new HttpOneClick(cfg.oneclickJwt ? { jwt: cfg.oneclickJwt } : {});
  try {
    if (cmd === "incoming") await incoming(cfg, io, oc, a, false);
    else if (cmd === "expired") await incoming(cfg, io, oc, a, true);
    else if (cmd === "outgoing") await outgoing(cfg, io, oc, a, false);
    else if (cmd === "private") await outgoing(cfg, io, oc, a, true);
    else if (cmd === "name") await name(cfg, io, a);
    else if (cmd === "relay") await relay(cfg, io);
    else if (cmd === "status") {
      const s = await oc.status(str(a, "deposit"));
      console.log(JSON.stringify(summarize(s), null, 2));
    } else {
      console.log("usage: pnpm spike <incoming|expired|outgoing|private|name|relay|status> [options]  (see scripts/mainnet/spike.ts)");
      process.exitCode = 1;
    }
  } catch (e) {
    io.warn((e as Error).message);
    process.exitCode = 1;
  } finally {
    io.close();
  }
}
