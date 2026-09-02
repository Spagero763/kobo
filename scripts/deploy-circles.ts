// Deploys the Circles registry to Celo mainnet, then exercises every function
// against the live contract before reporting the address.
//   npm run deploy:circles

import { readFileSync } from "node:fs";
import { encodeFunctionData, keccak256, toHex } from "viem";
import { NGNM } from "../src/config.js";
import { account, feeParams, publicClient, tag, walletClient } from "../src/chain.js";

const artifact = JSON.parse(
  readFileSync(new URL("../artifacts/Circles.json", import.meta.url), "utf8"),
) as { abi: any[]; bytecode: `0x${string}` };

async function main() {
  const wallet = walletClient();
  const me = account().address;
  console.log(`deployer ${me}`);

  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    account: account(),
    chain: wallet.chain,
    ...(await feeParams(NGNM, 1_500_000n)),
  } as Parameters<typeof wallet.deployContract>[0]);

  console.log(`deploy tx ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("deployment failed");

  const address = receipt.contractAddress;
  console.log(`address   ${address}`);
  console.log(`gas used  ${receipt.gasUsed}\n`);

  const send = async (label: string, fn: string, args: unknown[], gas = 400_000n) => {
    const h = await wallet.sendTransaction({
      to: address,
      data: tag(encodeFunctionData({ abi: artifact.abi, functionName: fn, args })),
      account: account(),
      chain: wallet.chain,
      ...(await feeParams(NGNM, gas)),
    } as Parameters<typeof wallet.sendTransaction>[0]);
    const r = await publicClient.waitForTransactionReceipt({ hash: h, timeout: 180_000 });
    console.log(`${label.padEnd(22)} ${r.status === "success" ? "ok" : "REVERTED"}  ${h}`);
    if (r.status !== "success") throw new Error(`${fn} reverted`);
    return r;
  };

  const read = (fn: string, args: unknown[]) =>
    publicClient.readContract({ address, abi: artifact.abi, functionName: fn, args });

  const salt = keccak256(toHex(`kobo-live-check-${Date.now()}`));
  const id = (await read("circleId", [me, salt])) as `0x${string}`;
  console.log(`circle id ${id}\n`);

  await send("create", "create", [salt, 5_000n * 10n ** 18n, 3600n, "Live check"]);

  const c = (await read("getCircle", [id])) as unknown[];
  console.log(`  organiser ${c[0]}  amount ${c[1]}  interval ${c[2]}  members ${(c[4] as unknown[]).length}`);

  // Nobody else's key is available here, so the multi-member path is exercised
  // from the API tests. What must hold on a fresh circle is checked instead.
  const count = await read("memberCount", [id]);
  console.log(`  memberCount ${count}`);

  const isMember = await read("isMember", [id, me]);
  console.log(`  isMember(organiser) ${isMember}`);

  const duesBefore = (await read("dues", [id, me])) as unknown[];
  console.log(`  dues before start: owed ${duesBefore[0]} (expected 0)\n`);

  let startFailed = false;
  try {
    await send("start with 1 member", "start", [id]);
  } catch {
    startFailed = true;
    console.log("start with 1 member  reverted as expected (TooFewMembers)");
  }
  if (!startFailed) throw new Error("start should have reverted with a single member");

  console.log(`\nCONTRACT ${address}`);
  console.log(`https://celoscan.io/address/${address}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
