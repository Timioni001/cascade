import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Owner } from "@cascade/core";
import { MemoryStore } from "@cascade/db";
import { Billing, Checkout, onboardingMessage, type OnboardingProof } from "@cascade/engine";
import type { Chain } from "@cascade/near";
import { MemoryDriver, MockOneClick } from "@cascade/oneclick";
import { Cascade } from "@cascade/sdk";
import { apiApp } from "@cascade/api";
import { McpServer, ToolError, dollars, merchantTools, type Tool } from "../src/index.js";

const echo: Tool = { name: "echo", title: "Echo", description: "x", inputSchema: { type: "object", properties: {} }, readOnly: true, run: async (a) => ({ got: a }) };
const boom: Tool = { name: "boom", title: "Boom", description: "x", inputSchema: { type: "object", properties: {} }, run: async () => { throw new ToolError("over the daily limit"); } };
const server = () => new McpServer({ name: "t", title: "T", version: "1" }, [echo, boom], "be careful");

describe("MCP protocol", () => {
  it("initializes, lists tools with annotations, calls them, reports tool errors as results", async () => {
    const s = server();
    const init = (await s.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "1" } } })) as { result: Record<string, unknown> };
    expect(init.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "t" }, instructions: "be careful" });
    expect(await s.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const list = (await s.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } };
    expect(list.result.tools.map((t) => [t.name, t.annotations.readOnlyHint])).toEqual([["echo", true], ["boom", false]]);
    const ok = (await s.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { a: 1 } } })) as { result: { structuredContent: unknown; isError?: boolean } };
    expect(ok.result).toMatchObject({ structuredContent: { got: { a: 1 } } });
    expect(ok.result.isError).toBeUndefined();
    const bad = (await s.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "boom" } })) as { result: { isError: boolean; content: { text: string }[] } };
    expect(bad.result).toMatchObject({ isError: true, content: [{ text: "over the daily limit" }] });
    expect(await s.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } })).toMatchObject({ error: { code: -32602 } });
    expect(await s.handle({ jsonrpc: "2.0", id: 6, method: "resources/list" })).toMatchObject({ error: { code: -32601 } });
    expect(await s.handle({ jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: "1999-01-01" } })).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
  });

  it("speaks newline-delimited JSON over stdio", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: unknown[] = [];
    output.on("data", (c: Buffer) => c.toString().split("\n").filter(Boolean).forEach((l) => lines.push(JSON.parse(l))));
    const done = server().serveStdio(input, output);
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\nnot json\n');
    input.end('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","arguments":{}}}\n');
    await done;
    expect(lines).toEqual(expect.arrayContaining([{ jsonrpc: "2.0", id: 1, result: {} }, expect.objectContaining({ id: null, error: expect.objectContaining({ code: -32700 }) }), expect.objectContaining({ id: 2 })]));
    expect(lines).toHaveLength(3);
  });

  it("parses dollar amounts exactly", () => {
    expect([dollars("12.5", "x"), dollars(0.1, "x"), dollars("467", "x")]).toEqual([12_500_000n, 100_000n, 467_000_000n]);
    expect(() => dollars("-1", "x")).toThrow(ToolError);
  });
});

describe("merchant tools over the real API", () => {
  async function setup() {
    const owners: Record<string, Owner> = { "shop.near": { id: "shop.near", kind: "Account", preparers: [], token: "usdc" } };
    const chain = { view: async (_c: string, m: string, a: { id?: string }) => (m === "get_owner" ? owners[a.id!] ?? null : null), provider: {} } as unknown as Chain;
    const store = new MemoryStore();
    const checkout = new Checkout({
      store, oneclick: new MockOneClick({ driver: new MemoryDriver() }), chain, app: "app.near", publicUrl: "https://cascade.link",
      verifyProof: async (p: OnboardingProof, msg: string) => Buffer.from(p.signature, "base64").toString() === msg,
    });
    const api = apiApp({ checkout, billing: new Billing(checkout) });
    const f: typeof fetch = async (input, init) => api.request(new Request(input, init));
    const issuedAt = new Date().toISOString();
    const r = await f("https://cascade.link/v1/merchants", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: "shop.near", name: "Oakline Ceramics", proof: { signer: "shop.near", publicKey: "ed25519:x", issuedAt, nonce: Buffer.alloc(32, 3).toString("base64"), signature: Buffer.from(onboardingMessage({ account: "shop.near", name: "Oakline Ceramics", issuedAt })).toString("base64") } }),
    });
    const { secretKey } = (await r.json()) as { secretKey: string };
    const tools = (key: string) => merchantTools(new Cascade({ apiKey: key, baseUrl: "https://cascade.link", fetch: f }), "https://cascade.link", key, f);
    return { f, secretKey, tools };
  }

  it("an assistant creates a link and an invoice, and reads them back", async () => {
    const { tools, secretKey } = await setup();
    const s = new McpServer({ name: "cascade", title: "Cascade", version: "1" }, tools(secretKey));
    const call = async (name: string, args: Record<string, unknown> = {}) => ((await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as { result: { structuredContent: never; isError?: boolean } }).result;
    expect((await call("create_payment_link", { amount: "25", description: "Stoneware mug" })).structuredContent).toMatchObject({ amount: "25.00" });
    const inv = (await call("create_invoice", { customer_name: "Fieldwork Café", items: [{ description: "Mug", quantity: 24, unit_price: "18.00" }] })).structuredContent as { number: string; total: string };
    expect(inv).toMatchObject({ number: "INV-0001", total: "432.00" });
    expect((await call("list_invoices")).structuredContent).toEqual([expect.objectContaining({ number: "INV-0001", customer: "Fieldwork Café", status: "open" })]);
    expect((await call("merchant_overview")).structuredContent).toMatchObject({ name: "Oakline Ceramics", keyAccess: "full", settlesAs: "USDC on NEAR to shop.near" });
    expect((await call("create_invoice", { customer_name: "X", items: [{ description: "y", unit_price: "abc" }] })).isError).toBe(true);
  });

  it("a read-only key exposes only read tools", async () => {
    const { f, secretKey, tools } = await setup();
    const r = await f("https://cascade.link/v1/merchant/keys", { method: "POST", headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" }, body: JSON.stringify({ role: "read" }) });
    const { key } = (await r.json()) as { key: string };
    const names = tools(key).map((t) => t.name);
    expect(names).toEqual(["merchant_overview", "list_payments", "list_invoices", "list_customers"]);
  });
});
