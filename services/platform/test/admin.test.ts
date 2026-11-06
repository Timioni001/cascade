import { describe, expect, it } from "vitest";
import { RateLimiter } from "@cascade/core";
import { MemoryStore } from "@cascade/db";
import { adminApp } from "../src/admin.js";

const TOKEN = "t".repeat(32);

async function setup(token: string | null = TOKEN) {
  const store = new MemoryStore();
  await store.putMerchant({ id: "mrc_1", account: "sbx-abc.factory.testnet", name: "Test", webhookUrl: null, webhookSecret: "whsec_x", verifiedBy: "x", createdAt: "2026-11-01T00:00:00Z" });
  await store.putDoc("application", "app_1", "applications", { id: "app_1", company: "Fieldwork", email: "a@b.co", useCase: "online shop", createdAt: "2026-11-02T00:00:00Z" });
  return adminApp({ store, limiter: new RateLimiter(), token, network: "testnet", feeBps: 50 });
}
const get = (app: Awaited<ReturnType<typeof setup>>, auth?: string) =>
  app.request("/overview", auth ? { headers: { authorization: `Bearer ${auth}` } } : {});

describe("admin overview", () => {
  it("is off without a token configured", async () => {
    expect((await get(await setup(null), TOKEN)).status).toBe(404);
  });
  it("refuses a wrong token, and rate-limits guessing", async () => {
    const app = await setup();
    expect((await get(app, "nope")).status).toBe(401);
    for (let i = 0; i < 10; i++) await get(app, "nope");
    expect((await get(app, TOKEN)).status).toBe(429);
  });
  it("returns stats, applications and merchants", async () => {
    const r = await get(await setup(), TOKEN);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const j = (await r.json()) as { stats: Record<string, number>; applications: { company: string }[]; merchants: { sandbox: boolean }[] };
    expect(j.stats).toMatchObject({ merchants: 1, sandboxMerchants: 1, applications: 1, paid: 0 });
    expect(j.applications[0]!.company).toBe("Fieldwork");
    expect(j.merchants[0]!.sandbox).toBe(true);
  });
});
