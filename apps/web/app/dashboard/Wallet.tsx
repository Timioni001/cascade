"use client";

import { useEffect, useState } from "react";
import { Wallet as WalletIcon } from "lucide-react";
import { connectWallet, connectedAccount, disconnectWallet } from "../../lib/wallet";

/** The merchant's NEAR wallet, shared by every tab that needs a signature. */
export function useWallet() {
  const [account, setAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void connectedAccount().then((a) => live && setAccount(a));
    return () => {
      live = false;
    };
  }, []);
  return {
    account,
    busy,
    async connect() {
      setBusy(true);
      try {
        setAccount(await connectWallet());
      } finally {
        setBusy(false);
      }
    },
    async disconnect() {
      await disconnectWallet();
      setAccount(null);
    },
  };
}

export type WalletState = ReturnType<typeof useWallet>;

/**
 * Connect / connected strip. `owner` is the account that must sign; a
 * different wallet is shown, with a note, because the contract would refuse it.
 */
export function WalletBar({ wallet, owner, onError, why }: { wallet: WalletState; owner?: string; onError: (m: string | null) => void; why: string }) {
  const wrong = !!(wallet.account && owner && wallet.account !== owner);
  return (
    <div className="well row small wallet-bar">
      <span className="row-start" style={{ gap: 8, minWidth: 0 }}>
        <WalletIcon size={15} />
        {wallet.account ? (
          <span style={{ minWidth: 0 }}>
            Signing as <span className="mono">{wallet.account}</span>
            {wrong && <span className="tiny error"> · this is not {owner}; the contract will refuse it</span>}
          </span>
        ) : (
          <span className="soft">{why}</span>
        )}
      </span>
      {wallet.account ? (
        <button className="btn ghost sm" onClick={() => void wallet.disconnect()}>Disconnect</button>
      ) : (
        <button className="btn sm" disabled={wallet.busy} onClick={() => wallet.connect().catch((e: Error) => onError(e.message))}>
          {wallet.busy ? "Connecting…" : "Connect NEAR wallet"}
        </button>
      )}
    </div>
  );
}
