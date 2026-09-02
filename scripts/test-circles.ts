// Exercises the deployed Circles registry on Celo mainnet.
//   npm run test:circles -- 0xContractAddress

import { readFileSync } from "node:fs";
import { encodeFunctionData, keccak256, toHex } from "viem";
import { NGNM } from "../src/config.js";
import { account, feeParams, publicClient, tag, walletClient } from "../src/chain.js";

const artifact = JSON.parse(
  readFileSync(new URL("../artifacts/Circles.json", import.meta.url), "utf8"),
) as { abi: any[]; bytecode: `0x${string}` };

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  pass" : "  FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  ok ? passed++ : failed++;
}

async function main() {
  const address = process.argv[2] as `0x${string}`;
  if (!address) throw new Error("usage: npm run test:circles -- <address>");

  const wallet = walletClient();
  const me = account().address;

  // Nodes in the fallback set sit at different heights, so a read straight
  // after a write can hit one that has not seen it. Every read here is pinned.
  const at = async () => publicClient.getBlockNumber();
  const read = async (fn: string, args: unknown[], blockNumber?: bigint) =>
    publicClient.readContract({ address, abi: artifact.abi, functionName: fn, args, blockNumber });

  const write = async (fn: string, args: unknown[], gas = 400_000n) => {
    const h = await wallet.sendTransaction({
      to: address,
      data: tag(encodeFunctionData({ abi: artifact.abi, functionName: fn, args })),
      account: account(),
      chain: wallet.chain,
      ...(await feeParams(NGNM, gas)),
    } as Parameters<typeof wallet.sendTransaction>[0]);
    return publicClient.waitForTransactionReceipt({ hash: h, timeout: 180_000 });
  };

  console.log(`contract ${address}`);
  console.log(`caller   ${me}\n`);

  const salt = keccak256(toHex(`kobo-test-${Date.now()}`));
  const id = (await read("circleId", [me, salt])) as `0x${string}`;
  check("circleId is deterministic", id === (await read("circleId", [me, salt])));

  console.log("\ncreate");
  const created = await write("create", [salt, 5_000n * 10n ** 18n, 3600n, "Test circle"]);
  check("create succeeds", created.status === "success");
  const block = created.blockNumber;

  const c = (await read("getCircle", [id], block)) as unknown[];
  check("organiser recorded", (c[0] as string).toLowerCase() === me.toLowerCase());
  check("amount recorded", (c[1] as bigint) === 5_000n * 10n ** 18n);
  check("interval recorded", (c[2] as bigint) === 3600n);
  check("not started yet", (c[3] as bigint) === 0n);
  check("organiser auto-joined", (c[4] as unknown[]).length === 1);
  check("isMember true for organiser", (await read("isMember", [id, me], block)) === true);
  check("isMember false for stranger", (await read("isMember", [id, "0x000000000000000000000000000000000000dEaD"], block)) === false);

  const dues = (await read("dues", [id, me], block)) as unknown[];
  check("no dues before start", (dues[0] as bigint) === 0n);

  console.log("\nguards");

  /* Passing an explicit gas limit skips estimation, so a call that reverts is
     still mined and comes back with a receipt rather than throwing. Simulate
     first, which surfaces the revert, and fall back to the receipt status. */
  const shouldRevert = async (label: string, fn: string, args: unknown[]) => {
    try {
      await publicClient.simulateContract({ address, abi: artifact.abi, functionName: fn, args, account: me });
    } catch {
      check(label, true, "reverted in simulation");
      return;
    }
    check(label, false, "call succeeded when it should have reverted");
  };

  await shouldRevert("duplicate create reverts", "create", [salt, 5_000n * 10n ** 18n, 3600n, "Duplicate"]);
  await shouldRevert("start with one member reverts", "start", [id]);
  await shouldRevert("joining twice reverts", "join", [id, "Me again"]);
  await shouldRevert("zero amount reverts", "create", [keccak256(toHex(`zero-${Date.now()}`)), 0n, 3600n, "Zero"]);
  await shouldRevert("interval under 60s reverts", "create", [keccak256(toHex(`fast-${Date.now()}`)), 1n, 10n, "Fast"]);
  await shouldRevert("joining an unknown circle reverts", "join", [keccak256(toHex("nope")), "Ghost"]);

  let reverted = false;
  try { await read("getCircle", [keccak256(toHex("nope"))]); } catch { reverted = true; }
  check("reading an unknown circle reverts", reverted);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
