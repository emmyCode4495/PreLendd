"use client";

import { useEffect, useState } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

/**
 * Renders WalletMultiButton only after client mount to avoid SSR hydration mismatch.
 */
export default function WalletButton() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div className="h-10 w-[140px] rounded-full bg-emerald-500/20 animate-pulse" />
    );
  }

  return (
    <WalletMultiButton className="!bg-emerald-500 !text-black !rounded-full !h-10 !text-sm !font-medium hover:!bg-emerald-400" />
  );
}
