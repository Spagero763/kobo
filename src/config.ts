import "dotenv/config";

export const CHAIN_ID = 42220;

export const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;

/**
 * Savings circle membership registry. Holds no tokens and has no owner: it
 * records who is in a circle and whose turn it is, nothing more. Contributions
 * move directly between members and never touch it.
 */
export const CIRCLES = "0xce0b075d9b2ba71f4c8097e3a43e7d1240505173" as const;

/**
 * Block and timestamp the registry was deployed at. Log queries start here
 * rather than from genesis: Celo produces a block a second, so "earliest" is
 * millions of blocks and public nodes refuse the range outright.
 */
export const CIRCLES_DEPLOYED_AT = { block: 76419038n, timestamp: 1788319796 } as const;

/**
 * Mento Nigerian Naira. 18 decimals, so it is allowlisted directly and can be
 * passed as feeCurrency by its own address. Tokens with other decimals, USDC and
 * USD₮ among them, are allowlisted through an adapter and their own token
 * address will be rejected.
 */
export const NGNM = "0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71" as const;

/**
 * Swaps NGNm against the rest of the Mento set, so a naira balance can pay out
 * in the recipient's own currency.
 */
export const MENTO_BROKER = "0x777A8255cA72412f0d706dc03C9D1987306B4CaD" as const;

/**
 * Delivers a different currency than the one sent, in one transaction. Pulls
 * exactly what the sender approved, swaps, and forwards the whole proceeds. It
 * holds nothing between transactions and has no owner.
 */
export const PAYOUT = "0xdfcf531070a11c94464768547ff239e6bacf4b00" as const;

/**
 * Mento pairs every currency against this one, so naira reaches shillings only
 * by hopping through it. Both legs settle in a single transaction.
 */
export const HUB = "0x765DE816845861e75A25fCA122bb6898B8B1282a" as const;

/**
 * Governance controlled list of what may pay for gas. Read at startup rather
 * than trusted, because membership changes and a wrong feeCurrency surfaces as
 * a confusing failure at send time.
 */
export const FEE_CURRENCY_DIRECTORY = "0x15F344b9E6c3Cb6F0376A36A64928b13F62C6276" as const;

/** Payout currencies reachable from naira through the broker. */
export const MENTO_CURRENCIES = {
  USDm: "0x765DE816845861e75A25fCA122bb6898B8B1282a",
  EURm: "0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73",
  GHSm: "0xfAeA5F3404bbA20D3cc2f8C4B0A888F55a3c7313",
  KESm: "0x456a3D042C0DbD3db53D5489e98dFb038553B0d0",
  ZARm: "0x4c35853A3B4e647fD266f4de678dCc8fEC410BF6",
  XOFm: "0x73F93dcc49cB8A239e2032663e9475dd5ef29A08",
  GBPm: "0xCCF663b1fF11028f0b19058d0f7B674004a40746"
} as const;

/** Accepts a key with or without the 0x prefix, since wallets export both ways. */
function privateKey(): `0x${string}` | "" {
  const raw = (process.env.AGENT_PRIVATE_KEY ?? "").trim();
  if (!raw) return "";
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
}

export const config = {
  /**
   * Only the scripts sign anything. The web app builds transactions for a
   * user's own wallet, so a missing agent address must not take the whole site
   * down: it is checked where it is used, not at import time.
   */
  agentAddress: (process.env.AGENT_ADDRESS ?? "") as `0x${string}`,
  agentPrivateKey: privateKey(),
  attributionTag: process.env.ATTRIBUTION_TAG ?? "",
  celoRpc: process.env.CELO_RPC ?? "https://forno.celo.org",
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  port: Number(process.env.PORT ?? "3000"),
};
