/**
 * Every button and link, on every page.
 *
 *   pnpm dev                                   # in one terminal
 *   CASCADE_DASHBOARD_KEY=sk_... pnpm test:buttons
 *
 * For each page (and each dashboard tab) it:
 *   - checks every internal link resolves (no 404) and every #anchor exists;
 *   - clicks every visible, enabled button, one at a time on a fresh load, and
 *     records page errors, console errors, failed API calls (5xx), and buttons
 *     that do nothing at all (no DOM change, no request, no navigation);
 *   - skips buttons whose effect is destructive or irreversible (sign out,
 *     revoke, void, refund, delete), which other tests cover.
 *
 * Exits non-zero on any error; "no effect" buttons are listed for review.
 */
const { chromium } = require("playwright");

const BASE = (process.env.CASCADE_WEB ?? "http://localhost:3000").replace(/\/$/, "");
const KEY = process.env.CASCADE_DASHBOARD_KEY;
const SKIP = /sign out|revoke|void|refund|delete|remove|cancel subscription|disconnect|log ?out/i;
const TABS = ["Overview", "Payments", "Invoices", "Subscriptions", "Customers", "Splits", "Payouts", "Escrow", "Agents", "Webhooks", "Reports", "Settings"];

async function api(path, body) {
  const r = await fetch(`${BASE}/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${KEY}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

(async () => {
  const pages = [
    { name: "landing", url: "/" },
    { name: "shop", url: "/shop" },
    { name: "start", url: "/start" },
    { name: "developers", url: "/developers" },
    { name: "pos (signed out)", url: "/pos" },
    { name: "dashboard (signed out)", url: "/dashboard" },
    { name: "admin (signed out)", url: "/admin" },
  ];
  if (KEY) {
    const s = await api("checkout/sessions", { amount: "9000000", description: "Button audit" });
    const id = s.id;
    const inv = await api("invoices", { customer: { name: "Audit Co", email: "audit@example.com" }, items: [{ description: "Audit item", quantity: 1, unitAmount: "5000000" }] });
    const paid = (await api("checkout/sessions?limit=50")).data.find((x) => x.status === "paid");
    pages.push({ name: "checkout", url: `/c/${id}` }, { name: "invoice", url: `/i/${inv.id}` });
    if (paid) pages.push({ name: "receipt", url: `/r/${paid.id}` });
    for (const t of TABS) pages.push({ name: `dashboard: ${t}`, url: "/dashboard", tab: t });
    pages.push({ name: "pos (signed in)", url: "/pos", pos: true });
  }

  const b = await chromium.launch();
  const problems = [];
  const idle = [];
  let clicked = 0, links = 0;

  async function open(pg) {
    const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on("pageerror", (e) => errs.push(`page error: ${e.message}`));
    p.on("console", (m) => { if (m.type() === "error" && !/favicon|Download the React DevTools|net::ERR_ABORTED/.test(m.text())) errs.push(`console: ${m.text().slice(0, 160)}`); });
    p.on("response", (r) => { if (r.status() >= 500) errs.push(`HTTP ${r.status()} ${r.url().replace(BASE, "")}`); });
    if (KEY) await ctx.addInitScript((k) => { try { sessionStorage.setItem("cascade_dashboard_key", k); } catch {} }, pg.tab || pg.pos ? KEY : "");
    await p.goto(BASE + pg.url, { waitUntil: "networkidle" });
    if (pg.tab) { await p.click(`aside >> text=${pg.tab}`); await p.waitForTimeout(700); }
    await p.waitForTimeout(400);
    return { ctx, p, errs };
  }

  for (const pg of pages) {
    const { ctx, p, errs } = await open(pg);
    // Links
    const hrefs = await p.$$eval("a[href]", (as) => as.filter((a) => a.offsetParent !== null).map((a) => a.getAttribute("href")));
    for (const h of [...new Set(hrefs)]) {
      links++;
      if (!h || h === "#") { problems.push(`${pg.name}: empty link`); continue; }
      if (h.startsWith("#")) { if (!(await p.$(h))) problems.push(`${pg.name}: anchor ${h} has no target`); continue; }
      if (h.startsWith("/")) {
        const r = await fetch(BASE + h, { redirect: "manual" });
        if (r.status >= 400) problems.push(`${pg.name}: link ${h} -> ${r.status}`);
      }
    }
    // Buttons
    const labels = await p.$$eval("button", (bs) => bs.filter((x) => x.offsetParent !== null && !x.disabled).map((x, i) => ({ i, label: (x.getAttribute("aria-label") || x.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60) })));
    if (errs.length) problems.push(...errs.map((e) => `${pg.name} (load): ${e}`));
    await ctx.close();
    for (const { i, label } of labels) {
      if (SKIP.test(label)) continue;
      const o = await open(pg);
      const btn = (await o.p.$$("button")).filter(Boolean);
      const visible = [];
      for (const x of btn) if (await x.isVisible() && await x.isEnabled()) visible.push(x);
      const target = visible[i];
      if (!target) { await o.ctx.close(); continue; }
      const before = await o.p.evaluate(() => document.body.innerHTML + location.href);
      let requests = 0;
      o.p.on("request", (r) => { if (!/_next|\.(png|svg|css|js|woff2?)$/.test(r.url())) requests++; });
      const popup = o.ctx.waitForEvent("page", { timeout: 1200 }).then(() => true, () => false);
      try { await target.click({ timeout: 3000 }); } catch (e) { problems.push(`${pg.name}: "${label}" not clickable (${e.message.split("\n")[0].slice(0, 80)})`); await o.ctx.close(); continue; }
      clicked++;
      await o.p.waitForTimeout(900);
      const after = await o.p.evaluate(() => document.body.innerHTML + location.href).catch(() => "navigated");
      const opened = await popup;
      if (o.errs.length) problems.push(...o.errs.map((e) => `${pg.name}: "${label}": ${e}`));
      if (before === after && requests === 0 && !opened) idle.push(`${pg.name}: "${label}"`);
      await o.ctx.close();
    }
  }
  await b.close();

  console.log(`checked ${pages.length} pages, ${links} links, ${clicked} button clicks`);
  if (idle.length) console.log(`\nno visible effect (review):\n  ${idle.join("\n  ")}`);
  if (problems.length) {
    console.log(`\nPROBLEMS (${problems.length}):\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log("\nbuttons ok: no errors, no dead links");
})().catch((e) => { console.error(e); process.exit(1); });
