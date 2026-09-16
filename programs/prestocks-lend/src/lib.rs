use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use anchor_spl::associated_token::AssociatedToken;

declare_id!("PreStocksLend1111111111111111111111111111111"); // Replace after deploy

// ============================================================
// CONSTANTS - Conservative defaults
// ============================================================
pub const LTV_BPS: u64 = 4500;                    // 45%
pub const LIQUIDATION_THRESHOLD_BPS: u64 = 5500;  // 55%
pub const LIQUIDATION_BONUS_BPS: u64 = 500;       // 5%
pub const BPS_DENOMINATOR: u64 = 10_000;
pub const SECONDS_PER_YEAR: i64 = 31_536_000;
pub const PRICE_PRECISION: u64 = 1_000_000;       // 6 decimals for price (like USDC)

// Interest rate model
pub const BASE_RATE_BPS: u64 = 200;   // 2%
pub const SLOPE1_BPS: u64 = 800;
pub const SLOPE2_BPS: u64 = 4000;
pub const KINK_BPS: u64 = 8000;       // 80%

// ============================================================
// STATE
// ============================================================

#[account]
pub struct Market {
    pub authority: Pubkey,
    pub collateral_mint: Pubkey,        // PreStock (Token-2022)
    pub debt_mint: Pubkey,              // USDC
    pub collateral_vault: Pubkey,
    pub debt_vault: Pubkey,

    // Accounting
    pub total_collateral: u64,          // raw token amount
    pub total_debt_shares: u64,         // scaled debt
    pub debt_index: u128,               // index for interest (starts at 1e18)
    pub last_update_ts: i64,

    // Risk parameters
    pub ltv_bps: u64,
    pub liquidation_threshold_bps: u64,
    pub deposit_cap: u64,               // max total collateral
    pub borrow_cap: u64,                // max total debt (in debt token units)
    pub is_paused: bool,

    // Price (updated off-chain or via oracle instruction)
    // price is in PRICE_PRECISION (e.g. 1_000_000 = $1.00)
    pub collateral_price: u64,
    pub price_last_updated: i64,
    pub max_price_age_secs: i64,        // e.g. 300 = 5 minutes

    pub bump: u8,
}

impl Market {
    pub const LEN: usize = 8   // discriminator
        + 32 + 32 + 32 + 32 + 32  // keys
        + 8 + 8 + 16 + 8          // accounting
        + 8 + 8 + 8 + 8 + 1       // risk
        + 8 + 8 + 8               // price
        + 1;                      // bump

    pub const DEBT_INDEX_PRECISION: u128 = 1_000_000_000_000_000_000; // 1e18
}

#[account]
pub struct Position {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub collateral_amount: u64,
    pub debt_shares: u64,
    pub bump: u8,
}

impl Position {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 1;
}

// ============================================================
// EVENTS
// ============================================================

#[event]
pub struct DepositEvent {
    pub user: Pubkey,
    pub market: Pubkey,
    pub amount: u64,
    pub new_collateral: u64,
}

#[event]
pub struct BorrowEvent {
    pub user: Pubkey,
    pub market: Pubkey,
    pub amount: u64,
    pub new_debt_shares: u64,
}

#[event]
pub struct RepayEvent {
    pub user: Pubkey,
    pub market: Pubkey,
    pub amount: u64,
}

#[event]
pub struct WithdrawEvent {
    pub user: Pubkey,
    pub market: Pubkey,
    pub amount: u64,
}

#[event]
pub struct LiquidationEvent {
    pub liquidator: Pubkey,
    pub user: Pubkey,
    pub market: Pubkey,
    pub collateral_seized: u64,
    pub debt_repaid: u64,
}

#[event]
pub struct PriceUpdatedEvent {
    pub market: Pubkey,
    pub new_price: u64,
    pub timestamp: i64,
}

// ============================================================
// ERRORS
// ============================================================

