// Sends a real transfer of any supported token through the same builder the app
// uses, then checks the claim at one block: the recipient got the exact amount,
// the fee came out of a token, and CELO did not move.
//   npm run prove:send -- <symbol> <recipient> <amount>

import { formatUnits, isAddress } from "viem";
import { account, erc20Abi, feeParams, publicClient, walletClient } from "../src/chain.js";
import { buildNairaTransfer } from "../src/naira.js";
import { TOKENS, toUnits, tokenBySymbol } from "../src/tokens.js";

const GAS_LIMIT = 200_000n;

async function main() {
  const [symbol, to, amount] = process.argv.slice(2);
  const token = tokenBySymbol(symbol ?? "");
  if (!token || !to || !isAddress(to) || !amount) {
    throw new Error(`usage: npm run prove:send -- <${Object.keys(TOKENS).join("|")}> <recipient> <amount>`);
  }

  const wallet = walletClient();
  const me = account().address;
  const value = toUnits(token, amount);
  const built = await buildNairaTransfer(token, to, amount, me);

  const balance = (who: `0x${string}`, blockNumber: bigint) =>
    publicClient.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [who], blockNumber });

  const hash = await wallet.sendTransaction({
    to: built.to,
    data: built.data,
    account: account(),
    chain: wallet.chain,
    ...(await feeParams(built.feeCurrency, GAS_LIMIT)),
  } as Parameters<typeof wallet.sendTransaction>[0]);

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error("the transfer reverted");

  const at = receipt.blockNumber;
  const [celoBefore, celoAfter, gotBefore, gotAfter] = await Promise.all([
    publicClient.getBalance({ address: me, blockNumber: at - 1n }),
    publicClient.getBalance({ address: me, blockNumber: at }),
    balance(to, at - 1n),
    balance(to, at),
  ]);

  const received = gotAfter - gotBefore;
  const celoSpent = celoBefore - celoAfter;
  const fee = receipt.gasUsed * receipt.effectiveGasPrice;

  console.log(`tx           ${hash}`);
  console.log(`token        ${token.symbol} ${amount}`);
  console.log(`feeCurrency  ${built.feeCurrency}`);
  console.log(`fee          ${formatUnits(fee, 18)}`);
  console.log(`received     ${formatUnits(received, token.decimals)}`);
  console.log(`CELO spent   ${formatUnits(celoSpent, 18)}`);

  const problems: string[] = [];
  if (received !== value) problems.push(`recipient got ${formatUnits(received, token.decimals)}, expected ${amount}`);
  if (celoSpent !== 0n) problems.push("CELO was spent");
  if (problems.length) {
    console.log(`\nFAILED: ${problems.join("; ")}`);
    process.exit(1);
  }
  console.log(`\nPASS: ${token.symbol} moved in full, fee paid in a token, CELO untouched`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
