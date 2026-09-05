import { formatUnits } from "viem";
import { NGNM } from "./config.js";
import { erc20Abi, feeCurrencyAllowlist, gasPrice, publicClient } from "./chain.js";

/**
 * Tokens Celo accepts as gas that a person might plausibly be holding, in the
 * order Kobo prefers them.
 *
 * Naira first, because a naira app should charge in naira when it can. Then the
 * dollars a MiniPay user is most likely to already have, so someone sending
 * cNGN is not asked to go and acquire a second token purely to pay a fee.
 */
const CANDIDATES = [
  { symbol: "NGNm", address: NGNM, decimals: 18, label: "naira" },
  { symbol: "USDm", address: "0x765DE816845861e75A25fCA122bb6898B8B1282a", decimals: 18, label: "dollars" },
  { symbol: "USD₮", address: "0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72", decimals: 18, label: "dollars" },
] as const;

export interface FeeChoice {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  label: string;
  /** Estimated fee in this token, as a decimal string. */
  estimated: string;
  /** Ceiling the sender authorises, in this token. */
  maximum: string;
  balance: string;
  enough: boolean;
}

const GAS_LIMIT = 200_000n;
const GAS_USED = 100_000n;

/**
 * Picks what the sender will actually pay the fee in.
 *
 * The fee does not have to be the token being sent, only something on the
 * allowlist. Choosing one the sender already holds is the difference between a
 * transfer they can make now and one that needs them to acquire a second asset
 * first. They still pay it themselves; nothing here is sponsored.
 */
export async function chooseFeeCurrency(sender: `0x${string}`): Promise<{
  chosen: FeeChoice | null;
  considered: FeeChoice[];
}> {
  const allow = await feeCurrencyAllowlist();
  const usable = CANDIDATES.filter((c) => allow.has(c.address.toLowerCase()));

  const considered = await Promise.all(
    usable.map(async (c) => {
      const [balance, { anchor, tip }] = await Promise.all([
        publicClient
          .readContract({ address: c.address, abi: erc20Abi, functionName: "balanceOf", args: [sender] })
          .catch(() => 0n),
        gasPrice(c.address),
      ]);
      const estimated = (anchor + tip) * GAS_USED;
      const maximum = (anchor * 2n + tip) * GAS_LIMIT;
      return {
        symbol: c.symbol,
        address: c.address as `0x${string}`,
        decimals: c.decimals,
        label: c.label,
        estimated: formatUnits(estimated, c.decimals),
        maximum: formatUnits(maximum, c.decimals),
        balance: formatUnits(balance, c.decimals),
        // Compared against the ceiling rather than the estimate, so a busy
        // block cannot turn a quote that said yes into a transfer that fails.
        enough: balance >= maximum,
      };
    }),
  );

  return { chosen: considered.find((c) => c.enough) ?? null, considered };
}
