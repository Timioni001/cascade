/**
 * pnpm agent      (with `pnpm dev` running)
 *
 * An "AI agent" buys one forecast from the demo shop's paid API using x402:
 * GET -> 402 with payment options -> the agent pays one (here the sandbox
 * simulates its ETH payment on Base) -> retries with PAYMENT-SIGNATURE until
 * NEAR Intents has delivered and the settler recorded it -> 200 + data.
 */
import { decodeHeader, fetchWithPayment, X402_HEADERS, type X402Settlement } from "@cascade/sdk";

const SHOP = process.env.SHOP_URL ?? "http://localhost:3000";
const API = process.env.CASCADE_API ?? "http://127.0.0.1:8788";

console.log(`agent: GET ${SHOP}/api/shop/forecast`);
const res = await fetchWithPayment(`${SHOP}/api/shop/forecast`, {}, {
  refundTo: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D",
  choose: (accepts) => {
    for (const a of accepts) console.log(`  402 offers: ${a.amount} ${a.extra.symbol} on ${a.extra.chain} (${a.network}) ≈ $${Number(a.extra.amountUsd).toFixed(4)} -> ${a.payTo}`);
    return accepts.find((a) => a.extra.symbol === "ETH") ?? accepts[0]!;
  },
  pay: async (req) => {
    console.log(`agent: paying ${req.amount} wei of ETH on Base to ${req.payTo}`);
    // Sandbox only: stands in for the agent's wallet sending the transaction.
    const r = await fetch(`${API}/v1/public/dev/deposits/${req.payTo}/simulate`, { method: "POST" });
    const { txHash } = (await r.json()) as { txHash: string };
    console.log(`agent: sent, tx ${txHash.slice(0, 14)}…; retrying with PAYMENT-SIGNATURE until it settles`);
    return txHash;
  },
  pollMs: 1500,
});
const settlement = res.headers.get(X402_HEADERS.response);
console.log(`agent: HTTP ${res.status}`, await res.json());
if (settlement) console.log("agent: PAYMENT-RESPONSE", decodeHeader<X402Settlement>(settlement));
