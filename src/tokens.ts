import { formatUnits, parseUnits } from "viem";
import { NGNM } from "./config.js";
import { canPayGasWith, erc20Abi, publicClient } from "./chain.js";

export interface Token {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  /** Human name for the asset, as a Nigerian would say it. */
  label: string;
  /** Whether Celo accepts this token as gas. Verified, not assumed. */
  payGas?: boolean;
}

/**
 * The two naira on Celo. They are different tokens from different issuers and
 * are not interchangeable.
 *
 * NGNm is Mento's, 18 decimals, and on the fee currency allowlist, so it can pay
 * for its own gas. cNGN is the SEC-regulated naira from an independent issuer,
 * six decimals, and not on that list, so moving it still needs a gas token. Kobo
 * pays that gas in NGNm, which means a cNGN holder never needs CELO either.
 */
export const TOKENS: Record<string, Token> = {
  NGNm: {
    symbol: "NGNm",
    address: NGNM,
    decimals: 18,
    label: "Mento naira",
  },
  cNGN: {
    symbol: "cNGN",
    address: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f",
    decimals: 6,
    label: "Regulated naira",
  },
};

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
