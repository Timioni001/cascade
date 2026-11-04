/**
 * The "Pay with any crypto" button.
 *
 *   <script type="module">
 *     import { mountPayButton } from "https://cdn.cascade.link/sdk.js";
 *     mountPayButton("#pay", { sessionUrl: "https://cascade.link/c/cs_123", onPaid: (s) => location.href = "/thanks" });
 *   </script>
 *
 * The checkout runs in an iframe on the Cascade origin; your page never sees
 * wallet data. Messages are accepted only from that origin and only for the
 * session that was opened.
 */

export interface CheckoutMessage {
  source: "cascade-checkout";
  version: 1;
  type: "ready" | "paid" | "closed" | "resize";
  sessionId: string;
  height?: number;
}

export function isCheckoutMessage(v: unknown): v is CheckoutMessage {
  const m = v as CheckoutMessage;
  return !!m && m.source === "cascade-checkout" && m.version === 1 && typeof m.sessionId === "string" && ["ready", "paid", "closed", "resize"].includes(m.type);
}

/** Session id from a hosted checkout URL (".../c/cs_abc") or null. */
export function sessionIdFromUrl(url: string): string | null {
  const m = /\/c\/(cs_[A-Za-z0-9]+)(?:[/?#]|$)/.exec(url);
  return m ? m[1]! : null;
}

/** A shareable link for a Cascade name: payLink("ada", { amount: "25" }) -> https://cascade.link/ada?amount=25 */
export function payLink(name: string, opts: { amount?: string; memo?: string; base?: string } = {}): string {
  const u = new URL(`/${encodeURIComponent(name)}`, opts.base ?? "https://cascade.link");
  if (opts.amount) u.searchParams.set("amount", opts.amount);
  if (opts.memo) u.searchParams.set("memo", opts.memo);
  return u.toString();
}

export interface OpenOptions {
  sessionUrl: string;
  onPaid?: (sessionId: string) => void;
  onClose?: (sessionId: string) => void;
}

/** Open the checkout in a modal iframe. Returns a function that closes it. */
export function openCheckout(o: OpenOptions): () => void {
  const sessionId = sessionIdFromUrl(o.sessionUrl);
  if (!sessionId) throw new Error("Cascade: not a checkout session URL");
  const origin = new URL(o.sessionUrl).origin;
  const embedUrl = new URL(o.sessionUrl);
  embedUrl.searchParams.set("embed", "1");
  embedUrl.searchParams.set("parent", window.location.origin);

  // Motion: enter 240 ms ease-out, leave 160 ms ease-in, transform and opacity
  // only (compositor). With Reduce Motion: a short fade, nothing moves.
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const enterMs = reduce ? 120 : 240;
  const leaveMs = reduce ? 100 : 160;
  const hidden = reduce ? "none" : "translateY(12px) scale(.98)";

  const overlay = document.createElement("div");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Checkout");
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(10,10,20,.55);display:flex;align-items:center;justify-content:center;z-index:2147483647;" +
    `opacity:0;transition:opacity ${enterMs}ms cubic-bezier(.2,.7,.2,1)`;
  const frame = document.createElement("iframe");
  frame.src = embedUrl.toString();
  frame.title = "Cascade checkout";
  frame.allow = "clipboard-write";
  // dvh: fits phones whose browser bars take part of the screen. Transparent, so no white flash before the page paints.
  frame.style.cssText =
    "width:min(440px,calc(100vw - 32px));height:min(640px,calc(100dvh - 32px));border:0;border-radius:16px;background:transparent;box-shadow:0 20px 60px rgba(0,0,0,.3);" +
    `transform:${hidden};transition:transform ${enterMs}ms cubic-bezier(.2,.7,.2,1)`;
  overlay.appendChild(frame);
  const opener = document.activeElement as HTMLElement | null;

  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    window.removeEventListener("message", onMessage);
    document.removeEventListener("keydown", onKey);
    overlay.style.transition = `opacity ${leaveMs}ms cubic-bezier(.4,0,1,1)`;
    frame.style.transition = `transform ${leaveMs}ms cubic-bezier(.4,0,1,1)`;
    overlay.style.opacity = "0";
    frame.style.transform = hidden;
    setTimeout(() => {
      overlay.remove();
      opener?.focus?.(); // back to the button that opened it
      o.onClose?.(sessionId);
    }, leaveMs);
  };
  const onMessage = (e: MessageEvent) => {
    if (e.origin !== origin || e.source !== frame.contentWindow || !isCheckoutMessage(e.data) || e.data.sessionId !== sessionId) return;
    if (e.data.type === "resize" && e.data.height) frame.style.height = `${Math.min(e.data.height, window.innerHeight - 32)}px`;
    if (e.data.type === "paid") o.onPaid?.(sessionId);
    if (e.data.type === "closed") close();
  };
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  window.addEventListener("message", onMessage);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => {
    overlay.style.opacity = "1";
    frame.style.transform = "none";
    frame.focus(); // keyboard and screen-reader users land in the checkout
  });
  return close;
}

export interface ButtonOptions extends OpenOptions {
  label?: string;
}

/** Render a "Pay with any crypto" button into `target`. */
export function mountPayButton(target: string | HTMLElement, o: ButtonOptions): HTMLButtonElement {
  const el = typeof target === "string" ? document.querySelector<HTMLElement>(target) : target;
  if (!el) throw new Error(`Cascade: ${String(target)} not found`);
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = o.label ?? "Pay with any crypto";
  b.style.cssText = "font:600 15px/1 system-ui,sans-serif;padding:12px 18px;border-radius:10px;border:0;background:#111;color:#fff;cursor:pointer";
  b.addEventListener("click", () => openCheckout(o));
  el.appendChild(b);
  return b;
}
