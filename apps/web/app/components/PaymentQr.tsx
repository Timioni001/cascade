"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

/** A QR code for a wallet payment URI (EIP-681, Solana Pay, BIP-21). Rendered locally, no network call. */
export function PaymentQr({ uri, label, size = 184 }: { uri: string; label: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(uri, { margin: 0, width: size * 2, errorCorrectionLevel: "M", color: { dark: "#151515", light: "#f7f6f1" } }).then((d) => live && setSrc(d), () => live && setSrc(null));
    return () => {
      live = false;
    };
  }, [uri, size]);
  if (!src) return <div style={{ width: size, height: size }} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} width={size} height={size} alt={`QR code: ${label}`} style={{ display: "block" }} />;
}
