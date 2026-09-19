"use client";

import { useEffect, useState, useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import WalletButton from "@/components/WalletButton";
import {
  PRESTOCKS,
  LTV_BPS,
  LIQ_THRESHOLD_BPS,
  PROGRAM_ID,
  USDC_MINT,
  getPreStocksWithMints,
  saveMockMint,
  type PreStockConfig,
} from "@/lib/constants";
import { formatUsd, formatPercent, cn, shortenAddress } from "@/lib/utils";
import {
  buildDepositIx,
  buildBorrowIx,
  buildRepayIx,
  buildWithdrawIx,
  buildInitializeMarketIx,
  buildUpdatePriceIx,
  buildFundVaultIx,
  buildCreateMockMintTx,
  ensureAtaIx,
  marketPda,
  priceToOnChain,
  saveMarketVaults,
  loadMarketVaults,
  type MarketVaults,
} from "@/lib/program";

type DisplayAsset = PreStockConfig & {
  tokenPrice: number;
  markPrice: number;
};

export default function Home() {
  const { connection } = useConnection();
  const { publicKey, signTransaction, connected } = useWallet();

  const [assets, setAssets] = useState<DisplayAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"deposit" | "borrow" | "repay" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const [fundAmount, setFundAmount] = useState("10");
  const [txPending, setTxPending] = useState(false);
  const [txStatus, setTxStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdmin, setShowAdmin] = useState(true);
  const [vaults, setVaults] = useState<MarketVaults | null>(null);
  const [marketExists, setMarketExists] = useState(false);

  const refreshAssets = useCallback(() => {
    const withMints = getPreStocksWithMints();
    setAssets(
      withMints.map((p) => ({
        ...p,
        tokenPrice: p.defaultPrice,
        markPrice: p.defaultPrice * 0.98,
      }))
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    refreshAssets();
  }, [refreshAssets]);

  useEffect(() => {
    if (!selected) {
      setVaults(null);
      setMarketExists(false);
      return;
    }
    const v = loadMarketVaults(selected);
    setVaults(v);
    const asset = getPreStocksWithMints().find((p) => p.symbol === selected);
    if (!asset?.mint) {
      setMarketExists(false);
      return;
    }
    (async () => {
      try {
        const [market] = marketPda(new PublicKey(asset.mint));
        const info = await connection.getAccountInfo(market);
        setMarketExists(!!info);
      } catch {
        setMarketExists(false);
      }
    })();
  }, [selected, connection, assets]);

  const selectedAsset = assets.find((p) => p.symbol === selected);

  const sendTx = useCallback(
    async (tx: Transaction, signers: Keypair[] = []) => {
      if (!publicKey || !signTransaction) throw new Error("Wallet not connected");
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      if (signers.length) tx.partialSign(...signers);
      const signed = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      await connection.confirmTransaction(sig, "confirmed");
      return sig;
    },
    [publicKey, signTransaction, connection]
  );

  // 0. Create mock Token-2022 mint for selected symbol
  const handleCreateMockMint = useCallback(async () => {
    setError(null);
    setTxStatus(null);
    if (!publicKey || !selected) {
      setError("Connect wallet and select a market");
      return;
    }
    setTxPending(true);
    try {
      const { tx, mintKeypair, mint } = await buildCreateMockMintTx({
        connection,
        payer: publicKey,
        amountToMint: 1000,
      });
      const sig = await sendTx(tx, [mintKeypair]);
      saveMockMint(selected, mint.toBase58());
      refreshAssets();
      setTxStatus(`Mock mint created: ${mint.toBase58().slice(0, 8)}… · 1000 tokens minted · ${sig.slice(0, 10)}…`);
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "Create mock mint failed");
    } finally {
      setTxPending(false);
    }
  }, [publicKey, selected, connection, sendTx, refreshAssets]);

  const handleInitMarket = useCallback(async () => {
    setError(null);
    setTxStatus(null);
    if (!publicKey || !selectedAsset?.mint) {
      setError("Create a mock mint first (step 0)");
      return;
    }
    setTxPending(true);
    try {
      const collateralMint = new PublicKey(selectedAsset.mint);
      const debtMint = new PublicKey(USDC_MINT);
      const collateralVault = Keypair.generate();
      const debtVault = Keypair.generate();

      const { ix } = buildInitializeMarketIx({
        authority: publicKey,
        collateralMint,
        debtMint,
        collateralVault: collateralVault.publicKey,
        debtVault: debtVault.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      });

      const sig = await sendTx(new Transaction().add(ix), [collateralVault, debtVault]);
      const v = {
        collateralVault: collateralVault.publicKey.toBase58(),
        debtVault: debtVault.publicKey.toBase58(),
      };
      saveMarketVaults(selectedAsset.symbol, v);
      setVaults(v);
      setMarketExists(true);
      setTxStatus(`Market initialized · ${sig.slice(0, 12)}…`);
    } catch (e: any) {
      console.error(e);
      const msg = e?.message || "Initialize failed";
      setError(
        msg.includes("Simulation") || msg.includes("custom program error")
          ? `${msg} — Did you rebuild+upgrade the program after the dual token_program fix?`
          : msg
      );
    } finally {
      setTxPending(false);
    }
  }, [publicKey, selectedAsset, sendTx]);

  const handleUpdatePrice = useCallback(async () => {
    setError(null);
    setTxStatus(null);
    if (!publicKey || !selectedAsset?.mint) {
      setError("Need mint + wallet");
      return;
    }
    setTxPending(true);
    try {
      const price = selectedAsset.tokenPrice || selectedAsset.defaultPrice;
      const ix = buildUpdatePriceIx({
        authority: publicKey,
        collateralMint: new PublicKey(selectedAsset.mint),
        newPrice: priceToOnChain(price),
      });
      const sig = await sendTx(new Transaction().add(ix));
      setTxStatus(`Price set to ${formatUsd(price)} · ${sig.slice(0, 12)}…`);
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "Update price failed");
    } finally {
      setTxPending(false);
    }
  }, [publicKey, selectedAsset, sendTx]);

  const handleFundVault = useCallback(async () => {
    setError(null);
    setTxStatus(null);
    if (!publicKey || !vaults) {
      setError("Initialize market first");
      return;
    }
    const amt = parseFloat(fundAmount);
    if (isNaN(amt) || amt <= 0) {
      setError("Enter USDC amount");
      return;
    }
    setTxPending(true);
    try {
      const raw = BigInt(Math.floor(amt * 1e6));
      const { ix: ataIx } = ensureAtaIx(new PublicKey(USDC_MINT), publicKey, publicKey);
      const transferIx = buildFundVaultIx({
        owner: publicKey,
        debtVault: new PublicKey(vaults.debtVault),
        amount: raw,
      });
      const sig = await sendTx(new Transaction().add(ataIx, transferIx));
      setTxStatus(`Funded ${amt} USDC · ${sig.slice(0, 12)}…`);
    } catch (e: any) {
      console.error(e);
      setError(
        (e?.message || "Fund failed") +
          " — Need devnet USDC (4zMMC9…). Use a faucet or spl-token transfer."
      );
    } finally {
      setTxPending(false);
    }
  }, [publicKey, vaults, fundAmount, sendTx]);

  const handleAction = useCallback(async () => {
    setError(null);
    setTxStatus(null);
    if (!publicKey || !selectedAsset?.mint || !amount || !vaults) {
      setError("Complete Admin setup first (mint → init → price → fund)");
      return;
    }
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setError("Invalid amount");
      return;
    }
    setTxPending(true);
    try {
      const collateralMint = new PublicKey(selectedAsset.mint);
      const collateralVault = new PublicKey(vaults.collateralVault);
      const debtVault = new PublicKey(vaults.debtVault);
      const tx = new Transaction();

      if (activeTab === "deposit") {
        const raw = BigInt(Math.floor(amountNum * 1e9));
        const { ix: ataIx } = ensureAtaIx(collateralMint, publicKey, publicKey, TOKEN_2022_PROGRAM_ID);
        tx.add(ataIx);
        tx.add(
          await buildDepositIx({
            connection,
            owner: publicKey,
            collateralMint,
            amount: raw,
            collateralVault,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
        );
      } else if (activeTab === "borrow") {
        const raw = BigInt(Math.floor(amountNum * 1e6));
        const { ix: usdcAta } = ensureAtaIx(new PublicKey(USDC_MINT), publicKey, publicKey);
        tx.add(usdcAta);
        tx.add(buildBorrowIx({ owner: publicKey, collateralMint, amount: raw, debtVault }));
      } else if (activeTab === "repay") {
        const raw = BigInt(Math.floor(amountNum * 1e6));
        tx.add(buildRepayIx({ owner: publicKey, collateralMint, amount: raw, debtVault }));
      } else {
        const raw = BigInt(Math.floor(amountNum * 1e9));
        tx.add(
          buildWithdrawIx({
            owner: publicKey,
            collateralMint,
            amount: raw,
            collateralVault,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
        );
      }
      const sig = await sendTx(tx);
      setTxStatus(`Confirmed · ${sig.slice(0, 12)}…`);
      setAmount("");
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "Tx failed");
    } finally {
      setTxPending(false);
    }
  }, [publicKey, selectedAsset, amount, activeTab, vaults, connection, sendTx]);

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <header className="border-b border-[var(--border)] sticky top-0 z-50 bg-[var(--background)]/80 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img
              src="/logo.png"
              alt="preLendd — Borrow Against Your Pre-IPO Upside"
              className="h-10 w-auto object-contain"
            />
            <span className="hidden sm:inline text-[10px] px-2 py-0.5 rounded-full border border-[var(--border)] text-[var(--muted)]">
              Devnet
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAdmin(!showAdmin)}
              className="px-3 py-1.5 rounded-full text-xs border border-[var(--border)] text-[var(--muted)] hover:text-white"
            >
              {showAdmin ? "Hide Admin" : "Admin"}
            </button>
            <WalletButton />
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        <div className="mb-4 rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-200">
          <strong>Devnet mode.</strong> Real PreStocks are mainnet-only. Create a mock Token-2022 mint per
          market, then init → price → fund.
        </div>

        {showAdmin && (
          <div className="mb-8 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5 space-y-4">
            <h2 className="font-semibold text-amber-200">Admin setup (do in order)</h2>
            {!selected && <p className="text-sm text-amber-200/80">Select a market in the list first.</p>}
            {selected && (
              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <button
                  onClick={handleCreateMockMint}
                  disabled={!connected || txPending || !!selectedAsset?.mint}
                  className={cn(
                    "rounded-xl px-4 py-3 text-sm font-medium border text-left",
                    selectedAsset?.mint
                      ? "border-emerald-500/40 text-emerald-400"
                      : "border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-100"
                  )}
                >
                  {selectedAsset?.mint ? "✓ 0. Mock mint ready" : "0. Create mock mint"}
                  <div className="text-[10px] opacity-70 mt-1 font-normal">+1000 tokens to you</div>
                </button>
                <button
                  onClick={handleInitMarket}
                  disabled={!connected || txPending || !selectedAsset?.mint || marketExists}
                  className={cn(
                    "rounded-xl px-4 py-3 text-sm font-medium border",
                    marketExists
                      ? "border-emerald-500/40 text-emerald-400"
                      : "border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-100 disabled:opacity-40"
                  )}
                >
                  {marketExists ? "✓ 1. Market exists" : "1. Initialize market"}
                </button>
                <button
                  onClick={handleUpdatePrice}
                  disabled={!connected || txPending || !marketExists}
                  className="rounded-xl px-4 py-3 text-sm font-medium border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-100 disabled:opacity-40"
                >
                  2. Update price
                  <div className="text-[10px] opacity-70 mt-1 font-normal">
                    {formatUsd(selectedAsset?.tokenPrice ?? 0)}
                  </div>
                </button>
                <div className="flex gap-2">
                  <input
                    type="number"
                    value={fundAmount}
                    onChange={(e) => setFundAmount(e.target.value)}
                    className="w-16 rounded-xl bg-[var(--background)] border border-[var(--border)] px-2 text-sm"
                  />
                  <button
                    onClick={handleFundVault}
                    disabled={!connected || txPending || !vaults}
                    className="flex-1 rounded-xl px-3 py-3 text-sm font-medium border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-100 disabled:opacity-40"
                  >
                    3. Fund USDC
                  </button>
                </div>
              </div>
            )}
            {selectedAsset?.mint && (
              <p className="text-xs text-[var(--muted)] font-mono break-all">Mint: {selectedAsset.mint}</p>
            )}
            {vaults && (
              <div className="text-xs text-[var(--muted)] font-mono space-y-1 break-all">
                <div>Collateral vault: {vaults.collateralVault}</div>
                <div>Debt vault: {vaults.debtVault}</div>
              </div>
            )}
          </div>
        )}

        {(error || txStatus) && (
          <div
            className={cn(
              "mb-6 rounded-xl px-4 py-3 text-sm border",
              error
                ? "border-red-500/30 bg-red-500/10 text-red-300"
                : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
            )}
          >
            {error || txStatus}
          </div>
        )}

        <div className="grid lg:grid-cols-5 gap-8">
          <div className="lg:col-span-3 space-y-3">
            <h2 className="text-sm font-medium text-[var(--muted)] uppercase tracking-wider mb-4">
              Markets (devnet mock)
            </h2>
            {loading ? (
              <div className="h-20 rounded-2xl bg-[var(--card)] animate-pulse" />
            ) : (
              assets.map((asset) => {
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
                          {asset.mint ? (
                            <span className="text-[10px] text-emerald-400">mint ready</span>
                          ) : (
                            <span className="text-[10px] text-amber-400">needs mock mint</span>
                          )}
                        </div>
                        <div className="text-sm text-[var(--muted)] mt-1">
                          {formatUsd(asset.tokenPrice)} · LTV {formatPercent(LTV_BPS)}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>

          <div className="lg:col-span-2">
            <div className="sticky top-24 rounded-2xl border border-[var(--border)] bg-[var(--card)] overflow-hidden">
              <div className="flex border-b border-[var(--border)]">
                {(["deposit", "borrow", "repay", "withdraw"] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={cn(
                      "flex-1 py-3 text-sm font-medium capitalize",
                      activeTab === tab
                        ? "text-emerald-400 border-b-2 border-emerald-400"
                        : "text-[var(--muted)]"
                    )}
                  >
                    {tab}
                  </button>
                ))}
              </div>
              <div className="p-5 space-y-5">
                {!selected ? (
                  <p className="text-center text-[var(--muted)] py-8 text-sm">Select a market</p>
                ) : (
                  <>
                    <div>
                      <label className="text-xs text-[var(--muted)] mb-1.5 block">Amount</label>
                      <input
                        type="number"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        placeholder="0.00"
                        className="w-full bg-[var(--background)] border border-[var(--border)] rounded-xl px-4 py-3 text-lg font-medium"
                      />
                    </div>
                    <div className="text-sm flex justify-between">
                      <span className="text-[var(--muted)]">Status</span>
                      <span className={marketExists ? "text-emerald-400" : "text-amber-400"}>
                        {marketExists ? "Market ready" : "Setup required"}
                      </span>
                    </div>
                    <button
                      onClick={handleAction}
                      disabled={!connected || !amount || txPending || !marketExists}
                      className={cn(
                        "w-full py-3.5 rounded-xl font-semibold",
                        connected && amount && marketExists && !txPending
                          ? "bg-emerald-500 hover:bg-emerald-400 text-black"
                          : "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                      )}
                    >
                      {txPending ? "Confirm in wallet…" : activeTab}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <p className="mt-12 text-center text-xs text-[var(--muted)]">
          Program <code className="text-zinc-400">{PROGRAM_ID}</code>
          <br />
          Devnet USDC <code className="text-zinc-400">{USDC_MINT}</code>
        </p>
      </main>
    </div>
  );
}
