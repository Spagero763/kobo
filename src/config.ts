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

/** Self's Identity Verification Hub V2 on Celo mainnet. */
export const SELF_HUB = "0xe57F4773bd9c9d8b6Cd70431117d353298B9f5BF" as const;

/**
 * Seed for the verification scope. The scope itself is derived from this and
 * the deployed contract address, so the frontend must use the same seed or the
 * hub rejects every proof.
 */
export const SELF_SCOPE_SEED = "kobo-personhood";

/** Binds an address to a real person. Empty until deployed. */
export const PERSONHOOD = (process.env.PERSONHOOD ?? "") as `0x${string}` | "";

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

/**
 * Environment values arrive through shells, dashboards and clipboards, and pick
 * things up on the way. A byte order mark on the attribution tag broke every
 * write path in production while every read still worked, because the mark is
 * invisible and the tag looked correct in logs.
 */
function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).replace(/^﻿/, "").trim();
}

/** Accepts a key with or without the 0x prefix, since wallets export both ways. */
function privateKey(): `0x${string}` | "" {
  const raw = env("AGENT_PRIVATE_KEY");
  if (!raw) return "";
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
}

export const config = {
  /**
   * Only the scripts sign anything. The web app builds transactions for a
   * user's own wallet, so a missing agent address must not take the whole site
   * down: it is checked where it is used, not at import time.
   */
  agentAddress: env("AGENT_ADDRESS") as `0x${string}`,
  agentPrivateKey: privateKey(),
  attributionTag: env("ATTRIBUTION_TAG"),
  celoRpc: env("CELO_RPC", "https://forno.celo.org"),
  publicBaseUrl: env("PUBLIC_BASE_URL", "http://localhost:3000").replace(/\/$/, ""),
  port: Number(env("PORT", "3000")),
};

/**
 * A tag that will not encode means nothing this project sends is credited to it,
 * and the failure surfaces only at signing time. Checked once at startup so it
 * shows up in the logs rather than in front of someone sending money.
 */
if (config.attributionTag && !/^[a-z0-9_]{1,32}$/.test(config.attributionTag)) {
  console.warn(
    `[config] ATTRIBUTION_TAG "${config.attributionTag}" is not a valid ERC-8021 code. Transactions will not be attributed.`,
  );
}
