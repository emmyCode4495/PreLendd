# PreStocks Lend

**Borrow USDC against tokenized pre-IPO exposure — without selling your upside.**

Devnet lending market for PreStocks-style Token-2022 collateral on Solana. Built for the [Stocklana](https://hackathons.solana.com/hackathons/stocklana) hackathon (PreStocks track).

---

## Problem

Holders of pre-IPO tokens (Anthropic, OpenAI, SpaceX, etc.) are long conviction assets with **little liquidity**. Selling means giving up upside. Traditional brokers don’t support these on-chain positions. There is no simple way to **borrow stablecoins against pre-IPO exposure** on Solana.

## Solution

**PreStocks Lend** is an isolated lending market where:

1. Users **deposit** PreStock (or mock Token-2022) collateral  
2. Users **borrow USDC** up to a conservative LTV (45%)  
3. Positions are checked against an **oracle price** with staleness guards  
4. Unhealthy positions can be **liquidated** with a bonus for liquidators  

Same product shape as Aave/Kamino-style isolated markets, tuned for illiquid pre-IPO tokens.

---

## Demo

| Item | Link / value |
|------|----------------|
| **Network** | Solana Devnet |
| **Program ID** | `3b8mDbDh8GqDfPFHHi94vJuw7wMfNQ1houuUDHxiez2k` |
| **Devnet USDC** | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| **UI** | `npm run dev` → http://localhost:3000 |
| **Explorer** | [Program on Devnet](https://explorer.solana.com/address/3b8mDbDh8GqDfPFHHi94vJuw7wMfNQ1houuUDHxiez2k?cluster=devnet) |

> **Note:** Real PreStock mints live on **mainnet**. Devnet uses **mock Token-2022 mints** created in the Admin panel so the full flow is testable. Architecture is ready to point at mainnet PreStock mints.

---

## Features

### Protocol
- Isolated market per collateral mint  
- Deposit / borrow / repay / withdraw  
- Permissionless liquidation (5% bonus)  
- Index-based interest accrual  
- Deposit & borrow caps  
- Admin pause + price update  
- Token-2022 collateral + classic SPL USDC debt  
- Price staleness checks before borrow / withdraw / liquidate  

### Risk parameters (defaults)
| Parameter | Value |
|-----------|--------|
| LTV | 45% |
| Liquidation threshold | 55% |
| Liquidation bonus | 5% |
| Interest | Utilization-based (base + slopes) |

### Frontend
- Modern dark UI  
- Wallet adapter (Phantom / Solflare via Wallet Standard)  
- Admin setup: mock mint → initialize market → update price → fund vault  
- User flows: deposit, borrow, repay, withdraw  

---

## Why Solana

- **Fast settlement** for liquidations and health checks on thin pre-IPO liquidity  
- **Token-2022** matches how PreStocks are issued  
- **Composable** vaults and USDC — fits Solana DeFi stack  
- Low fees make smaller pre-IPO positions viable as collateral  

---

## Architecture

```
User wallet
    │
    ├─ Deposit PreStock (Token-2022) ──► Collateral vault (PDA authority)
    │
    └─ Borrow USDC ◄────────────────── Debt vault (seeded by admin/LPs)

On-chain program (Anchor)
    • Market state (LTV, caps, price, debt index)
    • Position state (collateral, debt shares)
    • Instructions: initialize_market, update_price, deposit, borrow, repay, withdraw, liquidate, set_paused, update_caps
```

**Price:** authority/keeper calls `update_price` (devnet: Admin button; production: bot + PreStocks API / Pyth).

---

## Tech stack

| Layer | Stack |
|-------|--------|
| Program | Rust, Anchor 0.31, `anchor-spl` Token Interface |
| Client | TypeScript, `@solana/web3.js`, `@solana/spl-token` |
| Frontend | Next.js 15, React 19, Tailwind, wallet-adapter |
| Network | Solana Devnet (mainnet-ready program design) |

---

## Quick start

### Prerequisites
- Node 18+
- Rust + Anchor 0.31 (`avm use 0.31.1`)
- Solana CLI
- Docker (for `anchor build` on some setups)
- Phantom set to **Devnet**

### Frontend only

```bash
cd prestocks-lend
npm install
npm run dev
```

Open http://localhost:3000

### Full admin test flow (Devnet)

1. Connect Phantom (Devnet) with some SOL  
2. **Admin → 0. Create mock mint** (1000 test tokens)  
3. **1. Initialize market**  
4. **2. Update price**  
5. Get **devnet USDC** from [Circle Faucet](https://faucet.circle.com) (Solana / Devnet)  
6. **3. Fund vault** with USDC  
7. **Deposit** mock PreStock → **Borrow** USDC  

### Build & deploy program

```bash
cd prestocks-lend

# declare_id! must match the program keypair / deployed address
grep declare_id programs/prestocks-lend/src/lib.rs

anchor build
# if using verifiable/docker build:
cp target/verifiable/prestocks_lend.so target/deploy/

solana config set --url devnet
anchor deploy
# or upgrade:
# anchor upgrade target/deploy/prestocks_lend.so --program-id <PROGRAM_ID> --provider.cluster devnet
```

Then set `PROGRAM_ID` in `src/lib/constants.ts` and `declare_id!` / `Anchor.toml` to the deployed id.

---

## Project structure

```
prestocks-lend/
├── programs/prestocks-lend/     # Anchor program
│   └── src/lib.rs
├── src/
│   ├── app/                     # Next.js App Router UI
│   ├── components/              # Wallet providers, buttons
│   └── lib/                     # constants, program client, utils
├── Anchor.toml
└── package.json
```

---

## Mainnet roadmap

1. Deploy program to mainnet  
2. Initialize markets with **real PreStock mints** (no mock step)  
3. Use mainnet USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`  
4. Keeper bot: pull [PreStocks API](https://prestocks.com/api/prestocks) → `update_price`  
5. Optional: Pyth / better oracle, LP deposits, audits  

---

## Security notes (hackathon MVP)

- Over-collateralized only; pause switch available  
- Checked math; isolated markets (no cross-margin contagion)  
- **Not audited** — do not deposit real mainnet funds without an audit  
- Price authority is trusted in MVP; production should use a hardened oracle path  

---

## Tracks

- **Stocklana main track** — credit against tokenized stocks  
- **PreStocks bounty** — product designed for PreStocks collateral + API pricing path  

---

## Team

Built for Stocklana 2026.

---

## License

MIT (or as required by the hackathon).
