import "./globals.css";
import type { ReactNode } from "react";

export const metadata = { title: "Cascade", description: "Pay with any crypto, receive US dollars on NEAR." };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
