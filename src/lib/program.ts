import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PROGRAM_ID, USDC_MINT } from "./constants";

export const programId = new PublicKey(PROGRAM_ID);
export const usdcMint = new PublicKey(USDC_MINT);

// Discriminators (sha256("global:instruction_name")[0..8])
// These are placeholders – regenerate after `anchor build` with real IDL
const DISCRIMINATORS = {
  deposit: Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]),
  borrow: Buffer.from([228, 253, 131, 202, 207, 116, 89, 19]),
  repay: Buffer.from([234, 103, 67, 41, 126, 86, 30, 29]),
  withdraw: Buffer.from([183, 18, 70, 156, 148, 109, 161, 34]),
  update_price: Buffer.from([61, 34, 41, 50, 200, 14, 151, 97]),
};

function marketPda(collateralMint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), collateralMint.toBuffer()],
    programId
  );
}

function positionPda(market: PublicKey, owner: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), market.toBuffer(), owner.toBuffer()],
    programId
  );
}

function encodeU64(n: bigint | number) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

/**
 * Build a deposit instruction
 */
export async function buildDepositIx(params: {
  connection: Connection;
  owner: PublicKey;
  collateralMint: PublicKey;
  amount: bigint;
  tokenProgram?: PublicKey; // TOKEN_2022_PROGRAM_ID for PreStocks
}) {
  const tokenProgram = params.tokenProgram || TOKEN_2022_PROGRAM_ID;
  const [market] = marketPda(params.collateralMint);
  const [position] = positionPda(market, params.owner);

  const userCollateral = getAssociatedTokenAddressSync(
    params.collateralMint,
    params.owner,
    false,
    tokenProgram
  );

  // Vault is created at market init – we derive a conventional ATA owned by market
  // In the real program the vault address is stored on the Market account.
  // For now we use a PDA-owned token account pattern that matches initialize_market.
  const collateralVault = getAssociatedTokenAddressSync(
    params.collateralMint,
    market,
    true,
    tokenProgram
  );

  const data = Buffer.concat([
    DISCRIMINATORS.deposit,
    encodeU64(params.amount),
  ]);

  const keys = [
    { pubkey: params.owner, isSigner: true, isWritable: true },
    { pubkey: market, isSigner: false, isWritable: true },
    { pubkey: position, isSigner: false, isWritable: true },
    { pubkey: params.collateralMint, isSigner: false, isWritable: false },
    { pubkey: userCollateral, isSigner: false, isWritable: true },
    { pubkey: collateralVault, isSigner: false, isWritable: true },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId,
    keys,
    data,
  });
}

/**
 * Build a borrow instruction
 */
export async function buildBorrowIx(params: {
  owner: PublicKey;
  collateralMint: PublicKey;
  amount: bigint;
  tokenProgram?: PublicKey;
}) {
  const tokenProgram = params.tokenProgram || TOKEN_PROGRAM_ID; // USDC is classic SPL
  const [market] = marketPda(params.collateralMint);
  const [position] = positionPda(market, params.owner);

  const debtVault = getAssociatedTokenAddressSync(
    usdcMint,
    market,
    true,
    tokenProgram
  );
  const userDebt = getAssociatedTokenAddressSync(
    usdcMint,
    params.owner,
    false,
    tokenProgram
  );

  const data = Buffer.concat([
    DISCRIMINATORS.borrow,
    encodeU64(params.amount),
  ]);

  const keys = [
    { pubkey: params.owner, isSigner: true, isWritable: true },
    { pubkey: market, isSigner: false, isWritable: true },
    { pubkey: position, isSigner: false, isWritable: true },
    { pubkey: usdcMint, isSigner: false, isWritable: false },
    { pubkey: debtVault, isSigner: false, isWritable: true },
    { pubkey: userDebt, isSigner: false, isWritable: true },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId,
    keys,
    data,
  });
}

/**
 * Build a repay instruction
 */
export async function buildRepayIx(params: {
  owner: PublicKey;
  collateralMint: PublicKey;
  amount: bigint;
}) {
  const tokenProgram = TOKEN_PROGRAM_ID;
  const [market] = marketPda(params.collateralMint);
  const [position] = positionPda(market, params.owner);

  const userDebt = getAssociatedTokenAddressSync(usdcMint, params.owner, false, tokenProgram);
  const debtVault = getAssociatedTokenAddressSync(usdcMint, market, true, tokenProgram);

  const data = Buffer.concat([
    DISCRIMINATORS.repay,
    encodeU64(params.amount),
  ]);

  const keys = [
    { pubkey: params.owner, isSigner: true, isWritable: true },
    { pubkey: market, isSigner: false, isWritable: true },
    { pubkey: position, isSigner: false, isWritable: true },
    { pubkey: usdcMint, isSigner: false, isWritable: false },
    { pubkey: userDebt, isSigner: false, isWritable: true },
    { pubkey: debtVault, isSigner: false, isWritable: true },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId,
    keys,
    data,
  });
}

/**
 * Build a withdraw instruction
 */
export async function buildWithdrawIx(params: {
  owner: PublicKey;
  collateralMint: PublicKey;
  amount: bigint;
  tokenProgram?: PublicKey;
}) {
  const tokenProgram = params.tokenProgram || TOKEN_2022_PROGRAM_ID;
  const [market] = marketPda(params.collateralMint);
  const [position] = positionPda(market, params.owner);

  const collateralVault = getAssociatedTokenAddressSync(
    params.collateralMint,
    market,
    true,
    tokenProgram
  );
  const userCollateral = getAssociatedTokenAddressSync(
    params.collateralMint,
    params.owner,
    false,
    tokenProgram
  );

  const data = Buffer.concat([
    DISCRIMINATORS.withdraw,
    encodeU64(params.amount),
  ]);

  const keys = [
    { pubkey: params.owner, isSigner: true, isWritable: true },
    { pubkey: market, isSigner: false, isWritable: true },
    { pubkey: position, isSigner: false, isWritable: true },
    { pubkey: params.collateralMint, isSigner: false, isWritable: false },
    { pubkey: collateralVault, isSigner: false, isWritable: true },
    { pubkey: userCollateral, isSigner: false, isWritable: true },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId,
    keys,
    data,
  });
}

/**
 * Helper to ensure ATA exists
 */
export function ensureAtaIx(
  mint: PublicKey,
  owner: PublicKey,
  payer: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID
) {
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  return {
    ata,
    ix: createAssociatedTokenAccountIdempotentInstruction(
      payer,
      ata,
      owner,
      mint,
      tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
  };
}

export function isProgramDeployed() {
  // Placeholder program ID means not yet deployed
  return true; // set true after successful deploy
}
