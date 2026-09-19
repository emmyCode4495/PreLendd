import {
  Connection,
  Keypair,
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
  createTransferCheckedInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";
import {
  PROGRAM_ID,
  USDC_MINT,
  LTV_BPS,
  LIQ_THRESHOLD_BPS,
  PRICE_PRECISION,
} from "./constants";

export const programId = new PublicKey(PROGRAM_ID);
export const usdcMint = new PublicKey(USDC_MINT);

const DISCRIMINATORS = {
  initialize_market: Buffer.from([35, 35, 189, 193, 155, 48, 170, 203]),
  update_price: Buffer.from([61, 34, 117, 155, 75, 34, 123, 208]),
  deposit: Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]),
  borrow: Buffer.from([228, 253, 131, 202, 207, 116, 89, 18]),
  repay: Buffer.from([234, 103, 67, 82, 208, 234, 219, 166]),
  withdraw: Buffer.from([183, 18, 70, 156, 148, 109, 161, 34]),
  liquidate: Buffer.from([223, 179, 226, 125, 48, 46, 39, 74]),
  set_paused: Buffer.from([91, 60, 125, 192, 176, 225, 166, 218]),
  update_caps: Buffer.from([188, 115, 142, 158, 12, 242, 220, 239]),
};

export function marketPda(collateralMint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), collateralMint.toBuffer()],
    programId
  );
}

