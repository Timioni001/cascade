/**
 * Browser test of the merchant button + hosted checkout, against `pnpm dev`.
 * Optional: needs Playwright with Chromium (`npm i -g playwright && npx playwright install chromium`).
 *
 *   pnpm dev            # in one terminal
 *   pnpm test:e2e       # in another
 *
 * Opens the demo shop, clicks "Pay with any crypto", picks ETH on Base inside
 * the iframe, gets a deposit address, simulates the payment, and checks that
 * the modal resizes, closes on Escape, and the shop's order is paid (which
 * only happens when the shop's server verified the webhook).
 */
const { chromium } = require("playwright");
const out = process.argv[2] || ".";
const assert = (c, m) => {
  if (!c) throw new Error(m);
};

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1100, height: 820 } });
  const errs = [];
  p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await p.goto("http://localhost:3000/shop");
  await p.click("text=Pay with any crypto");
  const frame = await (await p.waitForSelector("iframe[title='Cascade checkout']")).contentFrame();
  await frame.waitForSelector("button.asset");
  await frame.click("button.asset:has-text('Base') >> nth=0");
  await frame.waitForSelector("text=You pay");
  await frame.fill("input", "0x2527D02599Ba641c19FEa793cD0F167589a0f10D");
  await frame.click("text=Get payment address");
  await frame.waitForSelector("text=Copy address");
  await frame.waitForSelector("img[alt^='QR code']");
  const qr = await frame.getAttribute("img[alt^='QR code']", "src");
  assert(qr && qr.startsWith("data:image/png"), "no QR code for the deposit");
  await p.screenshot({ path: `${out}/checkout-deposit.png` });
  await frame.click("text=Simulate the payment (sandbox)");
  await frame.waitForSelector(".status.ok", { timeout: 30000 });
  await p.waitForTimeout(500);
  const h = await p.evaluate(() => document.querySelector("iframe").getBoundingClientRect().height);
  assert(h < 600, `iframe did not resize (${h}px)`);
  await p.screenshot({ path: `${out}/checkout-paid.png` });
  const receiptHref = await frame.getAttribute("text=Verify receipt", "href");
  await frame.click("text=Paid");
  await p.keyboard.press("Escape");
  await p.waitForSelector("iframe[title='Cascade checkout']", { state: "detached", timeout: 5000 });
  await p.waitForSelector("text=paid. Shipping soon", { timeout: 30000 });
  // The public receipt recomputes its checks from the chain and 1Click.
  const r = await b.newPage({ viewport: { width: 700, height: 820 } });
  r.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await r.goto(`http://localhost:3000${receiptHref}`);
  await r.waitForSelector("text=bound to this exact order");
  const okChecks = await r.locator(".status.ok").count();
  assert(okChecks === 4, `receipt shows ${okChecks}/4 checks passing`);
  await r.screenshot({ path: `${out}/receipt.png` });

  // The merchant dashboard lists the paid session.
  const key = process.env.CASCADE_DASHBOARD_KEY;
  if (key) {
    const d = await b.newPage({ viewport: { width: 1000, height: 820 } });
    d.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    await d.goto("http://localhost:3000/dashboard");
    await d.fill("input[type=password]", key);
    await d.click("text=Open dashboard");
    await d.waitForSelector("text=Lagos Prints");
    await d.waitForSelector("td >> text=paid");
    await d.click("button:has-text('Webhooks')");
    await d.waitForSelector("text=checkout.session.completed");
    await d.click("button:has-text('Sessions')");
    await d.click("text=Refund >> nth=0");
    await d.waitForSelector("text=create_batch");
    await d.screenshot({ path: `${out}/dashboard.png` });
  }
  assert(errs.length === 0, `console errors: ${errs.join(" | ")}`);
  console.log(`e2e ok: QR shown, paid through the button, webhook fulfilled the order, receipt 4/4${key ? ", dashboard + refund prepared" : ""}`);
  await b.close();
})().catch((e) => {
  console.error("e2e FAILED:", e.message);
  process.exit(1);
});
