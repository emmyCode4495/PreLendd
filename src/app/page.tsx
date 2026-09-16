"use client";

import { useEffect, useState, useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey, Transaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PRESTOCKS, LTV_BPS, LIQ_THRESHOLD_BPS, PROGRAM_ID } from "@/lib/constants";
import { formatUsd, formatPercent, cn, shortenAddress } from "@/lib/utils";
import {
  buildDepositIx,
  buildBorrowIx,
  buildRepayIx,
  buildWithdrawIx,
  ensureAtaIx,
  isProgramDeployed,
} from "@/lib/program";

type PreStockPrice = {
  symbol: string;
  name: string;
  mint: string;
  logo: string;
  tokenPrice: number;
  markPrice: number;
  impliedValuation: number;
};

export default function Home() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();

  const [prices, setPrices] = useState<PreStockPrice[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"deposit" | "borrow" | "repay" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const [txPending, setTxPending] = useState(false);
  const [txStatus, setTxStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch live PreStocks prices
  useEffect(() => {
    async function fetchPrices() {
      try {
        const res = await fetch("/api/prestocks");
        const text = await res.text();
        let data: any;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error("Invalid JSON response");
        }

        if (!res.ok || data?.error || !Array.isArray(data)) {
          setPrices(PRESTOCKS.map((p) => ({ ...p, tokenPrice: 0, markPrice: 0, impliedValuation: 0 })));
          return;
        }

        const mapped = PRESTOCKS.map((p) => {
          const api = data.find((d: any) => d.symbol === p.symbol);
          return {
            ...p,
            tokenPrice: api?.tokenPrice ?? 0,
            markPrice: api?.markPrice ?? 0,
            impliedValuation: api?.impliedValuation ?? 0,
          };
        });
        setPrices(mapped);
      } catch (e) {
        console.error("Failed to fetch PreStocks prices", e);
        setPrices(PRESTOCKS.map((p) => ({ ...p, tokenPrice: 0, markPrice: 0, impliedValuation: 0 })));
      } finally {
        setLoading(false);
      }
    }
    fetchPrices();
    const id = setInterval(fetchPrices, 30_000);
    return () => clearInterval(id);
  }, []);

  const selectedAsset = prices.find((p) => p.symbol === selected);
  const programReady = isProgramDeployed();

  const handleAction = useCallback(async () => {
    setError(null);
    setTxStatus(null);

    if (!publicKey || !selectedAsset || !amount) {
      setError("Connect wallet, select market, and enter amount");
      return;
    }

    if (!programReady) {
      setError(
        "Program not deployed yet. Set a real PROGRAM_ID in src/lib/constants.ts after running `anchor deploy`."
      );
      return;
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setError("Enter a valid amount");
      return;
    }

    // PreStocks use 9 decimals typically; USDC uses 6
    const decimals = activeTab === "borrow" || activeTab === "repay" ? 6 : 9;
    const rawAmount = BigInt(Math.floor(amountNum * 10 ** decimals));

    setTxPending(true);
    try {
      const collateralMint = new PublicKey(selectedAsset.mint);
      const tx = new Transaction();

      if (activeTab === "deposit") {
        const { ix: ataIx } = ensureAtaIx(
          collateralMint,
          publicKey,
          publicKey,
          TOKEN_2022_PROGRAM_ID
        );
        tx.add(ataIx);
        tx.add(
          await buildDepositIx({
            connection,
            owner: publicKey,
            collateralMint,
            amount: rawAmount,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
        );
      } else if (activeTab === "borrow") {
        const { ix: usdcAtaIx } = ensureAtaIx(
          new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
          publicKey,
          publicKey
        );
        tx.add(usdcAtaIx);
        tx.add(
          await buildBorrowIx({
            owner: publicKey,
            collateralMint,
            amount: rawAmount,
          })
        );
      } else if (activeTab === "repay") {
        tx.add(
          await buildRepayIx({
            owner: publicKey,
            collateralMint,
            amount: rawAmount,
          })
        );
      } else if (activeTab === "withdraw") {
        tx.add(
          await buildWithdrawIx({
            owner: publicKey,
            collateralMint,
            amount: rawAmount,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
        );
      }

      const sig = await sendTransaction(tx, connection);
      setTxStatus(`Transaction sent: ${sig.slice(0, 8)}…`);
      setAmount("");
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "Transaction failed");
    } finally {
      setTxPending(false);
    }
  }, [publicKey, selectedAsset, amount, activeTab, connection, sendTransaction, programReady]);

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      {/* Header */}
      <header className="border-b border-[var(--border)] sticky top-0 z-50 bg-[var(--background)]/80 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center font-bold text-black text-sm">
              PL
            </div>
            <div>
              <h1 className="font-semibold tracking-tight">PreStocks Lend</h1>
              <p className="text-xs text-[var(--muted)]">Borrow against pre-IPO stocks</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {connected && publicKey && (
              <span className="hidden sm:inline text-xs text-[var(--muted)]">
                {shortenAddress(publicKey.toBase58())}
              </span>
            )}
            <WalletMultiButton className="!bg-emerald-500 !text-black !rounded-full !h-10 !text-sm !font-medium hover:!bg-emerald-400" />
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Program status banner */}
        {!programReady && (
          <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            Program ID is still a placeholder. Deploy with <code className="text-amber-100">anchor deploy</code> then
            update <code className="text-amber-100">PROGRAM_ID</code> in <code className="text-amber-100">src/lib/constants.ts</code>.
          </div>
        )}

        {/* Hero stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
          {[
            { label: "Total Collateral", value: "—" },
            { label: "Total Borrowed", value: "—" },
            { label: "Max LTV", value: formatPercent(LTV_BPS) },
            { label: "Markets", value: String(PRESTOCKS.length) },
          ].map((s) => (
            <div
              key={s.label}
              className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4"
            >
              <p className="text-xs text-[var(--muted)] mb-1">{s.label}</p>
              <p className="text-xl font-semibold tracking-tight">{s.value}</p>
            </div>
          ))}
        </div>

        <div className="grid lg:grid-cols-5 gap-8">
          {/* Markets list */}
          <div className="lg:col-span-3 space-y-3">
            <h2 className="text-sm font-medium text-[var(--muted)] uppercase tracking-wider mb-4">
              Available Markets
            </h2>

            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="h-20 rounded-2xl bg-[var(--card)] border border-[var(--border)] animate-pulse"
                  />
                ))}
              </div>
            ) : (
              prices.map((asset) => {
                const premium =
                  asset.markPrice > 0
                    ? ((asset.tokenPrice - asset.markPrice) / asset.markPrice) * 100
                    : 0;
                const isSelected = selected === asset.symbol;

                return (
                  <button
                    key={asset.symbol}
                    onClick={() => setSelected(asset.symbol)}
                    className={cn(
                      "w-full text-left rounded-2xl border p-4 transition-all hover:bg-[var(--card-hover)]",
                      isSelected
                        ? "border-emerald-500/50 bg-emerald-500/5"
                        : "border-[var(--border)] bg-[var(--card)]"
                    )}
                  >
                    <div className="flex items-center gap-4">
                      <img
                        src={asset.logo}
                        alt={asset.name}
                        className="w-10 h-10 rounded-full bg-zinc-800 object-cover"
                        onError={(e) => {
                          (e.target as HTMLImageElement).src =
                            "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect fill='%23222' width='40' height='40'/%3E%3C/svg%3E";
                        }}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{asset.name}</span>
                          <span className="text-xs text-[var(--muted)]">{asset.symbol}</span>
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-sm text-[var(--muted)]">
                          <span>{formatUsd(asset.tokenPrice)}</span>
                          <span className={cn(premium >= 0 ? "text-emerald-400" : "text-red-400")}>
                            {premium >= 0 ? "+" : ""}
                            {premium.toFixed(1)}% vs mark
                          </span>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-[var(--muted)]">Max LTV</p>
                        <p className="font-medium">{formatPercent(LTV_BPS)}</p>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {/* Action panel */}
          <div className="lg:col-span-2">
            <div className="sticky top-24 rounded-2xl border border-[var(--border)] bg-[var(--card)] overflow-hidden">
              <div className="flex border-b border-[var(--border)]">
                {(["deposit", "borrow", "repay", "withdraw"] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={cn(
                      "flex-1 py-3 text-sm font-medium capitalize transition-colors",
                      activeTab === tab
                        ? "text-emerald-400 border-b-2 border-emerald-400"
                        : "text-[var(--muted)] hover:text-white"
                    )}
                  >
                    {tab}
                  </button>
                ))}
              </div>

              <div className="p-5 space-y-5">
                {!selected ? (
                  <p className="text-center text-[var(--muted)] py-8 text-sm">
                    Select a market to get started
                  </p>
                ) : (
                  <>
                    <div className="flex items-center gap-3">
                      <img src={selectedAsset?.logo} alt="" className="w-8 h-8 rounded-full" />
                      <div>
                        <p className="font-medium">{selectedAsset?.name}</p>
                        <p className="text-xs text-[var(--muted)]">
                          {formatUsd(selectedAsset?.tokenPrice ?? 0)}
                        </p>
                      </div>
                    </div>

                    <div>
                      <label className="text-xs text-[var(--muted)] mb-1.5 block">Amount</label>
                      <div className="relative">
                        <input
                          type="number"
                          value={amount}
                          onChange={(e) => setAmount(e.target.value)}
                          placeholder="0.00"
                          className="w-full bg-[var(--background)] border border-[var(--border)] rounded-xl px-4 py-3 text-lg font-medium focus:border-emerald-500 transition-colors"
                        />
                        <button
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-emerald-400 font-medium"
                          onClick={() => setAmount("1.0")}
                        >
                          MAX
                        </button>
                      </div>
                    </div>

                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-[var(--muted)]">LTV</span>
                        <span>{formatPercent(LTV_BPS)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[var(--muted)]">Liq. Threshold</span>
                        <span>{formatPercent(LIQ_THRESHOLD_BPS)}</span>
                      </div>
                      {activeTab === "borrow" && amount && selectedAsset && (
                        <div className="flex justify-between">
                          <span className="text-[var(--muted)]">Est. max borrow</span>
                          <span>
                            {formatUsd(
                              (Number(amount) * selectedAsset.tokenPrice * LTV_BPS) / 10000
                            )}
                          </span>
                        </div>
                      )}
                    </div>

                    {error && (
                      <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2 text-sm text-red-300">
                        {error}
                      </div>
                    )}
                    {txStatus && (
                      <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-3 py-2 text-sm text-emerald-300">
                        {txStatus}
                      </div>
                    )}

                    <button
                      onClick={handleAction}
                      disabled={!connected || !amount || txPending}
                      className={cn(
                        "w-full py-3.5 rounded-xl font-semibold transition-all",
                        connected && amount && !txPending
                          ? "bg-emerald-500 hover:bg-emerald-400 text-black"
                          : "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                      )}
                    >
                      {txPending
                        ? "Confirm in wallet…"
                        : !connected
                        ? "Connect Wallet"
                        : !amount
                        ? "Enter amount"
                        : `${activeTab.charAt(0).toUpperCase() + activeTab.slice(1)} ${
                            selectedAsset?.symbol
                          }`}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <p className="mt-12 text-center text-xs text-[var(--muted)]">
          Program: <code className="text-zinc-400">{PROGRAM_ID}</code>
          <br />
          Live prices via prestocks.com · Solana wallet adapter connected
        </p>
      </main>
    </div>
  );
}
