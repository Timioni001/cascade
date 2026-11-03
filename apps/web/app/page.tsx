export default function Home() {
  return (
    <main className="stack">
      <h1>Cascade</h1>
      <p className="muted">Accept any coin on any chain. Receive US dollars (USDC) on NEAR, in your own account or your team's DAO. No fees for your customers to think about.</p>
      <div className="card stack">
        <a href="/shop">Open the demo shop →</a>
        <div className="small muted">Running locally with <code>pnpm dev</code>: a local NEAR sandbox, the Cascade API and settler, and mock NEAR Intents.</div>
      </div>
    </main>
  );
}
