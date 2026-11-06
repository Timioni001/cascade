"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Menu, Moon, Sun } from "lucide-react";

export const SANDBOX = process.env.NEXT_PUBLIC_SANDBOX === "1";
export const NETWORK = process.env.NEXT_PUBLIC_NEAR_NETWORK ?? "sandbox";

/** Three falling bars: the Cascade mark. */
export function Mark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="2" width="3" height="8" rx="1.5" fill="currentColor" />
      <rect x="6.5" y="4" width="3" height="10" rx="1.5" fill="currentColor" />
      <rect x="11.5" y="6" width="3" height="8" rx="1.5" fill="currentColor" />
    </svg>
  );
}

export function Brand() {
  return (
    <Link href="/" className="brand">
      <span className="brand-mark"><Mark /></span>
      Cascade
    </Link>
  );
}

const LINKS: [string, string][] = [
  ["Products", "/#products"],
  ["How it works", "/#how"],
  ["Pricing", "/#pricing"],
  ["Developers", "/developers"],
];

/** Light or dark, remembered in this browser. Follows the system until someone chooses. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  useEffect(() => {
    const saved = (() => {
      try {
        return localStorage.getItem("cascade-theme");
      } catch {
        return null;
      }
    })();
    setTheme(saved === "light" || saved === "dark" ? saved : document.documentElement.dataset.theme === "dark" ? "dark" : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }, []);
  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("cascade-theme", next);
    } catch {
      /* private mode: this tab only */
    }
  };
  return (
    <button className="icon-btn" onClick={flip} aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} title="Light or dark">
      {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}

/** Which network this deployment runs against. Replaces the old full-width banner. */
export function NetworkChip() {
  if (!SANDBOX) return null;
  return (
    <span className="net-chip" title="Contracts, accounts and receipts are real; the cross-chain swap is simulated.">
      <span className="net-dot" />
      {NETWORK === "testnet" ? "Testnet" : "Sandbox"}
    </span>
  );
}

export function Nav({ right }: { right?: ReactNode }) {
  return (
    <header className="nav">
      <div className="container nav-inner">
        <div className="row-start" style={{ gap: 12 }}><Brand /><NetworkChip /></div>
        <nav className="nav-links" aria-label="Main">
          {LINKS.map(([t, h]) => <a key={t} href={h}>{t}</a>)}
        </nav>
        <div className="row-start" style={{ gap: 8 }}>
          <ThemeToggle />
          <Link className="btn ghost sm hide-mobile" href="/dashboard">Sign in</Link>
          {right ?? <Link className="btn sm" href="/start">Start free</Link>}
          <details className="nav-menu">
            <summary className="icon-btn" aria-label="Menu"><Menu size={16} /></summary>
            <div className="nav-menu-sheet">
              {[...LINKS, ["Demo shop", "/shop"], ["Sign in", "/dashboard"]].map(([t, h]) => <a key={t} href={h}>{t}</a>)}
            </div>
          </details>
        </div>
      </div>
    </header>
  );
}

/**
 * Disclosure for pages a payer sees (checkout, receipt, invoice): this
 * deployment is a demo, so the swap is simulated. Pages with their own
 * chrome use `NetworkChip` in the nav instead.
 */
export function DemoBanner() {
  if (!SANDBOX) return null;
  return (
    <p className="demo-note" role="note">
      <span className="net-dot" />
      {NETWORK === "testnet" ? "NEAR testnet demo" : "Local sandbox"}: contracts and receipts are real, the cross-chain swap is simulated.
    </p>
  );
}

export type Tone = "ok" | "warn" | "bad" | "neutral";

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function toneOf(status: string): Tone {
  if (["paid", "delivered", "succeeded", "SUCCESS", "Sent", "Done"].includes(status)) return "ok";
  if (["expired", "failed", "FAILED", "REFUNDED", "Refunded", "bad"].includes(status)) return "bad";
  if (["open", "pending", "PENDING_DEPOSIT", "awaiting_batch", "awaiting_funding"].includes(status)) return "neutral";
  return "warn";
}

/** A coin mark: the symbol on a neutral disc. Monochrome on purpose (no third-party logos, no rainbow). */
export function CoinMark({ symbol, size = 36 }: { symbol: string; chain?: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size, height: size, borderRadius: "50%", display: "inline-grid", placeItems: "center", flex: "none",
        background: "var(--card-2)", color: "var(--ink)", border: "1px solid var(--line)",
        fontSize: Math.round(size * (symbol.length > 3 ? 0.26 : 0.3)), fontWeight: 600, letterSpacing: "-0.02em",
      }}
    >
      {symbol.slice(0, 4)}
    </span>
  );
}

export const CHAIN_NAMES: Record<string, string> = {
  near: "NEAR", eth: "Ethereum", base: "Base", arb: "Arbitrum", op: "Optimism", pol: "Polygon", bsc: "BNB Chain",
  sol: "Solana", btc: "Bitcoin", tron: "Tron", ton: "TON", doge: "Dogecoin", xrp: "XRP", zec: "Zcash", sui: "Sui",
};
export const chainName = (c: string) => CHAIN_NAMES[c] ?? c;

/** Display-only rounding: at most 8 decimals, trailing zeros trimmed. Wallets always get exact amounts. */
export function short(v: string): string {
  const [w, f = ""] = v.split(".");
  const t = f.slice(0, 8).replace(/0+$/, "");
  return t ? `${w}.${t}` : (w ?? v);
}

export const usd = (units: string | number | bigint) => (Number(units) / 1e6).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Placeholder block that reserves the final content's space (no layout shift when data arrives). */
export function Skeleton({ w = "100%", h = 14, r }: { w?: number | string; h?: number; r?: number }) {
  return <span className="skeleton" aria-hidden="true" style={{ display: "block", width: w, height: h, ...(r !== undefined ? { borderRadius: r } : {}) }} />;
}
