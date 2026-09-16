# PreStocks Lend v0.1.1

Isolated lending market for PreStocks (Token-2022 pre-IPO tokens) on Solana.

## Implemented Hardening

### 1. Real Price Feed
- `update_price` instruction (authority / keeper)
- Price stored with 6-decimal precision (`PRICE_PRECISION = 1_000_000`)
- Staleness check (`max_price_age_secs`) enforced on borrow / withdraw / liquidate
- Frontend or off-chain bot should call `update_price` with data from `https://prestocks.com/api/prestocks`

### 2. Token-2022 Support
- All token operations use `anchor_spl::token_interface` + `TransferChecked`
- Compatible with Token Extensions (permanent delegate, transfer hooks, etc.)

### 3. Deposit & Borrow Caps
- `deposit_cap` and `borrow_cap` set at market initialization
- Enforced on every deposit and borrow
- Admin can update via `update_caps`

### 4. Index-Based Interest Accrual
- `debt_index` (1e18 precision) instead of simple additive interest
- Utilization-based rate model (base + slope1 / slope2 with kink)
- `shares_to_debt` / `debt_to_shares` helpers for precise accounting

## Key Parameters (defaults)
- LTV: 45%
- Liquidation Threshold: 55%
- Liquidation Bonus: 5%
- Interest: 2% base + utilization slopes

## Instructions
- `initialize_market`
- `update_price`
- `deposit`
- `borrow`
- `repay`
- `withdraw`
- `liquidate`
- `set_paused`
- `update_caps`

## Next Possible Hardening
- Switch price source to Pyth / Switchboard
- Add e-mode / isolation groups
- Add liquidation close factor
- Formal audit
