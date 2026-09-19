/**
 * DEVNET configuration for hackathon testing.
 * Real PreStocks mints only exist on mainnet — we use mock Token-2022 mints on devnet.
 * After "Create mock mint" in Admin, mints are saved to localStorage and override these placeholders.
 */

export type PreStockConfig = {
  symbol: string;
  name: string;
  mint: string; // placeholder until user creates mock mint
  logo: string;
  /** Mock USD price used when API has no match */
  defaultPrice: number;
};

export const PRESTOCKS: PreStockConfig[] = [
  {
    symbol: "ANTHROPIC",
    name: "Anthropic (mock)",
    mint: "", // filled from localStorage after create
    logo: "https://www.prestocks.com/logos/anthropic.png",
    defaultPrice: 120,
  },
  {
    symbol: "OPENAI",
    name: "OpenAI (mock)",
    mint: "",
    logo: "https://www.prestocks.com/logos/openai.png",
    defaultPrice: 250,
  },
  {
    symbol: "SPACEX",
    name: "SpaceX (mock)",
    mint: "",
    logo: "https://www.prestocks.com/logos/spacex.png",
    defaultPrice: 180,
  },
  {
    symbol: "ANDURIL",
    name: "Anduril (mock)",
    mint: "",
    logo: "https://www.prestocks.com/logos/anduril.png",
    defaultPrice: 95,
  },
  {
    symbol: "XAI",
    name: "xAI (mock)",
    mint: "",
    logo: "https://www.prestocks.com/logos/xai.png",
    defaultPrice: 75,
  },
];

/** Circle's official USDC on Solana devnet */
export const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export const PROGRAM_ID = "3b8mDbDh8GqDfPFHHi94vJuw7wMfNQ1houuUDHxiez2k";

export const LTV_BPS = 4500;
export const LIQ_THRESHOLD_BPS = 5500;
export const PRICE_PRECISION = 1_000_000;

export const CLUSTER = "devnet" as const;

const MOCK_MINTS_KEY = "prestocks_lend_mock_mints";

export function loadMockMints(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(MOCK_MINTS_KEY) || "{}");
  } catch {
    return {};
  }
}

export function saveMockMint(symbol: string, mint: string) {
  if (typeof window === "undefined") return;
  const all = loadMockMints();
  all[symbol] = mint;
  localStorage.setItem(MOCK_MINTS_KEY, JSON.stringify(all));
}

export function getPreStocksWithMints(): PreStockConfig[] {
  const mocks = loadMockMints();
  return PRESTOCKS.map((p) => ({
    ...p,
    mint: mocks[p.symbol] || p.mint,
  }));
}
