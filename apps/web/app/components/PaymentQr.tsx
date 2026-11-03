"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

/** A QR code for a wallet payment URI (EIP-681, Solana Pay, BIP-21). Rendered locally, no network call. */
export function PaymentQr({ uri, label }: { uri: string; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(uri, { margin: 1, width: 220, errorCorrectionLevel: "M" }).then((d) => live && setSrc(d), () => live && setSrc(null));
    return () => {
      live = false;
    };
  }, [uri]);
  if (!src) return null;
  return (
    <figure style={{ margin: 0, textAlign: "center" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} width={180} height={180} alt={`QR code: ${label}`} style={{ borderRadius: 8, background: "#fff", padding: 6 }} />
      <figcaption className="small muted">Scan with your phone wallet</figcaption>
    </figure>
  );
}
