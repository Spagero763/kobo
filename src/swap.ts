import { encodeFunctionData, formatUnits, parseUnits } from "viem";
import { MENTO_BROKER, NGNM } from "./config.js";
import { account, erc20Abi, feeParams, publicClient, tag, walletClient } from "./chain.js";

const brokerAbi = [
  { type: "function", name: "getExchangeProviders", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  {
    type: "function",
    name: "getAmountOut",
    stateMutability: "view",
    inputs: [
      { name: "exchangeProvider", type: "address" },
      { name: "exchangeId", type: "bytes32" },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "swapIn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "exchangeProvider", type: "address" },
      { name: "exchangeId", type: "bytes32" },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

const providerAbi = [
  {
    type: "function",
    name: "getExchanges",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "exchangeId", type: "bytes32" },
          { name: "assets", type: "address[]" },
        ],
      },
    ],
  },
] as const;

export interface Pool {
  provider: `0x${string}`;
  exchangeId: `0x${string}`;
  assets: readonly `0x${string}`[];
}

let pools: Pool[] | null = null;

/** Mento's pools, discovered rather than hardcoded, since the set changes. */
export async function allPools(): Promise<Pool[]> {
  if (pools) return pools;
  const providers = await publicClient.readContract({
    address: MENTO_BROKER,
    abi: brokerAbi,
    functionName: "getExchangeProviders",
  });
  const found: Pool[] = [];
  for (const provider of providers) {
    const exchanges = await publicClient
      .readContract({ address: provider, abi: providerAbi, functionName: "getExchanges" })
      .catch(() => []);
    for (const ex of exchanges) {
      found.push({ provider, exchangeId: ex.exchangeId, assets: ex.assets });
    }
  }
  pools = found;
  return found;
}

export async function findPool(a: `0x${string}`, b: `0x${string}`): Promise<Pool | null> {
  const has = (p: Pool, t: string) => p.assets.some((x) => x.toLowerCase() === t.toLowerCase());
  return (await allPools()).find((p) => has(p, a) && has(p, b)) ?? null;
}

/** Onchain price for a pair. Returns null when no direct pool exists. */
export async function quoteSwap(
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amountIn: bigint,
): Promise<bigint | null> {
  const pool = await findPool(tokenIn, tokenOut);
  if (!pool) return null;
  return publicClient.readContract({
    address: MENTO_BROKER,
    abi: brokerAbi,
    functionName: "getAmountOut",
    args: [pool.provider, pool.exchangeId, tokenIn, tokenOut, amountIn],
  });
}

/** How many naira a unit of some other Mento currency is worth right now. */
export async function nairaRate(token: `0x${string}`): Promise<string | null> {
  const out = await quoteSwap(token, NGNM, parseUnits("1", 18));
  return out === null ? null : formatUnits(out, 18);
}

export interface SwapResult {
  approveTx?: string;
  swapTx: string;
  amountOut: string;
}

/**
 * Swaps from Kobo's own wallet. Approvals are for the exact amount being
 * swapped, never unlimited, and the minimum out is derived from a live quote so
 * a moving price cannot fill at an arbitrary rate.
 */
export async function swap(
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amountIn: bigint,
  slippagePct = 1,
  // null pays gas in native CELO, which is the only option before the wallet
  // holds any naira to pay with.
  feeCurrency: `0x${string}` | null = NGNM,
): Promise<SwapResult> {
  const gasFor = async (limit: bigint) => (feeCurrency ? feeParams(feeCurrency, limit) : { gas: limit });
  const pool = await findPool(tokenIn, tokenOut);
  if (!pool) throw new Error("no Mento pool for that pair");

  const expected = await publicClient.readContract({
    address: MENTO_BROKER,
    abi: brokerAbi,
    functionName: "getAmountOut",
    args: [pool.provider, pool.exchangeId, tokenIn, tokenOut, amountIn],
  });
  const minOut = (expected * BigInt(Math.round((100 - slippagePct) * 100))) / 10_000n;

  const wallet = walletClient();
  const me = account().address;

  const allowance = await publicClient.readContract({
    address: tokenIn,
    abi: erc20Abi,
    functionName: "allowance",
    args: [me, MENTO_BROKER],
  });

  let approveTx: string | undefined;
  if (allowance < amountIn) {
    approveTx = await wallet.sendTransaction({
      to: tokenIn,
      data: tag(encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MENTO_BROKER, amountIn] })),
      account: account(),
      chain: wallet.chain,
      ...(await gasFor(120_000n)),
    } as Parameters<typeof wallet.sendTransaction>[0]);
    await publicClient.waitForTransactionReceipt({ hash: approveTx as `0x${string}`, timeout: 120_000 });
  }

  const swapTx = await wallet.sendTransaction({
    to: MENTO_BROKER,
    data: tag(
      encodeFunctionData({
        abi: brokerAbi,
        functionName: "swapIn",
        args: [pool.provider, pool.exchangeId, tokenIn, tokenOut, amountIn, minOut],
      }),
    ),
    account: account(),
    chain: wallet.chain,
    ...(await gasFor(500_000n)),
  } as Parameters<typeof wallet.sendTransaction>[0]);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: swapTx as `0x${string}`, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error("swap reverted");

  return { approveTx, swapTx, amountOut: formatUnits(expected, 18) };
}
