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
  await frame.click("text=Simulate the payment (sandbox)");
  await frame.waitForSelector(".status.ok", { timeout: 30000 });
  await p.waitForTimeout(500);
  const h = await p.evaluate(() => document.querySelector("iframe").getBoundingClientRect().height);
  assert(h < 600, `iframe did not resize (${h}px)`);
  await p.screenshot({ path: `${out}/checkout-paid.png` });
  await frame.click("text=Paid");
  await p.keyboard.press("Escape");
  await p.waitForSelector("iframe[title='Cascade checkout']", { state: "detached", timeout: 5000 });
  await p.waitForSelector("text=paid. Shipping soon", { timeout: 30000 });
  assert(errs.length === 0, `console errors: ${errs.join(" | ")}`);
  console.log("e2e ok: paid through the button, webhook fulfilled the order");
  await b.close();
})().catch((e) => {
  console.error("e2e FAILED:", e.message);
  process.exit(1);
});
