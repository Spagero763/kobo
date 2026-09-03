// Runs Circles in a local EVM, so the time-based logic can actually be tested.
// Rotation decides who collects and when, and on a live chain you cannot move
// the clock to check it. Free, offline, and no transactions.
//   npm run test:local

import { readFileSync } from "node:fs";
import { createVM, runTx } from "@ethereumjs/vm";
import { Common, Mainnet, Hardfork } from "@ethereumjs/common";
import { createLegacyTx } from "@ethereumjs/tx";
import { createBlock } from "@ethereumjs/block";
import { Address, hexToBytes, bytesToHex } from "@ethereumjs/util";
import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  toHex,
  toFunctionSelector,
} from "viem";

const artifact = JSON.parse(
  readFileSync(new URL("../artifacts/Circles.json", import.meta.url), "utf8"),
) as { abi: any[]; bytecode: `0x${string}` };

const abi = artifact.abi;

let passed = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  pass" : "  FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  ok ? passed++ : failed++;
};

// Every custom error the contract can raise, by selector, so a test can assert
// which guard fired rather than merely that something did.
const ERRORS = Object.fromEntries(
  abi
    .filter((e: any) => e.type === "error")
    .map((e: any) => [toFunctionSelector(`${e.name}(${(e.inputs ?? []).map((i: any) => i.type).join(",")})`), e.name]),
) as Record<string, string>;

const KEYS = [
  "0x1111111111111111111111111111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222222222222222222222222222",
  "0x3333333333333333333333333333333333333333333333333333333333333333",
] as const;