#[error_code]
pub enum LendError {
    #[msg("Market is paused")]
    MarketPaused,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Insufficient collateral for this borrow")]
    InsufficientCollateral,
    #[msg("Position is healthy, cannot liquidate")]
    PositionHealthy,
    #[msg("Insufficient liquidity in debt vault")]
    InsufficientLiquidity,
    #[msg("Zero amount not allowed")]
    ZeroAmount,
    #[msg("Invalid parameters")]
    InvalidParams,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Deposit cap exceeded")]
    DepositCapExceeded,
    #[msg("Borrow cap exceeded")]
    BorrowCapExceeded,
    #[msg("Price is stale")]
    StalePrice,
    #[msg("Price not set")]
    PriceNotSet,
}

// ============================================================
// PROGRAM
// ============================================================

#[program]
pub mod prestocks_lend {
    use super::*;

    /// Initialize isolated market
    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        ltv_bps: u64,
        liquidation_threshold_bps: u64,
        deposit_cap: u64,
        borrow_cap: u64,
        max_price_age_secs: i64,
    ) -> Result<()> {
        require!(ltv_bps < liquidation_threshold_bps, LendError::InvalidParams);
        require!(ltv_bps <= 6000, LendError::InvalidParams);
        require!(max_price_age_secs > 0, LendError::InvalidParams);

        let market = &mut ctx.accounts.market;
        market.authority = ctx.accounts.authority.key();
        market.collateral_mint = ctx.accounts.collateral_mint.key();
        market.debt_mint = ctx.accounts.debt_mint.key();
        market.collateral_vault = ctx.accounts.collateral_vault.key();
        market.debt_vault = ctx.accounts.debt_vault.key();

        market.total_collateral = 0;
        market.total_debt_shares = 0;
        market.debt_index = Market::DEBT_INDEX_PRECISION; // 1.0
        market.last_update_ts = Clock::get()?.unix_timestamp;

        market.ltv_bps = ltv_bps;
        market.liquidation_threshold_bps = liquidation_threshold_bps;
        market.deposit_cap = deposit_cap;
        market.borrow_cap = borrow_cap;
        market.is_paused = false;

        market.collateral_price = 0; // must be set before borrowing
        market.price_last_updated = 0;
        market.max_price_age_secs = max_price_age_secs;

        market.bump = ctx.bumps.market;

        msg!("Market initialized");
        Ok(())
    }

    /// Update collateral price (called by authority or oracle keeper)
    /// price is in PRICE_PRECISION (6 decimals). Example: $123.45 → 123_450_000
    pub fn update_price(ctx: Context<UpdatePrice>, new_price: u64) -> Result<()> {
        require!(new_price > 0, LendError::InvalidParams);

        let market = &mut ctx.accounts.market;
        let now = Clock::get()?.unix_timestamp;

        market.collateral_price = new_price;
        market.price_last_updated = now;

        emit!(PriceUpdatedEvent {
            market: market.key(),
            new_price,
            timestamp: now,
        });

        Ok(())
    }

    /// Deposit PreStocks as collateral (Token-2022 compatible)
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, LendError::ZeroAmount);
        let market = &mut ctx.accounts.market;
        require!(!market.is_paused, LendError::MarketPaused);

        // Cap check
        let new_total = market.total_collateral
            .checked_add(amount)
            .ok_or(LendError::MathOverflow)?;
        require!(new_total <= market.deposit_cap, LendError::DepositCapExceeded);

        // Transfer using Token Interface (supports Token-2022)
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.user_collateral.to_account_info(),
            mint: ctx.accounts.collateral_mint.to_account_info(),
            to: ctx.accounts.collateral_vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
        );
        token_interface::transfer_checked(
            cpi_ctx,
            amount,
            ctx.accounts.collateral_mint.decimals,
        )?;

        let position = &mut ctx.accounts.position;
        if position.owner == Pubkey::default() {
            position.owner = ctx.accounts.user.key();
            position.market = market.key();
            position.bump = ctx.bumps.position;
        }

        position.collateral_amount = position.collateral_amount
            .checked_add(amount)
            .ok_or(LendError::MathOverflow)?;
        market.total_collateral = new_total;

        emit!(DepositEvent {
            user: ctx.accounts.user.key(),
            market: market.key(),
            amount,
            new_collateral: position.collateral_amount,
        });

        Ok(())
    }

    /// Borrow USDC
    pub fn borrow(ctx: Context<Borrow>, amount: u64) -> Result<()> {
        require!(amount > 0, LendError::ZeroAmount);
        let market = &mut ctx.accounts.market;
        require!(!market.is_paused, LendError::MarketPaused);

        // Accrue interest (index-based)
        accrue_interest(market)?;

        // Price freshness check
        let now = Clock::get()?.unix_timestamp;
        require!(market.collateral_price > 0, LendError::PriceNotSet);
        require!(
            now - market.price_last_updated <= market.max_price_age_secs,
            LendError::StalePrice
        );

        // Liquidity check
        require!(
            ctx.accounts.debt_vault.amount >= amount,
            LendError::InsufficientLiquidity
        );

        // Cap check
        let current_total_debt = shares_to_debt(market.total_debt_shares, market)?;
        let new_total_debt = current_total_debt
            .checked_add(amount)
            .ok_or(LendError::MathOverflow)?;
        require!(new_total_debt <= market.borrow_cap, LendError::BorrowCapExceeded);

        let position = &mut ctx.accounts.position;

        // Collateral value in debt token units (USDC)
        // value = amount * price / PRICE_PRECISION
        let collateral_value = position.collateral_amount
            .checked_mul(market.collateral_price)
            .ok_or(LendError::MathOverflow)?
            .checked_div(PRICE_PRECISION)
            .ok_or(LendError::MathOverflow)?;

        let max_borrow = collateral_value
            .checked_mul(market.ltv_bps)
            .ok_or(LendError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(LendError::MathOverflow)?;

        let current_debt = shares_to_debt(position.debt_shares, market)?;
        let new_debt = current_debt
            .checked_add(amount)
            .ok_or(LendError::MathOverflow)?;
        require!(new_debt <= max_borrow, LendError::InsufficientCollateral);

        // Calculate new debt shares using current index
        let shares = debt_to_shares(amount, market)?;

        position.debt_shares = position.debt_shares
            .checked_add(shares)
            .ok_or(LendError::MathOverflow)?;
        market.total_debt_shares = market.total_debt_shares
            .checked_add(shares)
            .ok_or(LendError::MathOverflow)?;

        // Transfer USDC to user (Token Interface)
        let seeds = &[
            b"market",
            market.collateral_mint.as_ref(),
            &[market.bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.debt_vault.to_account_info(),
            mint: ctx.accounts.debt_mint.to_account_info(),
            to: ctx.accounts.user_debt.to_account_info(),
            authority: market.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token_interface::transfer_checked(
            cpi_ctx,
            amount,
            ctx.accounts.debt_mint.decimals,
        )?;

        emit!(BorrowEvent {
            user: ctx.accounts.user.key(),
            market: market.key(),
            amount,
            new_debt_shares: position.debt_shares,
        });

        Ok(())
    }

    /// Repay debt
    pub fn repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
        require!(amount > 0, LendError::ZeroAmount);
        let market = &mut ctx.accounts.market;
        require!(!market.is_paused, LendError::MarketPaused);

        accrue_interest(market)?;

        let position = &mut ctx.accounts.position;
        let current_debt = shares_to_debt(position.debt_shares, market)?;
        let repay_amount = amount.min(current_debt);

        // Transfer USDC from user
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.user_debt.to_account_info(),
            mint: ctx.accounts.debt_mint.to_account_info(),
            to: ctx.accounts.debt_vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
        );
        token_interface::transfer_checked(
            cpi_ctx,
            repay_amount,
            ctx.accounts.debt_mint.decimals,
        )?;

        let shares_to_burn = debt_to_shares(repay_amount, market)?;

        position.debt_shares = position.debt_shares
            .checked_sub(shares_to_burn)
            .ok_or(LendError::MathOverflow)?;
        market.total_debt_shares = market.total_debt_shares
            .checked_sub(shares_to_burn)
            .ok_or(LendError::MathOverflow)?;

        emit!(RepayEvent {
            user: ctx.accounts.user.key(),
            market: market.key(),
            amount: repay_amount,
        });

        Ok(())
    }

    /// Withdraw collateral
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, LendError::ZeroAmount);
        let market = &mut ctx.accounts.market;
        require!(!market.is_paused, LendError::MarketPaused);

        accrue_interest(market)?;

        // Price check
        let now = Clock::get()?.unix_timestamp;
        require!(market.collateral_price > 0, LendError::PriceNotSet);
        require!(
            now - market.price_last_updated <= market.max_price_age_secs,
            LendError::StalePrice
        );

        let position = &mut ctx.accounts.position;
        require!(position.collateral_amount >= amount, LendError::InsufficientCollateral);

        let remaining_collateral = position.collateral_amount
            .checked_sub(amount)
            .ok_or(LendError::MathOverflow)?;

        let current_debt = shares_to_debt(position.debt_shares, market)?;

        if current_debt > 0 {
            let remaining_value = remaining_collateral
                .checked_mul(market.collateral_price)
                .ok_or(LendError::MathOverflow)?
                .checked_div(PRICE_PRECISION)
                .ok_or(LendError::MathOverflow)?;

            let max_borrow = remaining_value
                .checked_mul(market.ltv_bps)
                .ok_or(LendError::MathOverflow)?
                .checked_div(BPS_DENOMINATOR)
                .ok_or(LendError::MathOverflow)?;

            require!(current_debt <= max_borrow, LendError::InsufficientCollateral);
        }

        // Transfer collateral back (Token-2022)
        let seeds = &[
            b"market",
            market.collateral_mint.as_ref(),
            &[market.bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.collateral_vault.to_account_info(),
            mint: ctx.accounts.collateral_mint.to_account_info(),
            to: ctx.accounts.user_collateral.to_account_info(),
            authority: market.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token_interface::transfer_checked(
            cpi_ctx,
            amount,
            ctx.accounts.collateral_mint.decimals,
        )?;

        position.collateral_amount = remaining_collateral;
        market.total_collateral = market.total_collateral
            .checked_sub(amount)
            .ok_or(LendError::MathOverflow)?;

        emit!(WithdrawEvent {
            user: ctx.accounts.user.key(),
            market: market.key(),
            amount,
        });

        Ok(())
    }

    /// Liquidate unhealthy position
    pub fn liquidate(ctx: Context<Liquidate>, debt_to_cover: u64) -> Result<()> {
        require!(debt_to_cover > 0, LendError::ZeroAmount);
        let market = &mut ctx.accounts.market;
        require!(!market.is_paused, LendError::MarketPaused);

        accrue_interest(market)?;

        // Price check
        let now = Clock::get()?.unix_timestamp;
        require!(market.collateral_price > 0, LendError::PriceNotSet);
        require!(
            now - market.price_last_updated <= market.max_price_age_secs,
            LendError::StalePrice
        );

        let position = &mut ctx.accounts.position;
        let current_debt = shares_to_debt(position.debt_shares, market)?;

        let collateral_value = position.collateral_amount
            .checked_mul(market.collateral_price)
            .ok_or(LendError::MathOverflow)?
            .checked_div(PRICE_PRECISION)
            .ok_or(LendError::MathOverflow)?;

        let liq_threshold_value = collateral_value
            .checked_mul(market.liquidation_threshold_bps)
            .ok_or(LendError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(LendError::MathOverflow)?;

        require!(current_debt > liq_threshold_value, LendError::PositionHealthy);

        let repay_amount = debt_to_cover.min(current_debt);

        // Collateral to seize (including bonus)
        // seize = repay_amount * (1 + bonus) * PRICE_PRECISION / price
        let collateral_to_seize = repay_amount
            .checked_mul(BPS_DENOMINATOR + LIQUIDATION_BONUS_BPS)
            .ok_or(LendError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(LendError::MathOverflow)?
            .checked_mul(PRICE_PRECISION)
            .ok_or(LendError::MathOverflow)?
            .checked_div(market.collateral_price)
            .ok_or(LendError::MathOverflow)?;

        let collateral_to_seize = collateral_to_seize.min(position.collateral_amount);

        // Liquidator pays debt
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.liquidator_debt.to_account_info(),
            mint: ctx.accounts.debt_mint.to_account_info(),
            to: ctx.accounts.debt_vault.to_account_info(),
            authority: ctx.accounts.liquidator.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
        );
        token_interface::transfer_checked(
            cpi_ctx,
            repay_amount,
            ctx.accounts.debt_mint.decimals,
        )?;

        // Send collateral to liquidator
        let seeds = &[
            b"market",
            market.collateral_mint.as_ref(),
            &[market.bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.collateral_vault.to_account_info(),
            mint: ctx.accounts.collateral_mint.to_account_info(),
            to: ctx.accounts.liquidator_collateral.to_account_info(),
            authority: market.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token_interface::transfer_checked(
            cpi_ctx,
            collateral_to_seize,
            ctx.accounts.collateral_mint.decimals,
        )?;

        let shares_to_burn = debt_to_shares(repay_amount, market)?;

        position.debt_shares = position.debt_shares.saturating_sub(shares_to_burn);
        position.collateral_amount = position.collateral_amount.saturating_sub(collateral_to_seize);
        market.total_debt_shares = market.total_debt_shares.saturating_sub(shares_to_burn);
        market.total_collateral = market.total_collateral.saturating_sub(collateral_to_seize);

        emit!(LiquidationEvent {
            liquidator: ctx.accounts.liquidator.key(),
            user: position.owner,
            market: market.key(),
            collateral_seized: collateral_to_seize,
            debt_repaid: repay_amount,
        });

        Ok(())
    }

    /// Admin pause
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.market.is_paused = paused;
        Ok(())
    }

    /// Admin update caps
    pub fn update_caps(
        ctx: Context<AdminOnly>,
        deposit_cap: u64,
        borrow_cap: u64,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        market.deposit_cap = deposit_cap;
        market.borrow_cap = borrow_cap;
        Ok(())
    }
}

// ============================================================
// HELPERS - Index based interest
// ============================================================

fn accrue_interest(market: &mut Market) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    if now <= market.last_update_ts {
        return Ok(());
    }

    let total_debt = shares_to_debt(market.total_debt_shares, market)?;
    if total_debt == 0 {
        market.last_update_ts = now;
        return Ok(());
    }

    let elapsed = (now - market.last_update_ts) as u64;

    // Utilization = total_debt / (total_collateral * price / PRICE_PRECISION)
    // Simplified: we use raw collateral for utilization approximation
    // In production a better utilization calculation can be used
    let utilization = if market.total_collateral == 0 {
        0
    } else {
        total_debt
            .checked_mul(BPS_DENOMINATOR)
            .ok_or(LendError::MathOverflow)?
            .checked_div(market.total_collateral.max(1))
            .ok_or(LendError::MathOverflow)?
    };

    let rate_bps = if utilization <= KINK_BPS {
        BASE_RATE_BPS
            .checked_add(
                utilization
                    .checked_mul(SLOPE1_BPS)
                    .ok_or(LendError::MathOverflow)?
                    .checked_div(KINK_BPS.max(1))
                    .ok_or(LendError::MathOverflow)?,
            )
            .ok_or(LendError::MathOverflow)?
    } else {
        let excess = utilization.saturating_sub(KINK_BPS);
        BASE_RATE_BPS
            .checked_add(SLOPE1_BPS)
            .ok_or(LendError::MathOverflow)?
            .checked_add(
                excess
                    .checked_mul(SLOPE2_BPS)
                    .ok_or(LendError::MathOverflow)?
                    .checked_div((BPS_DENOMINATOR - KINK_BPS).max(1))
                    .ok_or(LendError::MathOverflow)?,
            )
            .ok_or(LendError::MathOverflow)?
    };

    // interest factor = 1 + rate * time / year
    // We update the debt_index
    let interest_factor = (rate_bps as u128)
        .checked_mul(elapsed as u128)
        .ok_or(LendError::MathOverflow)?
        .checked_mul(Market::DEBT_INDEX_PRECISION)
        .ok_or(LendError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(LendError::MathOverflow)?
        .checked_div(SECONDS_PER_YEAR as u128)
        .ok_or(LendError::MathOverflow)?;

    market.debt_index = market.debt_index
        .checked_add(interest_factor)
        .ok_or(LendError::MathOverflow)?;

    market.last_update_ts = now;
    Ok(())
}

fn shares_to_debt(shares: u64, market: &Market) -> Result<u64> {
    if market.debt_index == 0 {
        return Ok(0);
    }
    Ok(((shares as u128)
        .checked_mul(market.debt_index)
        .ok_or(LendError::MathOverflow)?
        .checked_div(Market::DEBT_INDEX_PRECISION)
        .ok_or(LendError::MathOverflow)?) as u64)
}

fn debt_to_shares(debt: u64, market: &Market) -> Result<u64> {
    if market.debt_index == 0 {
        return Ok(debt);
    }
    Ok(((debt as u128)
        .checked_mul(Market::DEBT_INDEX_PRECISION)
        .ok_or(LendError::MathOverflow)?
        .checked_div(market.debt_index)
        .ok_or(LendError::MathOverflow)?) as u64)
}

// ============================================================
// CONTEXTS
// ============================================================

#[derive(Accounts)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub collateral_mint: InterfaceAccount<'info, Mint>,
    pub debt_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = Market::LEN,
        seeds = [b"market", collateral_mint.key().as_ref()],
        bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        init,
        payer = authority,
        token::mint = collateral_mint,
        token::authority = market,
        token::token_program = token_program,
    )]
    pub collateral_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        token::mint = debt_mint,
        token::authority = market,
        token::token_program = token_program,
    )]
    pub debt_vault: InterfaceAccount<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct UpdatePrice<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"market", market.collateral_mint.as_ref()],
        bump = market.bump,
        has_one = authority @ LendError::Unauthorized
    )]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"market", market.collateral_mint.as_ref()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        init_if_needed,
        payer = user,
        space = Position::LEN,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,

    pub collateral_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        token::mint = collateral_mint,
        token::authority = user,
        token::token_program = token_program,
    )]
    pub user_collateral: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        address = market.collateral_vault
    )]
    pub collateral_vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Borrow<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"market", market.collateral_mint.as_ref()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == user.key() @ LendError::Unauthorized
    )]
    pub position: Account<'info, Position>,

    pub debt_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        address = market.debt_vault
    )]
    pub debt_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = debt_mint,
        token::authority = user,
        token::token_program = token_program,
    )]
    pub user_debt: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Repay<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"market", market.collateral_mint.as_ref()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == user.key() @ LendError::Unauthorized
    )]
    pub position: Account<'info, Position>,

    pub debt_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        token::mint = debt_mint,
        token::authority = user,
        token::token_program = token_program,
    )]
    pub user_debt: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        address = market.debt_vault
    )]
    pub debt_vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"market", market.collateral_mint.as_ref()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == user.key() @ LendError::Unauthorized
    )]
    pub position: Account<'info, Position>,

    pub collateral_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        address = market.collateral_vault
    )]
    pub collateral_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = collateral_mint,
        token::authority = user,
        token::token_program = token_program,
    )]
    pub user_collateral: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Liquidate<'info> {
    #[account(mut)]
    pub liquidator: Signer<'info>,

    #[account(
        mut,
        seeds = [b"market", market.collateral_mint.as_ref()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [b"position", market.key().as_ref(), position.owner.as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, Position>,

    pub debt_mint: InterfaceAccount<'info, Mint>,
    pub collateral_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        token::mint = debt_mint,
        token::authority = liquidator,
        token::token_program = token_program,
    )]
    pub liquidator_debt: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        address = market.debt_vault
    )]
    pub debt_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        address = market.collateral_vault
    )]
    pub collateral_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = collateral_mint,
        token::authority = liquidator,
        token::token_program = token_program,
    )]
    pub liquidator_collateral: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"market", market.collateral_mint.as_ref()],
        bump = market.bump,
        has_one = authority @ LendError::Unauthorized
    )]
    pub market: Account<'info, Market>,
}
