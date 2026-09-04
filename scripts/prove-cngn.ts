// Sends real cNGN on Celo mainnet and checks the three things that make Kobo's
// claim true: the recipient gets the exact amount, the fee comes out of NGNm,
// and the CELO balance does not move.
//   npm run prove:cngn -- <recipient> <amount>

import { encodeFunctionData, formatUnits, isAddress, parseUnits } from "viem";
import { NGNM } from "../src/config.js";
import { account, erc20Abi, feeParams, publicClient, tag, walletClient } from "../src/chain.js";
import { TOKENS } from "../src/tokens.js";

const cNGN = TOKENS.cNGN;
const GAS_LIMIT = 200_000n;

const fmt = (v: bigint, d: number) =>
  Number(formatUnits(v, d)).toLocaleString("en-NG", { minimumFractionDigits: 4, maximumFractionDigits: 4 });

/** Every balance at one block, because fallback nodes sit at different heights. */
async function snapshot(address: `0x${string}`, blockNumber: bigint) {
  const [cngn, ngnm, celo] = await Promise.all([
    publicClient.readContract({ address: cNGN.address, abi: erc20Abi, functionName: "balanceOf", args: [address], blockNumber }),
    publicClient.readContract({ address: NGNM, abi: erc20Abi, functionName: "balanceOf", args: [address], blockNumber }),
    publicClient.getBalance({ address, blockNumber }),
  ]);
  return { cngn, ngnm, celo };
}

async function main() {
  const [to, amount] = process.argv.slice(2);
  if (!to || !isAddress(to)) throw new Error("usage: npm run prove:cngn -- <recipient> <amount>");
  if (!amount) throw new Error("amount is required");

  const wallet = walletClient();
  const me = account().address;
  const value = parseUnits(amount, cNGN.decimals);

  console.log(`token   cNGN ${cNGN.address} (${cNGN.decimals} decimals)`);
  console.log(`from    ${me}`);
  console.log(`to      ${to}`);
  console.log(`amount  ${amount} cNGN\n`);

  const hash = await wallet.sendTransaction({
    to: cNGN.address,
    data: tag(encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to as `0x${string}`, value] })),
    account: account(),
    chain: wallet.chain,
    // The fee currency is NGNm, not the token being sent. cNGN cannot pay for
    // its own gas, which is the entire point of this test.
    ...(await feeParams(NGNM, GAS_LIMIT)),
  } as Parameters<typeof wallet.sendTransaction>[0]);

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error("the transfer reverted");

  const at = receipt.blockNumber;
  const [before, after, gotBefore, gotAfter] = await Promise.all([
    snapshot(me, at - 1n),
    snapshot(me, at),
    snapshot(to, at - 1n),
    snapshot(to, at),
  ]);

  const tx = await publicClient.getTransaction({ hash });
  const sent = before.cngn - after.cngn;
  const received = gotAfter.cngn - gotBefore.cngn;
  const nairaFee = before.ngnm - after.ngnm;
  const celoSpent = before.celo - after.celo;

  console.log(`tx           ${hash}`);
  console.log(`block        ${at}`);
  console.log(`feeCurrency  ${(tx as { feeCurrency?: string }).feeCurrency ?? "(none, native CELO)"}`);
  console.log(`gas used     ${receipt.gasUsed}\n`);
  console.log(`cNGN sent        ${fmt(sent, 6)}`);
  console.log(`cNGN received    ${fmt(received, 6)}`);
  console.log(`NGNm fee         ${fmt(nairaFee, 18)}`);
  console.log(`CELO spent       ${formatUnits(celoSpent, 18)}`);

  const problems: string[] = [];
  if (received !== value) problems.push(`recipient got ${fmt(received, 6)}, expected ${amount}`);
  if (sent !== value) problems.push("the sender lost more cNGN than was sent");
  if (celoSpent !== 0n) problems.push("CELO was spent, so the fee did not come out of naira");
  if (nairaFee <= 0n) problems.push("no NGNm fee was charged");
  const feeCurrency = (tx as { feeCurrency?: string }).feeCurrency ?? "";
  if (feeCurrency.toLowerCase() !== NGNM.toLowerCase()) problems.push("the transaction did not carry NGNm as its fee currency");

  if (problems.length) {
    console.log(`\nFAILED: ${problems.join("; ")}`);
    process.exit(1);
  }
  console.log("\nPASS: cNGN moved in full, the fee came out of naira, CELO untouched");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
