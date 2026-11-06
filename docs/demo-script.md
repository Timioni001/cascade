# Demo video script

**Target: 2:00.** Check the official submission page for the limit before recording: my notes from nearhackathon.com (2026-11-03) list the repo, tags, disclosures and licence, but no video length. Past NEAR events asked for about 3 minutes, and other hackathons use 2 to 5. Two minutes is safe for all of them, and §B below adds 45 seconds if you have 3.

Record at 1920×1080, browser zoom 100%, no bookmarks bar. Have these open as tabs in this order, all logged in and warmed up: `/`, `/shop`, `/pos`, `/dashboard`, a terminal.

| # | Time | On screen | What you say |
| --- | --- | --- | --- |
| 1 | 0:00–0:12 | Landing hero. Let the coins orbit once, then scroll to the products grid and back. | "Crypto payments are still a mess for businesses. Which coin, which chain, which address, then reconcile it by hand. Cascade is payments infrastructure on NEAR that makes it one button." |
| 2 | 0:12–0:30 | `/shop`. Click **Pay with any crypto**. Pick **ETH on Base**. Point at the fee line and the amount. | "A real shop. The customer pays with whatever they already hold: ETH on Base, SOL, Bitcoin, 200+ coins on 35+ chains. They see the exact price, the shop receives exactly twenty-five dollars." |
| 3 | 0:30–0:45 | Paste the refund address, **Get payment address**, show the QR, click **Simulate the payment**. Wait for **Payment complete**. | "NEAR Intents converts and delivers it. No bridge to pick, no gas token to buy. If anything fails, the customer is refunded automatically on their own chain." |
| 4 | 0:45–0:58 | Click **Verify receipt**. Show the four green checks, then the shop tab now reading **Order paid**. | "Every payment leaves a receipt on NEAR that anyone can verify: recorded on chain, bound to this exact order, same one-time address, delivered. The shop ships because a signed webhook said so, not because a browser did." |
| 5 | 0:58–1:12 | `/pos`. Type **12.50**, **Charge**, show the QR, switch to the phone-sized window, pay, land on the green **Paid** screen. | "The same rails in person. Type an amount, the customer scans, and it turns green when the money has actually arrived. That is a point of sale for any coin, with no terminal to buy." |
| 6 | 1:12–1:30 | `/dashboard`: Overview, then **Invoices**, **Subscriptions**, then **Payouts** (expand a batch) and **Escrow**. | "And the operations around the money: invoices and subscriptions, payouts to fifty people each on their own chain after a DAO vote, and milestone escrow the contract holds and releases when the client approves." |
| 7 | 1:30–1:45 | **Agents** tab, then the terminal: `pnpm agent`, showing the 402 and the paid response. | "AI agents get their own budget, with per-payment and daily limits the NEAR contract enforces. The agent pays an x402 API with no gas and no wallet pop-up, and the receipt shows who authorised it and for what." |
| 8 | 1:45–2:00 | Split screen: the mainnet links in the README's Proof section, then the landing page with **Start free**. | "This is live on testnet today, with real mainnet payments through 1Click as proof. Anyone can create a sandbox account in ten seconds and start building. Cascade: get paid in any coin, receive dollars." |

## §B. The extra 45 seconds, if the limit is 3 minutes

Insert after step 6.

| Time | On screen | What you say |
| --- | --- | --- |
| +0:15 | Dashboard **Settings**: the payout destination and the read-only key. | "Settle where you want: USDC on NEAR, Ethereum, Base, Arbitrum or Solana. Changing that needs a signature from your own NEAR account, so a leaked API key cannot redirect your money. Your accountant gets a read-only key." |
| +0:15 | Terminal: `pnpm demo` scrolling to **All checks passed**. | "Everything you just saw runs end to end on a real NEAR node, with thirty-eight checks in the repo: splits, refunds, DAO payroll, escrow and agent limits." |
| +0:15 | Claude or Cursor with the Cascade MCP server: ask it to invoice a customer, then to buy a paid API. | "And because it speaks MCP, an assistant can run the account and spend the budget: 'invoice Fieldwork Café for twenty-four mugs', or buy an API within the limits you set." |

## Tips

- **Record in sandbox mode.** The "Sandbox" chip in the nav is honest about simulated swaps, and the mainnet proof links cover the real-money claim.
- **Warm every page first.** Load each tab once before recording so nothing is still fetching.
- **Pre-fill the slow fields.** Copy the refund address `0x2527D02599Ba641c19FEa793cD0F167589a0f10D` to the clipboard before you start.
- **Cut, don't wait.** The settler needs a few seconds; cut straight to the paid state rather than filming a spinner.
- **Mute the terminal font below 16px.** Judges often watch at half size.
- **Captions over claims.** When you say "mainnet", put the transaction link on screen.
- **Last frame:** the URL and the repo, held for three seconds.
