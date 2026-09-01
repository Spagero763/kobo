// Proves the claim the whole product rests on: a naira transfer whose fee is
// paid in naira, leaving the CELO balance untouched.
//   npm run dry-run -- <recipient> <amount>

import { formatUnits, isAddress } from "viem";
import { NGNM } from "../src/config.js";
import { account, erc20Abi, publicClient } from "../src/chain.js";
import { send } from "../src/transfer.js";

const naira = (v: bigint) => Number(formatUnits(v, 18)).toLocaleString("en-NG", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const celo = (v: bigint) => Number(formatUnits(v, 18)).toFixed(6);

/**
 * Balances are read at an explicit block. Reads go through a set of fallback
 * nodes and those nodes are not always at the same height, so an unpinned read
 * after a send can come back from a node that has not seen it yet and look
 * exactly like a transfer that did nothing.
 */
async function snapshot(address: `0x${string}`, blockNumber: bigint) {
  const [ngnm, native] = await Promise.all([
    publicClient.readContract({ address: NGNM, abi: erc20Abi, functionName: "balanceOf", args: [address], blockNumber }),
    publicClient.getBalance({ address, blockNumber }),
  ]);
  return { ngnm, native };
}

async function main() {
  const [to, amount] = process.argv.slice(2);
  if (!to || !isAddress(to)) throw new Error("usage: npm run dry-run -- <recipient> <amount>");
  if (!amount) throw new Error("amount is required");

  const me = account().address;
  console.log(`from   ${me}`);
  console.log(`to     ${to}`);
  console.log(`amount ${amount} NGNm\n`);

  const hash = await send(to, amount);
  const receipt = await publicClient.getTransactionReceipt({ hash: hash as `0x${string}` });
  const at = receipt.blockNumber;
  const [before, after, recipientBefore, recipientAfter] = await Promise.all([
    snapshot(me, at - 1n),
    snapshot(me, at),
    snapshot(to, at - 1n),
    snapshot(to, at),
  ]);

  console.log(`tx      ${hash}`);
  console.log(`block   ${at}`);
  console.log(`before  NGNm ${naira(before.ngnm)}   CELO ${celo(before.native)}`);
  console.log(`after   NGNm ${naira(after.ngnm)}   CELO ${celo(after.native)}\n`);

  const spent = before.ngnm - after.ngnm;
  const celoSpent = before.native - after.native;
  const received = recipientAfter.ngnm - recipientBefore.ngnm;
  const fee = spent - received;

  console.log(`recipient received ${naira(received)} NGNm`);
  console.log(`fee paid           ${naira(fee)} NGNm`);
  console.log(`gas used           ${receipt.gasUsed}`);
  console.log(`CELO spent         ${celo(celoSpent)}`);

  const problems: string[] = [];
  if (celoSpent !== 0n) problems.push("CELO was spent, so the fee did not come out of naira");
  if (fee <= 0n) problems.push("no naira fee was charged");
  if (received.toString() !== (BigInt(Math.round(Number(amount) * 1e6)) * 10n ** 12n).toString()) {
    problems.push(`recipient received ${naira(received)}, expected ${amount}`);
  }

  if (problems.length) {
    console.log(`\nFAILED: ${problems.join("; ")}`);
    process.exit(1);
  }
  console.log("\nPASS: fee paid in naira, CELO untouched, full amount delivered");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
