/**
 * Browser test of the merchant button + hosted checkout, against `pnpm dev`.
 * Optional: needs Playwright with Chromium (`npm i -g playwright && npx playwright install chromium`).
 *
 *   pnpm dev            # in one terminal
 *   pnpm test:e2e       # in another (CASCADE_DASHBOARD_KEY=sk_... to include the dashboard)
 *
 * Opens the demo shop, pays through the modal checkout (ETH on Base, QR,
 * simulated deposit), checks the receipt page's four checks, the shop's
 * webhook-driven order status, and the merchant dashboard. Screenshots go to
 * the directory given as the first argument.
 */
const { chromium } = require("playwright");
const out = process.argv[2] || ".";
const BASE = (process.env.CASCADE_WEB ?? "http://localhost:3000").replace(/\/$/, "");
const assert = (c, m) => {
  if (!c) throw new Error(m);
};

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const page = async (w, h) => {
    const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    return p;
  };

  const home = await page(1280, 820);
  await home.goto(`${BASE}/`);
  await home.waitForSelector("text=Receive dollars.");
  await home.waitForTimeout(800);
  await home.screenshot({ path: `${out}/1-landing.png` });

  const p = await page(1280, 900);
  await p.goto(`${BASE}/shop`);
  await p.screenshot({ path: `${out}/2-shop.png` });
  await p.click("text=Pay with any crypto");
  const frame = await (await p.waitForSelector("iframe[title='Cascade checkout']")).contentFrame();
  await frame.waitForSelector("button[aria-pressed]");
  await frame.click("button[aria-pressed]:has-text('Base') >> nth=0");
  await frame.waitForSelector("text=You pay");
  await frame.waitForTimeout(400);
  await p.screenshot({ path: `${out}/3-checkout-quote.png` });
  await frame.fill("input", "0x2527D02599Ba641c19FEa793cD0F167589a0f10D");
  await frame.click("text=Get payment address");
  await frame.waitForSelector("[aria-label='Copy address']");
  await frame.waitForSelector("img[alt^='QR code']");
  const qr = await frame.getAttribute("img[alt^='QR code']", "src");
  assert(qr && qr.startsWith("data:image/png"), "no QR code for the deposit");
  await p.screenshot({ path: `${out}/4-checkout-deposit.png` });
  await frame.click("text=Simulate the payment (sandbox)");
  await frame.waitForSelector("text=Payment complete", { timeout: 30000 });
  await p.waitForTimeout(500);
  const h = await p.evaluate(() => document.querySelector("iframe").getBoundingClientRect().height);
  assert(h < 700, `iframe did not resize (${h}px)`);
  await p.screenshot({ path: `${out}/5-checkout-paid.png` });
  const receiptHref = await frame.getAttribute("a:has-text('Verify receipt')", "href");
  await frame.click("text=Payment complete");
  await p.keyboard.press("Escape");
  await p.waitForSelector("iframe[title='Cascade checkout']", { state: "detached", timeout: 5000 });
  await p.waitForSelector("text=is paid", { timeout: 30000 });
  await p.screenshot({ path: `${out}/6-shop-paid.png` });

  // The public receipt recomputes its checks from the chain and 1Click.
  const r = await page(720, 1100);
  await r.goto(`${BASE}${receiptHref}`);
  await r.waitForSelector("text=Bound to this exact order");
  const passed = await r.evaluate(() => document.querySelectorAll("[data-check=ok]").length);
  assert(passed === 4, `receipt shows ${passed}/4 checks passing`);
  await r.screenshot({ path: `${out}/7-receipt.png` });

  const key = process.env.CASCADE_DASHBOARD_KEY;
  if (key) {
    const d = await page(1360, 900);
    await d.goto(`${BASE}/dashboard`);
    await d.fill("input[type=password]", key);
    await d.click("text=Open dashboard");
    await d.waitForSelector("text=Oakline Ceramics");
    await d.waitForSelector("text=Recent payments");
    await d.waitForTimeout(600);
    await d.screenshot({ path: `${out}/8-dashboard.png` });
    await d.click("button:has-text('Webhooks')");
    await d.waitForSelector("text=checkout.session.completed");
    await d.click("button:has-text('Payments')");
    await d.click("button:has-text('Refund') >> nth=0");
    await d.waitForSelector("text=create_batch");
    await d.screenshot({ path: `${out}/9-dashboard-refund.png`, fullPage: true });

    // Invoices: create one, pay it from the hosted page in any coin, see it paid.
    await d.click("button:has-text('Invoices')");
    await d.click("text=Create invoice");
    await d.waitForSelector("text=INV-0001");
    await d.screenshot({ path: `${out}/11-dashboard-invoices.png` });
    const invHref = await d.getAttribute("a:has-text('Open') >> nth=0", "href");
    const inv = await page(1100, 1100);
    await inv.goto(`${BASE}${invHref}`);
    await inv.waitForSelector("text=Fieldwork Café");
    await inv.screenshot({ path: `${out}/12-invoice.png` });
    await inv.click("text=with any crypto");
    await inv.waitForURL(/\/c\/cs_/);
    await inv.click("button[aria-pressed]:has-text('Solana') >> nth=0");
    await inv.fill("input", "So11111111111111111111111111111111111111112");
    await inv.click("text=Get payment address");
    await inv.click("text=Simulate the payment (sandbox)");
    await inv.waitForSelector("text=Payment complete", { timeout: 30000 });
    await inv.goto(`${BASE}${invHref}`);
    await inv.waitForSelector("text=On-chain receipt", { timeout: 30000 });
    await inv.screenshot({ path: `${out}/13-invoice-paid.png` });

    // Subscriptions, customers, settings.
    await d.click("button:has-text('Subscriptions')");
    await d.click("text=Add plan");
    await d.waitForSelector("option:has-text('Mug of the month')", { state: "attached" });
    await d.click("text=Create subscription");
    await d.waitForSelector("text=First invoice, ready to send");
    await d.waitForSelector("td:has-text('Ines Duarte')");
    await d.screenshot({ path: `${out}/14-dashboard-subscriptions.png` });
    await d.click("button:has-text('Customers')");
    await d.waitForSelector("text=Fieldwork Café");
    await d.screenshot({ path: `${out}/15-dashboard-customers.png` });
    // Money out: payouts, escrow (with a funding link for the client), agent budgets.
    await d.click("button:has-text('Payouts')");
    await d.waitForSelector("text=Contractors, November");
    await d.click("text=Contractors, November");
    await d.waitForSelector("text=Product photographer");
    await d.screenshot({ path: `${out}/17-dashboard-payouts.png` });
    await d.click("button:has-text('Escrow')");
    await d.waitForSelector("text=Glaze samples approved");
    await d.click("text=Create a funding link");
    await d.waitForSelector("text=Funding link for the client");
    await d.screenshot({ path: `${out}/18-dashboard-escrow.png`, fullPage: true });
    await d.click("button:has-text('Agents')");
    await d.waitForSelector("text=oakline-assistant.sandbox");
    await d.screenshot({ path: `${out}/19-dashboard-agents.png` });
    await d.click("button:has-text('Settings')");
    await d.click("text=New read-only key");
    await d.waitForSelector("text=Shown once");
    await d.screenshot({ path: `${out}/16-dashboard-settings.png` });
  }

  const m = await page(390, 844);
  await m.goto(`${BASE}${receiptHref.replace("/r/", "/c/")}`);
  await m.waitForSelector("text=Payment complete");
  await m.screenshot({ path: `${out}/10-mobile-checkout.png` });

  // Self-serve: a visitor creates a sandbox merchant, rings up a sale at the point of sale, a customer pays it.
  const st = await page(1280, 900);
  await st.goto(`${BASE}/start`);
  await st.fill("input[aria-label='Business name']", "Kiln Coffee");
  await st.click("text=Create a sandbox account");
  await st.waitForSelector("text=is ready on NEAR", { timeout: 90000 });
  await st.screenshot({ path: `${out}/20-start-sandbox.png` });
  await st.click("button:has-text('Point of sale')");
  await st.waitForURL(/\/pos/);
  for (const d of ["1", "2", "5", "0"]) await st.click(`button[aria-label='${d}']`);
  await st.fill("input[aria-label='Description']", "Flat white and a croissant");
  await st.click("text=Charge $12.50");
  await st.waitForSelector("text=Scan to pay with any coin");
  await st.screenshot({ path: `${out}/21-pos-qr.png` });
  const payUrl = await st.getAttribute("a:has-text('Open the checkout on this device')", "href");
  const cust = await page(430, 900);
  await cust.goto(payUrl);
  await cust.click("button[aria-pressed]:has-text('Base') >> nth=0");
  await cust.fill("input", "0x2527D02599Ba641c19FEa793cD0F167589a0f10D");
  await cust.click("text=Get payment address");
  await cust.click("text=Simulate the payment (sandbox)");
  await st.waitForSelector("text=Paid. The money is in your account", { timeout: 60000 });
  await st.screenshot({ path: `${out}/22-pos-paid.png` });

  // Phone widths: landing, shop, developers.
  for (const [name, path] of [["23-mobile-landing", "/"], ["24-mobile-shop", "/shop"], ["25-mobile-developers", "/developers"]]) {
    const ph = await page(390, 844);
    await ph.goto(`${BASE}${path}`);
    await ph.waitForTimeout(500);
    const overflow = await ph.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 1, `${path} scrolls sideways on a phone (${overflow}px)`);
    await ph.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  }

  assert(errs.length === 0, `console errors: ${errs.join(" | ")}`);
  console.log(`e2e ok: landing, shop, checkout (quote, QR, paid), webhook-fulfilled order, receipt 4/4${key ? ", dashboard + refund, invoice paid from its page, subscriptions, customers, read-only key" : ""}, mobile`);
  await b.close();
})().catch((e) => {
  console.error("e2e FAILED:", e.message);
  process.exit(1);
});
