// Converts a Mento stablecoin the wallet already holds into NGNm, so it can pay
// its own gas from then on.
//   npm run naira -- 5          swaps 5 USDm
//   npm run naira -- 5 GHSm     swaps 5 GHSm
//
// Mento's broker is stable to stable only, every pool paired against USDm, so
// CELO cannot reach naira here. Get USDm on a DEX or in MiniPay first.

import { formatUnits, parseUnits } from "viem";
import { MENTO_CURRENCIES, NGNM } from "../src/config.js";
import { account, erc20Abi, publicClient } from "../src/chain.js";
import { quoteSwap, swap } from "../src/swap.js";

const naira = (v: bigint) => Number(formatUnits(v, 18)).toLocaleString("en-NG", { maximumFractionDigits: 2 });

function tokenFor(symbol: string): `0x${string}` {
  const found = Object.entries(MENTO_CURRENCIES).find(([s]) => s.toLowerCase() === symbol.toLowerCase());
  if (!found) throw new Error(`unknown token ${symbol}. Known: ${Object.keys(MENTO_CURRENCIES).join(", ")}`);
  return found[1] as `0x${string}`;
}

async function balance(token: `0x${string}`) {
  return publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account().address],
  });
}

async function main() {
  const [amount, symbol = "USDm"] = process.argv.slice(2);
  if (!amount) throw new Error("usage: npm run naira -- <amount> [symbol]");

  const tokenIn = tokenFor(symbol);
  const amountIn = parseUnits(amount, 18);
  const held = await balance(tokenIn);
  if (held < amountIn) {
    throw new Error(`wallet holds ${formatUnits(held, 18)} ${symbol}, need ${amount}`);
  }

  const expected = await quoteSwap(tokenIn, NGNM, amountIn);
  if (expected === null) throw new Error(`no Mento pool between ${symbol} and NGNm`);
  console.log(`${amount} ${symbol} -> ~${naira(expected)} NGNm`);

  // Gas in CELO here: the wallet has no naira to pay with yet.
  const result = await swap(tokenIn, NGNM, amountIn, 1, null);
  if (result.approveTx) console.log(`approve ${result.approveTx}`);
  console.log(`swap    ${result.swapTx}`);
  console.log(`\nNGNm balance ${naira(await balance(NGNM))}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
