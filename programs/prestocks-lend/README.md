# prestocks-lend (on-chain program)

Isolated lending program for **PreStocks-style Token-2022 collateral** and **USDC debt** on Solana.

Part of [PreStocks Lend](../../README.md) — Stocklana / PreStocks track.

---

## Overview

Each **market** is isolated to one collateral mint (e.g. a PreStock) and one debt mint (USDC). Users deposit collateral, borrow up to LTV, repay, withdraw, or get liquidated if unhealthy.

| Item | Value |
|------|--------|
| **Framework** | Anchor 0.31 |
| **Devnet Program ID** | `3b8mDbDh8GqDfPFHHi94vJuw7wMfNQ1houuUDHxiez2k` |
| **Collateral** | Token-2022 (`token_interface`) |
| **Debt** | SPL Token (USDC) |

---

## Instructions

| Instruction | Authority | Description |
|-------------|-----------|-------------|
| `initialize_market` | Signer (admin) | Create market + collateral/debt vaults; set LTV, liq threshold, caps, max price age |
| `update_price` | Market authority | Set collateral price (`PRICE_PRECISION` = 1e6) |
| `deposit` | User | Deposit collateral into vault; open/update position |
| `borrow` | User | Borrow USDC against collateral (LTV + fresh price required) |
| `repay` | User | Repay USDC debt; burn debt shares |
| `withdraw` | User | Withdraw collateral if position stays healthy |
| `liquidate` | Anyone | Repay debt of unhealthy position; seize collateral + bonus |
| `set_paused` | Market authority | Pause/unpause market |
| `update_caps` | Market authority | Update deposit/borrow caps |

---

## Accounts

### `Market`
- Authority, collateral mint, debt mint, vault addresses  
- `total_collateral`, `total_debt_shares`, `debt_index`  
- `ltv_bps`, `liquidation_threshold_bps`, `deposit_cap`, `borrow_cap`  
- `collateral_price`, `price_last_updated`, `max_price_age_secs`  
- `is_paused`

### `Position`
- Owner, market, `collateral_amount`, `debt_shares`

PDAs:
- Market: `["market", collateral_mint]`
- Position: `["position", market, owner]`

---

## Risk parameters (defaults)

| Parameter | Value |
|-----------|--------|
| LTV | 45% (`4500` bps) |
| Liquidation threshold | 55% |
| Liquidation bonus | 5% |
| Price precision | 1e6 (e.g. `$120.50` → `120_500_000`) |
| Debt index precision | 1e18 |
| Interest | Base 2% + utilization slopes (kink 80%) |

Hard cap: LTV cannot be initialized above 60%.

---

## Security hardening (implemented)

1. **Price feed** — `update_price` + staleness check on borrow / withdraw / liquidate  
2. **Token-2022** — `token_interface` + `TransferChecked`; separate token programs for collateral vs debt on init  
3. **Caps** — deposit/borrow caps enforced; updatable by admin  
4. **Interest** — index-based `debt_index` with utilization curve  
5. **Pause** — admin can halt the market  
6. **Checked math** — overflow-safe arithmetic  

### Not yet (post-hackathon)
- Pyth / Switchboard oracle  
- Liquidation close factor  
- Formal audit  
- On-chain reading of vault balances for UI (client currently caches vault keys after init)

---

## Build

```bash
# From repo root
anchor build

# Verifiable / Docker builds often output:
# target/verifiable/prestocks_lend.so
cp target/verifiable/prestocks_lend.so target/deploy/
```

**Important:** `declare_id!` in `src/lib.rs` must match the deployed program address or every instruction fails with `DeclaredProgramIdMismatch` (0x1004).

```rust
declare_id!("3b8mDbDh8GqDfPFHHi94vJuw7wMfNQ1houuUDHxiez2k");
```

---

## Deploy / upgrade (devnet)

```bash
solana config set --url devnet
anchor deploy

# Or upgrade existing:
anchor upgrade target/deploy/prestocks_lend.so \
  --program-id 3b8mDbDh8GqDfPFHHi94vJuw7wMfNQ1houuUDHxiez2k \
  --provider.cluster devnet
```

---

## Integration notes

- **Collateral mint:** Token-2022 (PreStocks on mainnet; mock mint on devnet)  
- **Debt mint:** Devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` · Mainnet USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`  
- **Price keeper:** Off-chain bot should poll [PreStocks API](https://prestocks.com/api/prestocks) and call `update_price`  
- **Init vaults:** `collateral_vault` and `debt_vault` are new signers created at `initialize_market`; store addresses for later CPI  

---

## License

MIT (see repo root).
