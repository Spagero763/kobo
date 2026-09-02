import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  type Account,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { toDataSuffix } from "@celo/attribution-tags";
import type { Hex } from "viem";
import { config, FEE_CURRENCY_DIRECTORY } from "./config.js";

// A single public node is the most common way a read path dies. viem rotates
// through these and retries, so one endpoint rate limiting or going down does
// not take balances and quotes with it.
const RPC_URLS = [
  config.celoRpc,
  "https://celo.drpc.org",
  "https://1rpc.io/celo",
  "https://rpc.ankr.com/celo",
].filter((u, i, a) => u && a.indexOf(u) === i);

export const publicClient: PublicClient = createPublicClient({
  chain: celo,
  transport: fallback(
    RPC_URLS.map((url) => http(url, { timeout: 15_000, retryCount: 2 })),
    { rank: false },
  ),
}) as PublicClient;

let wallet: WalletClient | null = null;

export function walletClient(): WalletClient {
  if (!config.agentPrivateKey) throw new Error("AGENT_PRIVATE_KEY is not set");
  if (!wallet) {
    wallet = createWalletClient({
      account: privateKeyToAccount(config.agentPrivateKey),
      chain: celo,
      transport: http(config.celoRpc),
    });
  }
  return wallet;
}

export function account(): Account {
  return walletClient().account!;
}

export function tag(calldata: Hex): Hex {
  if (!config.attributionTag) return calldata;
  const suffix = toDataSuffix(config.attributionTag);
  return (calldata + suffix.replace(/^0x/, "")) as Hex;
}

/**
 * Retries a read that fails only because the chain state has not reached the
 * node yet.
 *
 * Reads go through several public nodes and they sit at different heights, so a
 * read issued straight after a write can land on one that has not seen it. That
 * looks identical to the thing genuinely not existing, which has already
 * produced three different phantom bugs here. A freshly written value resolves
 * within a couple of seconds; something that truly does not exist still fails,
 * just a moment later.
 */
export async function readFresh<T>(read: () => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await read();
    } catch (e) {
      last = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw last;
}

export const erc20Abi = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

const directoryAbi = [
  { type: "function", name: "getCurrencies", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
] as const;

let allowlist: Set<string> | null = null;

/**
 * Which tokens Celo governance currently accepts as gas. Read rather than
 * hardcoded: membership changes, and passing a token that is not on the list
 * fails at send time with an error that says nothing about the real cause.
 */
export async function feeCurrencyAllowlist(): Promise<Set<string>> {
  if (allowlist) return allowlist;
  const list = await publicClient.readContract({
    address: FEE_CURRENCY_DIRECTORY,
    abi: directoryAbi,
    functionName: "getCurrencies",
  });
  allowlist = new Set(list.map((a) => a.toLowerCase()));
  return allowlist;
}

export async function canPayGasWith(token: `0x${string}`): Promise<boolean> {
  return (await feeCurrencyAllowlist()).has(token.toLowerCase());
}

/**
 * CIP-64 fee parameters for paying gas in an ERC-20.
 *
 * Two things make this awkward. The fee-currency gas price oracle lags the
 * block base fee, and the node rejects anything under the base fee, so the cap
 * is anchored on whichever is higher. And the node's estimator rejects these
 * transactions outright with "gas required exceeds allowance", because
 * allowance is balance divided by maxFeePerGas, so estimation is skipped and an
 * explicit limit passed. Unused gas is refunded.
 */
export async function gasPrice(feeCurrency: `0x${string}`): Promise<{ anchor: bigint; tip: bigint }> {
  const [block, oracle] = await Promise.all([
    publicClient.getBlock({ blockTag: "latest" }),
    publicClient
      .request({ method: "eth_gasPrice" as never, params: [feeCurrency] as never })
      .then((v) => BigInt(v as string))
      .catch(() => 0n),
  ]);
  const base = block.baseFeePerGas ?? 0n;
  const anchor = base > oracle ? base : oracle;
  return { anchor, tip: anchor / 10n + 1n };
}

export async function feeParams(
  feeCurrency: `0x${string}`,
  gasLimit = 300_000n,
): Promise<Record<string, unknown>> {
  const { anchor, tip } = await gasPrice(feeCurrency);
  if (anchor === 0n) return { feeCurrency, gas: gasLimit };
  // The cap is deliberately loose so a busy block cannot strand the send.
  // Under EIP-1559 the sender pays base plus tip, never the cap, and unused
  // gas is refunded, so a generous ceiling costs nothing.
  return {
    feeCurrency,
    maxFeePerGas: anchor * 2n + tip,
    maxPriorityFeePerGas: tip,
    gas: gasLimit,
  };
}