async function main() {
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Shanghai });
  const vm = await createVM({ common });

  const { privateToAddress, createAccount } = await import("@ethereumjs/util");
  const accounts = await Promise.all(
    KEYS.map(async (k) => {
      const priv = hexToBytes(k);
      const addr = new Address(privateToAddress(priv));
      await vm.stateManager.putAccount(addr, createAccount({ balance: 10n ** 20n }));
      return { priv, address: addr, hex: bytesToHex(addr.bytes) as `0x${string}` };
    }),
  );

  const [alice, bob, carol] = accounts;
  let nonces = new Map(accounts.map((a) => [a.hex, 0n]));
  let now = 1_800_000_000n;

  const send = async (from: (typeof accounts)[number], to: Address | null, data: `0x${string}`) => {
    const nonce = nonces.get(from.hex)!;
    nonces.set(from.hex, nonce + 1n);
    const tx = createLegacyTx(
      { nonce, gasPrice: 0n, gasLimit: 5_000_000n, to: to ?? undefined, data: hexToBytes(data), value: 0n },
      { common },
    ).sign(from.priv);
    // The block carries the timestamp, which is the whole point: rotation is a
    // function of elapsed time and cannot be exercised on a live chain.
    const block = createBlock(
      { header: { number: 1n, timestamp: now, gasLimit: 30_000_000n, baseFeePerGas: 0n } },
      { common, skipConsensusFormatValidation: true },
    );
    return runTx(vm, { tx, block, skipBalance: true, skipBlockGasLimitValidation: true });
  };

  // Deploy
  const deployed = await send(alice, null, artifact.bytecode);
  const contract = deployed.createdAddress!;
  check("contract deploys", !!contract && !deployed.execResult.exceptionError);

  const call = async (from: (typeof accounts)[number], fn: string, args: unknown[]) =>
    send(from, contract, encodeFunctionData({ abi, functionName: fn, args }));

  const read = async (fn: string, args: unknown[]) => {
    const r = await call(alice, fn, args);
    if (r.execResult.exceptionError) throw new Error(String(r.execResult.exceptionError));
    return decodeFunctionResult({ abi, functionName: fn, data: bytesToHex(r.execResult.returnValue) as `0x${string}` });
  };

  const expectRevert = async (
    label: string,
    from: (typeof accounts)[number],
    fn: string,
    args: unknown[],
    errorName: string,
  ) => {
    const r = await call(from, fn, args);
    const ret = bytesToHex(r.execResult.returnValue) as string;
    const selector = ret.slice(0, 10);
    const got = ERRORS[selector];
    if (!r.execResult.exceptionError) return check(label, false, "did not revert");
    check(label, got === errorName, got ? `reverted with ${got}` : `unknown selector ${selector}`);
  };

  console.log("\ncreate");
  const salt = keccak256(toHex("circle-1"));
  const id = (await read("circleId", [alice.hex, salt])) as `0x${string}`;
  await call(alice, "create", [salt, 1000n, 3600n, "Ajo"]);
  const c = (await read("getCircle", [id])) as unknown[];
  check("organiser recorded", (c[0] as string).toLowerCase() === alice.hex);
  check("organiser auto-joined", (c[4] as unknown[]).length === 1);

  console.log("\nguards name the right error");
  await expectRevert("zero amount", alice, "create", [keccak256(toHex("z")), 0n, 3600n, "Z"], "BadAmount");
  await expectRevert("interval under 60s", alice, "create", [keccak256(toHex("f")), 1n, 59n, "F"], "BadInterval");
  await expectRevert("duplicate id", alice, "create", [salt, 1000n, 3600n, "Dup"], "CircleExists");
  await expectRevert("join twice", alice, "join", [id, "again"], "AlreadyMember");
  await expectRevert("join unknown circle", bob, "join", [keccak256(toHex("nope")), "ghost"], "NoSuchCircle");
  await expectRevert("start needs two members", alice, "start", [id], "TooFewMembers");
  await expectRevert("only organiser starts", bob, "start", [id], "NotOrganiser");

  console.log("\nrotation");
  await call(bob, "join", [id, "Bob"]);
  await call(carol, "join", [id, "Carol"]);
  const joined = (await read("getCircle", [id])) as unknown[];
  check("three members", (joined[4] as unknown[]).length === 3);

  await expectRevert("no round before start", alice, "currentRound", [id], "NotStarted");

  const startedAt = now;
  await call(alice, "start", [id]);
  await expectRevert("cannot start twice", alice, "start", [id], "AlreadyStarted");
  await expectRevert("cannot join a started circle", bob, "join", [id, "late"], "AlreadyStarted");

  const roundAt = async (offset: bigint) => {
    now = startedAt + offset;
    const [round, recipient] = (await read("currentRound", [id])) as [bigint, string];
    return { round, recipient: recipient.toLowerCase() };
  };

  const r0 = await roundAt(0n);
  check("round 0 pays the organiser", r0.round === 0n && r0.recipient === alice.hex);

  const r0late = await roundAt(3599n);
  check("still round 0 one second before the interval", r0late.round === 0n);

  const r1 = await roundAt(3600n);
  check("round 1 begins exactly on the interval", r1.round === 1n && r1.recipient === bob.hex);

  const r2 = await roundAt(7200n);
  check("round 2 pays the third member", r2.round === 2n && r2.recipient === carol.hex);

  const past = await roundAt(3600n * 50n);
  check("clamps at the last round once complete", past.round === 2n && past.recipient === carol.hex);

  console.log("\ndues");
  now = startedAt + 3600n;
  const bobDues = (await read("dues", [id, bob.hex])) as [bigint, string, bigint];
  check("the recipient owes nothing", bobDues[0] === 0n);
  const aliceDues = (await read("dues", [id, alice.hex])) as [bigint, string, bigint];
  check("everyone else owes the amount", aliceDues[0] === 1000n);
  check("dues point at the recipient", aliceDues[1].toLowerCase() === bob.hex);
  const strangerDues = (await read("dues", [id, "0x000000000000000000000000000000000000dEaD"])) as [bigint, string, bigint];
  check("a non-member owes nothing", strangerDues[0] === 0n);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