export function positionPda(market: PublicKey, owner: PublicKey) {
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

function encodeI64(n: bigint | number) {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(BigInt(n));
  return buf;
}

export function buildInitializeMarketIx(params: {
  authority: PublicKey;
  collateralMint: PublicKey;
  debtMint: PublicKey;
  collateralVault: PublicKey;
  debtVault: PublicKey;
  ltvBps?: number;
  liqThresholdBps?: number;
  depositCap?: bigint;
  borrowCap?: bigint;
  maxPriceAgeSecs?: number;
  tokenProgram?: PublicKey;
}) {
  const [market] = marketPda(params.collateralMint);
  const ltv = params.ltvBps ?? LTV_BPS;
  const liq = params.liqThresholdBps ?? LIQ_THRESHOLD_BPS;
  const depositCap = params.depositCap ?? BigInt("1000000000000000");
  const borrowCap = params.borrowCap ?? BigInt("1000000000000000");
  const maxAge = params.maxPriceAgeSecs ?? 3600;

  const data = Buffer.concat([
    DISCRIMINATORS.initialize_market,
    encodeU64(ltv),
    encodeU64(liq),
    encodeU64(depositCap),
    encodeU64(borrowCap),
    encodeI64(maxAge),
  ]);

  const collateralTokenProgram = params.tokenProgram || TOKEN_2022_PROGRAM_ID;
  const debtTokenProgram = TOKEN_PROGRAM_ID;

  const keys = [
    { pubkey: params.authority, isSigner: true, isWritable: true },
    { pubkey: params.collateralMint, isSigner: false, isWritable: false },
    { pubkey: params.debtMint, isSigner: false, isWritable: false },
    { pubkey: market, isSigner: false, isWritable: true },
    { pubkey: params.collateralVault, isSigner: true, isWritable: true },
    { pubkey: params.debtVault, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: collateralTokenProgram, isSigner: false, isWritable: false },
    { pubkey: debtTokenProgram, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];

  return {
    ix: new TransactionInstruction({ programId, keys, data }),
    market,
  };
}

export function buildUpdatePriceIx(params: {
  authority: PublicKey;
  collateralMint: PublicKey;
  newPrice: bigint;
}) {
  const [market] = marketPda(params.collateralMint);
  const data = Buffer.concat([
    DISCRIMINATORS.update_price,
    encodeU64(params.newPrice),
  ]);
  const keys = [
    { pubkey: params.authority, isSigner: true, isWritable: false },
    { pubkey: market, isSigner: false, isWritable: true },
  ];
  return new TransactionInstruction({ programId, keys, data });
}

export async function buildDepositIx(params: {
  connection: Connection;
  owner: PublicKey;
  collateralMint: PublicKey;
  amount: bigint;
  collateralVault: PublicKey;
  tokenProgram?: PublicKey;
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
  const data = Buffer.concat([DISCRIMINATORS.deposit, encodeU64(params.amount)]);
  const keys = [
    { pubkey: params.owner, isSigner: true, isWritable: true },
    { pubkey: market, isSigner: false, isWritable: true },
    { pubkey: position, isSigner: false, isWritable: true },
    { pubkey: params.collateralMint, isSigner: false, isWritable: false },
    { pubkey: userCollateral, isSigner: false, isWritable: true },
    { pubkey: params.collateralVault, isSigner: false, isWritable: true },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId, keys, data });
}

export function buildBorrowIx(params: {
  owner: PublicKey;
  collateralMint: PublicKey;
  amount: bigint;
  debtVault: PublicKey;
}) {
  const [market] = marketPda(params.collateralMint);
  const [position] = positionPda(market, params.owner);
  const userDebt = getAssociatedTokenAddressSync(usdcMint, params.owner, false, TOKEN_PROGRAM_ID);
  const data = Buffer.concat([DISCRIMINATORS.borrow, encodeU64(params.amount)]);
  const keys = [
    { pubkey: params.owner, isSigner: true, isWritable: true },
    { pubkey: market, isSigner: false, isWritable: true },
    { pubkey: position, isSigner: false, isWritable: true },
    { pubkey: usdcMint, isSigner: false, isWritable: false },
    { pubkey: params.debtVault, isSigner: false, isWritable: true },
    { pubkey: userDebt, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId, keys, data });
}

export function buildRepayIx(params: {
  owner: PublicKey;
  collateralMint: PublicKey;
  amount: bigint;
  debtVault: PublicKey;
}) {
  const [market] = marketPda(params.collateralMint);
  const [position] = positionPda(market, params.owner);
  const userDebt = getAssociatedTokenAddressSync(usdcMint, params.owner, false, TOKEN_PROGRAM_ID);
  const data = Buffer.concat([DISCRIMINATORS.repay, encodeU64(params.amount)]);
  const keys = [
    { pubkey: params.owner, isSigner: true, isWritable: true },
    { pubkey: market, isSigner: false, isWritable: true },
    { pubkey: position, isSigner: false, isWritable: true },
    { pubkey: usdcMint, isSigner: false, isWritable: false },
    { pubkey: userDebt, isSigner: false, isWritable: true },
    { pubkey: params.debtVault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId, keys, data });
}

export function buildWithdrawIx(params: {
  owner: PublicKey;
  collateralMint: PublicKey;
  amount: bigint;
  collateralVault: PublicKey;
  tokenProgram?: PublicKey;
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
  const data = Buffer.concat([DISCRIMINATORS.withdraw, encodeU64(params.amount)]);
  const keys = [
    { pubkey: params.owner, isSigner: true, isWritable: true },
    { pubkey: market, isSigner: false, isWritable: true },
    { pubkey: position, isSigner: false, isWritable: true },
    { pubkey: params.collateralMint, isSigner: false, isWritable: false },
    { pubkey: params.collateralVault, isSigner: false, isWritable: true },
    { pubkey: userCollateral, isSigner: false, isWritable: true },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId, keys, data });
}

export function buildFundVaultIx(params: {
  owner: PublicKey;
  debtVault: PublicKey;
  amount: bigint;
  decimals?: number;
}) {
  const userUsdc = getAssociatedTokenAddressSync(usdcMint, params.owner, false, TOKEN_PROGRAM_ID);
  return createTransferCheckedInstruction(
    userUsdc,
    usdcMint,
    params.debtVault,
    params.owner,
    params.amount,
    params.decimals ?? 6,
    [],
    TOKEN_PROGRAM_ID
  );
}

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
  return true;
}

export function priceToOnChain(usd: number): bigint {
  return BigInt(Math.floor(usd * PRICE_PRECISION));
}

const VAULTS_KEY = "prestocks_lend_vaults";

export type MarketVaults = {
  collateralVault: string;
  debtVault: string;
};

export function saveMarketVaults(symbol: string, vaults: MarketVaults) {
  if (typeof window === "undefined") return;
  const all = JSON.parse(localStorage.getItem(VAULTS_KEY) || "{}");
  all[symbol] = vaults;
  localStorage.setItem(VAULTS_KEY, JSON.stringify(all));
}

export function loadMarketVaults(symbol: string): MarketVaults | null {
  if (typeof window === "undefined") return null;
  const all = JSON.parse(localStorage.getItem(VAULTS_KEY) || "{}");
  return all[symbol] || null;
}

/** Create Token-2022 mock mint + mint 1000 tokens to user */
export async function buildCreateMockMintTx(params: {
  connection: Connection;
  payer: PublicKey;
  decimals?: number;
  amountToMint?: number;
}): Promise<{ tx: Transaction; mintKeypair: Keypair; mint: PublicKey }> {
  const decimals = params.decimals ?? 9;
  const amountHuman = params.amountToMint ?? 1000;
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;
  const tokenProgram = TOKEN_2022_PROGRAM_ID;

  const lamports = await getMinimumBalanceForRentExemptMint(params.connection);
  const ata = getAssociatedTokenAddressSync(mint, params.payer, false, tokenProgram);

  const tx = new Transaction();
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: params.payer,
      newAccountPubkey: mint,
      space: MINT_SIZE,
      lamports,
      programId: tokenProgram,
    })
  );
  tx.add(
    createInitializeMint2Instruction(mint, decimals, params.payer, params.payer, tokenProgram)
  );
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      params.payer,
      ata,
      params.payer,
      mint,
      tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID
    )
  );
  const rawAmount = BigInt(Math.floor(amountHuman * 10 ** decimals));
  tx.add(createMintToInstruction(mint, ata, params.payer, rawAmount, [], tokenProgram));

  return { tx, mintKeypair, mint };
}
