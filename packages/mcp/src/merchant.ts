/**
 * Merchant tools: run a Cascade account from an AI assistant ("invoice
 * Fieldwork Café for 24 mugs", "how much came in this week?"). They use the
 * public SDK with the merchant's key; give the assistant a read-only key
 * (rk_...) and it can look but not act.
 */
import { Cascade, type CheckoutSession } from "@cascade/sdk";
import { ToolError, dollars, fmt, num, str, type Tool } from "./protocol.js";

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

export function merchantTools(cascade: Cascade, apiUrl: string, key: string, f: typeof fetch = fetch): Tool[] {
  const readOnly = key.startsWith("rk_");
  const tools: Tool[] = [
    {
      name: "merchant_overview",
      title: "Account overview",
      description: "The merchant's name, where payments settle, USDC balance on NEAR, and totals for the last 7 and 30 days.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      readOnly: true,
      run: async () => {
        const me = await cascade.merchant.me();
        const bal = await f(`${apiUrl}/v1/merchant/balance`, { headers: { authorization: `Bearer ${key}` } }).then((r) => (r.ok ? (r.json() as Promise<{ usdc: string }>) : null), () => null);
        const { data } = await cascade.checkout.list({ limit: 100 });
        const since = (d: number) => data.filter((s) => s.status === "paid" && s.paidAt && Date.now() - Date.parse(s.paidAt) < d * 86_400_000);
        const sum = (l: CheckoutSession[]) => fmt(l.reduce((t, s) => t + BigInt(s.amount), 0n));
        return {
          name: me.name, account: me.account,
          settlesAs: me.payout ? `USDC on ${me.payout.chain} to ${me.payout.address}` : `USDC on NEAR to ${me.account}`,
          balanceUsdcOnNear: bal ? fmt(bal.usdc) : null,
          last7Days: { paid: since(7).length, total: sum(since(7)) },
          last30Days: { paid: since(30).length, total: sum(since(30)) },
          keyAccess: readOnly ? "read-only" : "full",
        };
      },
    },
    {
      name: "list_payments",
      title: "Recent payments",
      description: "Recent checkout sessions with status (open, paid, expired), amount, reference and receipt link.",
      inputSchema: { type: "object", properties: { limit: { type: "number", default: 20 } }, additionalProperties: false },
      readOnly: true,
      run: async (a) => {
        const { data } = await cascade.checkout.list({ limit: Math.min(Math.max(num(a, "limit") ?? 20, 1), 100) });
        return data.map((s) => ({
          id: s.id, description: s.description, amount: s.amountFormatted, status: s.status, reference: s.reference, created: day(s.createdAt), paid: day(s.paidAt),
          ...(s.receipt ? { receipt: s.url.replace(/\/c\//, "/r/") } : { payLink: s.url }),
        }));
      },
    },
    {
      name: "list_invoices",
      title: "Invoices",
      description: "Invoices with number, customer, total, due date and status (open, overdue, paid, void).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      readOnly: true,
      run: async () =>
        (await cascade.invoices.list()).data.map((i) => ({
          number: i.number, id: i.id, customer: i.customer.name, total: i.amountFormatted, due: i.dueDate,
          status: i.status === "open" && i.overdue ? "overdue" : i.status, url: i.url,
        })),
    },
    {
      name: "list_customers",
      title: "Customers",
      description: "Everyone the merchant has invoiced or subscribed, with lifetime paid, outstanding and active subscriptions.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      readOnly: true,
      run: async () => (await cascade.customers.list()).data.map((c) => ({ ...c, paid: fmt(c.paid), outstanding: fmt(c.outstanding) })),
    },
  ];
  if (readOnly) return tools;

  tools.push(
    {
      name: "create_payment_link",
      title: "Create a payment link",
      description: "Create a checkout link for an exact dollar amount. The customer pays with any coin on any chain; the merchant receives exactly that amount.",
      inputSchema: {
        type: "object",
        properties: {
          amount: { type: "string", description: "Dollars, e.g. \"25.00\"" },
          description: { type: "string" },
          reference: { type: "string", description: "Your order id (optional)" },
          expires_in_minutes: { type: "number", description: "5 to 1440 (default 60)" },
        },
        required: ["amount", "description"],
        additionalProperties: false,
      },
      run: async (a) => {
        const exp = num(a, "expires_in_minutes");
        const s = await cascade.checkout.create({
          amount: dollars(a.amount, "amount"), description: str(a, "description")!,
          ...(str(a, "reference", false) ? { reference: str(a, "reference", false)! } : {}),
          ...(exp !== undefined ? { expiresInMinutes: exp } : {}),
        });
        return { url: s.url, id: s.id, amount: s.amountFormatted, expires: s.expiresAt };
      },
    },
    {
      name: "create_invoice",
      title: "Create an invoice",
      description: "Create a numbered invoice with line items and a due date. Returns the hosted page the customer pays from, with any coin.",
      inputSchema: {
        type: "object",
        properties: {
          customer_name: { type: "string" },
          customer_email: { type: "string" },
          items: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: { description: { type: "string" }, quantity: { type: "number", default: 1 }, unit_price: { type: "string", description: "Dollars, e.g. \"18.00\"" } },
              required: ["description", "unit_price"],
            },
          },
          days_until_due: { type: "number", default: 14 },
          memo: { type: "string" },
        },
        required: ["customer_name", "items"],
        additionalProperties: false,
      },
      run: async (a) => {
        if (!Array.isArray(a.items) || !a.items.length) throw new ToolError("items: at least one line");
        const days = num(a, "days_until_due");
        const inv = await cascade.invoices.create({
          customer: { name: str(a, "customer_name")!, ...(str(a, "customer_email", false) ? { email: str(a, "customer_email", false)! } : {}) },
          items: (a.items as Record<string, unknown>[]).map((it, i) => ({
            description: str(it, "description")!, quantity: num(it, "quantity") ?? 1, unitAmount: dollars(it.unit_price, `items[${i}].unit_price`),
          })),
          ...(days !== undefined ? { daysUntilDue: days } : {}),
          ...(str(a, "memo", false) ? { memo: str(a, "memo", false)! } : {}),
        });
        return { number: inv.number, total: inv.amountFormatted, due: inv.dueDate, url: inv.url, id: inv.id };
      },
    },
    {
      name: "void_invoice",
      title: "Void an invoice",
      description: "Void an open invoice (by id, in_...). It can no longer be paid.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      run: async (a) => {
        const inv = await cascade.invoices.void(str(a, "id")!);
        return { number: inv.number, status: inv.status };
      },
    },
  );
  return tools;
}
