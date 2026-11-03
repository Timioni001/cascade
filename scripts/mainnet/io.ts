/**
 * The only way a mainnet script may sign anything is through `Io.approve`.
 * The CLI implementation prints the exact transaction and waits for the
 * human to type "yes". `--dry-run` approves nothing.
 */
import { createInterface } from "node:readline/promises";
import type { Action } from "near-api-js";

export interface TxPlan {
  title: string;
  signer: string;
  receiver: string;
  /** Human lines: method, args, deposit, gas. */
  details: string[];
  /** NEAR leaving the signer's account (deposits/transfers), for the summary. */
  spendNear?: bigint;
  /** Other value at stake, e.g. "1.00 USDC". */
  spendOther?: string;
}

export interface Io {
  network: string;
  log(line: string): void;
  step(title: string): void;
  warn(line: string): void;
  /** Returns true only if the human explicitly approved this exact plan. */
  approve(plan: TxPlan): Promise<boolean>;
  /** Free-text question (e.g. "paste the tx hash"). */
  ask(question: string): Promise<string>;
}

const fmtNear = (y: bigint) => `${(Number(y) / 1e24).toFixed(5)} NEAR`;

/** Describe near-api-js actions for the confirmation screen. */
export function describeActions(actions: Action[]): string[] {
  const out: string[] = [];
  for (const a of actions as unknown as Record<string, Record<string, unknown> | undefined>[]) {
    const [kind, body] = Object.entries(a).find(([, v]) => v !== undefined && v !== null) ?? ["?", undefined];
    if (kind === "functionCall" && body) {
      const args = Buffer.from(body.args as Uint8Array).toString("utf8");
      out.push(`call ${String(body.methodName)}(${args.length > 400 ? args.slice(0, 400) + "…" : args})`);
      out.push(`  deposit ${String(body.deposit)} yocto, gas ${Number(BigInt(body.gas as bigint) / 10n ** 12n)} Tgas`);
    } else if (kind === "transfer" && body) out.push(`transfer ${fmtNear(BigInt(body.deposit as bigint))}`);
    else if (kind === "deployContract" && body) out.push(`deploy contract (${(body.code as Uint8Array).length} bytes)`);
    else if (kind === "addKey") out.push("add access key");
    else if (kind === "createAccount") out.push("create account");
    else out.push(kind);
  }
  return out;
}

export function cliIo(opts: { network: string; dryRun: boolean }): Io & { close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const tty = process.stdout.isTTY;
  const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
  const bold = c("1");
  const yellow = c("33");
  const dim = c("2");
  return {
    network: opts.network,
    log: (l) => console.log(`  ${l}`),
    step: (t) => console.log(`\n${bold(t)}`),
    warn: (l) => console.log(`  ${yellow("!")} ${l}`),
    async approve(p) {
      console.log(`\n  ${bold(`┌ ${p.title}`)}  ${dim(`[${opts.network}]`)}`);
      console.log(`  │ signer:   ${p.signer}`);
      console.log(`  │ receiver: ${p.receiver}`);
      for (const d of p.details) console.log(`  │ ${d}`);
      if (p.spendNear !== undefined) console.log(`  │ spends:   ${fmtNear(p.spendNear)}${p.spendOther ? ` + ${p.spendOther}` : ""}`);
      else if (p.spendOther) console.log(`  │ spends:   ${p.spendOther}`);
      console.log("  └");
      if (opts.dryRun) {
        console.log(`  ${dim("dry run: not signed")}`);
        return false;
      }
      const network = opts.network === "mainnet" ? yellow(bold("MAINNET")) : opts.network;
      const a = (await rl.question(`  Sign and send on ${network}? Type "yes" to approve: `)).trim();
      return a === "yes";
    },
    ask: (q) => rl.question(`  ${q} `),
    close: () => rl.close(),
  };
}

/** Approves everything; for the sandbox rehearsal test only. */
export function autoIo(log: (s: string) => void = () => {}): Io {
  return {
    network: "sandbox",
    log,
    step: log,
    warn: log,
    approve: async () => true,
    ask: async () => "",
  };
}
