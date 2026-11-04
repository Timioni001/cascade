# Cascade for AI assistants (MCP)

`cascade-mcp` is a Model Context Protocol server (stdio). Any MCP client (Claude Desktop, Claude Code, Cursor, and others) can use it for two jobs:

| Tools | Needs | What the assistant can do |
| --- | --- | --- |
| `merchant_overview`, `list_payments`, `list_invoices`, `list_customers` | `CASCADE_SECRET_KEY`, or a read-only `rk_...` key | Answer "how much came in this week?", "who still owes us?" |
| `create_payment_link`, `create_invoice`, `void_invoice` | a full `sk_...` key | "Invoice Fieldwork Café for 24 mugs at $18, due in two weeks" |
| `wallet_status`, `paid_fetch` | an agent account with a Cascade budget | Pay x402 APIs from its owner's budget, within limits the NEAR contract enforces, with no gas |

Give an assistant a read-only key unless it needs to create things: with `rk_...` the write tools are not offered at all.

## The agent wallet

The owner gives the agent a budget once, from their own account (gasless through Cascade):

```ts
appCalls(app).setAllowance("bot.ada.near", {
  per_payment_max: "500000",   // $0.50
  daily_max: "5000000",        // $5.00 a day
  expires_at_ms: Date.now() + 30 * 86_400_000,
  payees: [],                  // or a list of allowed recipients
}, "Market data for the weekly report");  // the purpose, shown on every receipt
// then fund it: usdc.ft_transfer_call(app, amount, '{"allowance":"bot.ada.near"}')
```

`paid_fetch` requests a URL. If the API answers HTTP 402 with a Cascade budget option, it pays with `agent_pay` (signed by the agent's key, relayed so the agent needs no NEAR) and retries. The contract refuses anything over the per-payment limit, over the day's limit, after expiry, to a recipient not on the list, or after the owner revokes. `max_usd` caps a single call further. Every payment has a public receipt that shows who authorized the agent, for what, and within which limits.

The agent's key can only spend through the allowance: give it a key that has no other funds.

## Configure

Claude Desktop (`claude_desktop_config.json`) or any client that launches stdio servers:

```json
{
  "mcpServers": {
    "cascade": {
      "command": "npx",
      "args": ["tsx", "/path/to/cascade/packages/mcp/src/main.ts"],
      "env": {
        "CASCADE_URL": "https://cascade.<you>.workers.dev",
        "CASCADE_SECRET_KEY": "rk_live_...",
        "NEAR_NETWORK": "testnet",
        "CASCADE_APP_ID": "app.<root>.testnet",
        "CASCADE_AGENT_ACCOUNT": "bot.<you>.testnet",
        "CASCADE_AGENT_KEY": "ed25519:...",
        "CASCADE_AGENT_OWNER": "<you>.testnet"
      }
    }
  }
}
```

Claude Code: `claude mcp add cascade --env CASCADE_URL=... --env CASCADE_SECRET_KEY=... -- npx tsx /path/to/cascade/packages/mcp/src/main.ts`

Leave out the agent variables for merchant tools only, or the key for the wallet only. `NEAR_RPC_URL` overrides the RPC endpoint.

## Protocol

JSON-RPC 2.0 over stdio, one message per line; protocol versions 2025-06-18, 2025-03-26 and 2024-11-05. Tools declare `readOnlyHint`, return text and `structuredContent`, and report failures (a refused payment, an invalid amount) as tool results with `isError`, so the model can read them and adjust. No dependencies beyond Cascade's own packages.
