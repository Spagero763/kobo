// Deploys Payout to Celo mainnet, then sends a small real amount through it.
// The local suite proves the logic against a mock broker; this proves it against
// the actual Mento broker, which is the only thing that counts before anyone
// else's money goes near it.
//   npm run deploy:payout -- <recipient> <naira> <SYMBOL>

import { readFileSync } from "node:fs";
import { encodeFunctionData, formatUnits, isAddress, parseUnits } from "viem";
import { MENTO_BROKER, MENTO_CURRENCIES, NGNM } from "../src/config.js";
import { account, erc20Abi, feeParams, publicClient, tag, walletClient } from "../src/chain.js";
import { findPool, quoteSwap } from "../src/swap.js";

const artifact = JSON.parse(
  readFileSync(new URL("../artifacts/Payout.json", import.meta.url), "utf8"),
) as { abi: any[]; bytecode: `0x${string}` };

const naira = (v: bigint) => Number(formatUnits(v, 18)).toFixed(4);

async function main() {
  const [to, amountArg, symbolArg] = process.argv.slice(2);
  if (!to || !isAddress(to)) throw new Error("usage: npm run deploy:payout -- <recipient> <naira> <SYMBOL>");
  const symbol = (symbolArg ?? "USDm").toUpperCase();
  const entry = Object.entries(MENTO_CURRENCIES).find(([s]) => s.toUpperCase() === symbol);
  if (!entry) throw new Error(`unknown payout currency ${symbol}`);
  const tokenOut = entry[1] as `0x${string}`;
  const amountIn = parseUnits(amountArg ?? "50", 18);

  const wallet = walletClient();
  const me = account().address;
  console.log(`deployer  ${me}`);
  console.log(`sending   ${naira(amountIn)} NGNm -> ${entry[0]} -> ${to}\n`);

  const pool = await findPool(NGNM, tokenOut);
  if (!pool) throw new Error(`no Mento pool between NGNm and ${entry[0]}`);

  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [MENTO_BROKER],
    account: account(),
    chain: wallet.chain,
    ...(await feeParams(NGNM, 1_200_000n)),
  } as Parameters<typeof wallet.deployContract>[0]);

  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (deployReceipt.status !== "success" || !deployReceipt.contractAddress) throw new Error("deployment failed");
  const payout = deployReceipt.contractAddress;
  console.log(`address   ${payout}`);
  console.log(`gas used  ${deployReceipt.gasUsed}\n`);

  const balanceOf = async (token: `0x${string}`, who: `0x${string}`, blockNumber?: bigint) =>
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who], blockNumber });

  const expected = (await quoteSwap(NGNM, tokenOut, amountIn))!;
  // A real pool moves between quoting and filling, so the floor is set below the
  // quote rather than at it. Too tight and an honest swap reverts.
  const minOut = (expected * 99n) / 100n;
  console.log(`quote     ${naira(amountIn)} NGNm -> ${formatUnits(expected, 18)} ${entry[0]}`);
  console.log(`floor     ${formatUnits(minOut, 18)} ${entry[0]}\n`);

  const write = async (label: string, to_: `0x${string}`, data: `0x${string}`, gas: bigint) => {
    const h = await wallet.sendTransaction({
      to: to_,
      data: tag(data),
      account: account(),
      chain: wallet.chain,
      ...(await feeParams(NGNM, gas)),
    } as Parameters<typeof wallet.sendTransaction>[0]);
    const r = await publicClient.waitForTransactionReceipt({ hash: h, timeout: 180_000 });
    console.log(`${label.padEnd(10)} ${r.status === "success" ? "ok" : "REVERTED"}  ${h}`);
    if (r.status !== "success") throw new Error(`${label} reverted`);
    return r;
  };

  await write(
    "approve",
    NGNM,
    encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [payout, amountIn] }),
    150_000n,
  );

  const before = {
    senderNaira: await balanceOf(NGNM, me),
    recipientOut: await balanceOf(tokenOut, to as `0x${string}`),
    celo: await publicClient.getBalance({ address: me }),
  };

  const receipt = await write(
    "send",
    payout,
    encodeFunctionData({
      abi: artifact.abi,
      functionName: "send",
      args: [pool.provider, pool.exchangeId, NGNM, tokenOut, amountIn, minOut, to],
    }),
    800_000n,
  );

  const at = receipt.blockNumber;
  const after = {
    senderNaira: await balanceOf(NGNM, me, at),
    recipientOut: await balanceOf(tokenOut, to as `0x${string}`, at),
    celo: await publicClient.getBalance({ address: me, blockNumber: at }),
    stuckIn: await balanceOf(NGNM, payout, at),
    stuckOut: await balanceOf(tokenOut, payout, at),
  };

  const delivered = after.recipientOut - before.recipientOut;
  const spent = before.senderNaira - after.senderNaira;

  console.log(`\nrecipient received  ${formatUnits(delivered, 18)} ${entry[0]}`);
  console.log(`sender spent        ${naira(spent)} NGNm (amount plus fee)`);
  console.log(`CELO spent          ${formatUnits(before.celo - after.celo, 18)}`);
  console.log(`left in contract    ${naira(after.stuckIn)} NGNm, ${formatUnits(after.stuckOut, 18)} ${entry[0]}`);

  const problems: string[] = [];
  if (delivered < minOut) problems.push("recipient received less than the floor");
  if (after.stuckIn !== 0n || after.stuckOut !== 0n) problems.push("tokens were left in the contract");
  if (before.celo !== after.celo) problems.push("CELO was spent, so the fee did not come out of naira");
  if (spent <= amountIn) problems.push("sender was not charged the amount plus a fee");

  if (problems.length) {
    console.log(`\nFAILED: ${problems.join("; ")}`);
    process.exit(1);
  }

  console.log(`\nPASS: delivered above the floor, nothing stranded, no CELO touched`);
  console.log(`\nPAYOUT ${payout}`);
  console.log(`https://celoscan.io/address/${payout}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
