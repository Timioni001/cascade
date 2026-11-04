/**
 * cascade-mcp: Cascade for AI assistants (Model Context Protocol, stdio).
 *
 * Merchant tools, with CASCADE_SECRET_KEY (or a read-only rk_ key):
 *   merchant_overview, list_payments, list_invoices, list_customers,
 *   create_payment_link, create_invoice, void_invoice
 * Agent wallet, with CASCADE_AGENT_ACCOUNT / CASCADE_AGENT_KEY / CASCADE_AGENT_OWNER:
 *   wallet_status, paid_fetch (pays x402 APIs from the owner's on-chain budget, no gas)
 *
 * Environment:
 *   CASCADE_URL            https://cascade.<you>.workers.dev (API at /v1, relayer at /relayer)
 *   NEAR_NETWORK           mainnet | testnet   (NEAR_RPC_URL to override the RPC)
 *   CASCADE_APP_ID         the Cascade contract (agent wallet only)
 *
 * Claude Desktop / Claude Code config: see docs/mcp.md.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Chain } from "@cascade/near";
import { Cascade } from "@cascade/sdk";
import { McpServer, type Tool } from "./protocol.js";
import { merchantTools } from "./merchant.js";
import { AgentWallet, httpRelay } from "./wallet.js";

const RPC = { mainnet: "https://rpc.mainnet.fastnear.com", testnet: "https://rpc.testnet.fastnear.com" } as const;

export function serverFromEnv(env: Record<string, string | undefined> = process.env): McpServer {
  const url = (env.CASCADE_URL ?? "").replace(/\/$/, "");
  if (!url) throw new Error("set CASCADE_URL (e.g. https://cascade.example.workers.dev)");
  const tools: Tool[] = [];
  const key = env.CASCADE_SECRET_KEY?.trim();
  if (key) tools.push(...merchantTools(new Cascade({ apiKey: key, baseUrl: url }), url, key));
  const agent = env.CASCADE_AGENT_ACCOUNT?.trim();
  if (agent) {
    const network = env.NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
    const need = (k: string) => {
      const v = env[k]?.trim();
      if (!v) throw new Error(`the agent wallet needs ${k}`);
      return v;
    };
    const chain = new Chain(env.NEAR_RPC_URL?.trim() || RPC[network], network);
    tools.push(...new AgentWallet({
      chain, app: need("CASCADE_APP_ID"), owner: need("CASCADE_AGENT_OWNER"), agent, agentKey: need("CASCADE_AGENT_KEY"),
      relay: httpRelay(`${url}/relayer`),
    }).tools());
  }
  if (!tools.length) throw new Error("nothing to serve: set CASCADE_SECRET_KEY (merchant tools) and/or CASCADE_AGENT_ACCOUNT (agent wallet)");
  return new McpServer(
    { name: "cascade", title: "Cascade", version: "0.1.0" },
    tools,
    "Cascade: payments in any coin on any chain, settled in dollars (USDC). Amounts are in US dollars. " +
      "paid_fetch spends real money from a budget with limits set by its owner: say what you are buying and why before calling it.",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const server = serverFromEnv();
    process.stderr.write(`cascade-mcp: ${server.tools.map((t) => t.name).join(", ")}\n`);
    await server.serveStdio();
  } catch (e) {
    process.stderr.write(`cascade-mcp: ${(e as Error).message}\n`);
    process.exit(1);
  }
}
