import type { ReactNode } from "react";
import Link from "next/link";

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

export function Nav({ right }: { right?: ReactNode }) {
  return (
    <header className="nav">
      <div className="container nav-inner">
        <Brand />
        <nav className="nav-links" aria-label="Main">
          <a href="/#how">How it works</a>
          <a href="/#developers">Developers</a>
          <a href="/shop">Demo shop</a>
          <a href="/dashboard">Dashboard</a>
        </nav>
        {right ?? <Link className="btn sm" href="/dashboard">Open dashboard</Link>}
      </div>
    </header>
  );
}

/** Shown on every page when the deployment is a testnet/sandbox demo. */
export function DemoBanner() {
  if (!SANDBOX) return null;
  return (
    <div className="banner" role="note">
      {NETWORK === "testnet" ? "Live on NEAR testnet." : "Local sandbox."} Contracts and receipts are real; the cross-chain swap is simulated.
    </div>
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

const CHAIN_COLORS: Record<string, string> = {
  near: "#00ec97", eth: "#8c9eff", base: "#2f6bff", arb: "#28a0f0", op: "#ff0420", pol: "#8247e5", bsc: "#f0b90b",
  sol: "#14f195", btc: "#f7931a", tron: "#ff3b30", ton: "#0098ea", doge: "#c2a633", xrp: "#9aa4b2", sui: "#4da2ff", zec: "#f4b728",
};

/** A coin mark: symbol initials on a chain-tinted disc (no third-party logos). */
export function CoinMark({ symbol, chain, size = 36 }: { symbol: string; chain: string; size?: number }) {
  const color = CHAIN_COLORS[chain] ?? "#9aa4b2";
  return (
    <span
      aria-hidden="true"
      style={{
        width: size, height: size, borderRadius: "50%", display: "inline-grid", placeItems: "center", flex: "none",
        background: `color-mix(in srgb, ${color} 18%, transparent)`, color, fontSize: size * 0.32, fontWeight: 700, letterSpacing: "-0.02em",
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 35%, transparent)`,
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
