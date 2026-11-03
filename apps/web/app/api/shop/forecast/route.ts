import { Cascade } from "@cascade/sdk/server";
import { x402Guard } from "@cascade/sdk/x402";
import { SHOP_API, SHOP_KEY } from "../../../../lib/shop";

/**
 * A paid API for AI agents: $0.10 per forecast, payable with USDC on Base or
 * ETH on Base (any chain 1Click supports could be listed). Unpaid requests get
 * HTTP 402 with x402 v2 payment requirements.
 */
const guard = SHOP_KEY
  ? x402Guard(new Cascade({ apiKey: SHOP_KEY, baseUrl: SHOP_API }), {
      price: "0.10",
      description: "Lagos 3-day forecast",
      mimeType: "application/json",
      assets: ["nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", "nep141:base.omft.near"],
    })
  : null;

export async function GET(req: Request) {
  if (!guard) return Response.json({ error: "demo shop not configured: run pnpm dev" }, { status: 503 });
  const g = await guard(req);
  if (!g.paid) return g.response;
  return Response.json(
    { city: "Lagos", days: [{ high: 31, low: 24, sky: "storms" }, { high: 32, low: 25, sky: "sun" }, { high: 30, low: 24, sky: "rain" }] },
    { headers: g.headers },
  );
}
