import { formatUnits, parseUnits } from "viem";
import { NGNM } from "./config.js";
import { canPayGasWith, erc20Abi, publicClient } from "./chain.js";

export interface Token {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  /** Human name for the asset, as a Nigerian would say it. */
  label: string;
  kind: "naira" | "dollar";
  /**
   * What goes in feeCurrency when this token pays its own gas. Six-decimal
   * tokens are allowlisted through an adapter, and their own address is refused.
   */
  feeAddress?: `0x${string}`;
  /** Whether Celo accepts this token as gas. Verified, not assumed. */
  payGas?: boolean;
}

/**
 * The two naira on Celo, and the dollars people send alongside them.
 *
 * NGNm is Mento's, 18 decimals, and on the fee currency allowlist, so it can pay
 * for its own gas. cNGN is the SEC-regulated naira from an independent issuer,
 * six decimals, and not on that list, so its fee comes out of something else the
 * sender holds. Neither needs CELO.
 */
export const TOKENS: Record<string, Token> = {
  NGNm: {
    symbol: "NGNm",
    address: NGNM,
    decimals: 18,
    label: "Mento naira",
    kind: "naira",
  },
  cNGN: {
    symbol: "cNGN",
    address: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f",
    decimals: 6,
    label: "Regulated naira",
    kind: "naira",
  },
  USDT: {
    symbol: "USDT",
    address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
    decimals: 6,
    label: "Tether dollars",
    kind: "dollar",
    feeAddress: "0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72",
  },
  USDC: {
    symbol: "USDC",
    address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
    decimals: 6,
    label: "Circle dollars",
    kind: "dollar",
    feeAddress: "0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B",
  },
  USDm: {
    symbol: "USDm",
    address: "0x765DE816845861e75A25fCA122bb6898B8B1282a",
    decimals: 18,
    label: "Mento dollars",
    kind: "dollar",
  },
};

export const feeAddressOf = (t: Token) => t.feeAddress ?? t.address;

export function tokenBySymbol(symbol: string): Token | null {
  const key = Object.keys(TOKENS).find((k) => k.toLowerCase() === symbol.toLowerCase());
  return key ? TOKENS[key] : null;
}

/**
 * Confirms every token's decimals against its contract.
 *
 * Six decimals against eighteen is a factor of a trillion. A wrong constant here
 * does not throw, it sends the wrong amount, so the figure is checked rather
 * than trusted.
 */
export async function verifyTokens(): Promise<
  { symbol: string; expected: number; actual: number | null; ok: boolean }[]
> {
  return Promise.all(
    Object.values(TOKENS).map(async (t) => {
      const actual = await publicClient
        .readContract({ address: t.address, abi: erc20Abi, functionName: "decimals" })
        .then(Number)
        .catch(() => null);
      return { symbol: t.symbol, expected: t.decimals, actual, ok: actual === t.decimals };
    }),
  );
}

export async function withGasFlags(): Promise<Token[]> {
  return Promise.all(
    Object.values(TOKENS).map(async (t) => ({ ...t, payGas: await canPayGasWith(t.address) })),
  );
}

export async function balanceOfToken(token: Token, owner: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
}

export const toUnits = (token: Token, amount: string) => parseUnits(amount, token.decimals);
export const fromUnits = (token: Token, value: bigint) => formatUnits(value, token.decimals);
