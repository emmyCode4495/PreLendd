import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PreStocks Lend | Borrow against pre-IPO stocks",
  description: "Deposit PreStocks as collateral and borrow USDC on Solana",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
