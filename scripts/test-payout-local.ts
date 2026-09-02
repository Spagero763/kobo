// Payout moves other people's money, so it gets exercised in a local EVM before
// it goes near mainnet, including the failure paths.
//   npm run test:payout

import { readFileSync } from "node:fs";
import { createVM, runTx } from "@ethereumjs/vm";
import { Common, Mainnet, Hardfork } from "@ethereumjs/common";
import { createLegacyTx } from "@ethereumjs/tx";
import { createBlock } from "@ethereumjs/block";
import { Address, hexToBytes, bytesToHex, privateToAddress, createAccount } from "@ethereumjs/util";
import {
  decodeFunctionResult,
  encodeFunctionData,
  encodeDeployData,
  toFunctionSelector,
  zeroAddress,
} from "viem";

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`../artifacts/${name}.json`, import.meta.url), "utf8")) as {
    abi: any[];
    bytecode: `0x${string}`;
  };

const Payout = load("Payout");
const MockERC20 = load("MockERC20");
const LyingERC20 = load("LyingERC20");
const MockBroker = load("MockBroker");

const ERRORS = Object.fromEntries(
  Payout.abi
    .filter((e: any) => e.type === "error")
    .map((e: any) => [
      toFunctionSelector(`${e.name}(${(e.inputs ?? []).map((i: any) => i.type).join(",")})`),
      e.name,
    ]),
) as Record<string, string>;

let passed = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  pass" : "  FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  ok ? passed++ : failed++;
};

const ONE = 10n ** 18n;
const EXCHANGE_ID = "0x" + "11".repeat(32);

async function main() {
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Shanghai });
  const vm = await createVM({ common });

  const keys = ["0x" + "11".repeat(32), "0x" + "22".repeat(32), "0x" + "33".repeat(32)] as const;
  const accounts = await Promise.all(
    keys.map(async (k) => {
      const priv = hexToBytes(k as `0x${string}`);
      const address = new Address(privateToAddress(priv));
      await vm.stateManager.putAccount(address, createAccount({ balance: 10n ** 20n }));
      return { priv, address, hex: bytesToHex(address.bytes) as `0x${string}` };
    }),
  );
  const [alice, recipient] = accounts;
  const nonces = new Map(accounts.map((a) => [a.hex, 0n]));

  const send = async (from: (typeof accounts)[number], to: Address | null, data: `0x${string}`) => {
    const nonce = nonces.get(from.hex)!;
    nonces.set(from.hex, nonce + 1n);
    const tx = createLegacyTx(
      { nonce, gasPrice: 0n, gasLimit: 8_000_000n, to: to ?? undefined, data: hexToBytes(data), value: 0n },
      { common },
    ).sign(from.priv);
    const block = createBlock(
      { header: { number: 1n, timestamp: 1_800_000_000n, gasLimit: 30_000_000n, baseFeePerGas: 0n } },
      { common, skipConsensusFormatValidation: true },
    );
    return runTx(vm, { tx, block, skipBalance: true, skipBlockGasLimitValidation: true });
  };

  const deploy = async (artifact: { abi: any[]; bytecode: `0x${string}` }, args: unknown[] = []) => {
    const r = await send(
      alice,
      null,
      encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args }),
    );
    if (r.execResult.exceptionError) throw new Error(`deploy failed: ${r.execResult.exceptionError}`);
    return r.createdAddress!;
  };

  const call = async (
    from: (typeof accounts)[number],
    to: Address,
    abi: any[],
    fn: string,
    args: unknown[],
  ) => send(from, to, encodeFunctionData({ abi, functionName: fn, args }));

  const read = async (to: Address, abi: any[], fn: string, args: unknown[]) => {
    const r = await call(alice, to, abi, fn, args);
    return decodeFunctionResult({
      abi,
      functionName: fn,
      data: bytesToHex(r.execResult.returnValue) as `0x${string}`,
    });
  };

  console.log("setup");
  const naira = await deploy(MockERC20, ["NGNm", 0n]);
  const shilling = await deploy(MockERC20, ["KESm", 0n]);
  const broker = await deploy(MockBroker);
  const payout = await deploy(Payout, [bytesToHex(broker.bytes)]);
  check("everything deploys", true);

  const nairaHex = bytesToHex(naira.bytes) as `0x${string}`;
  const shillingHex = bytesToHex(shilling.bytes) as `0x${string}`;
  const payoutHex = bytesToHex(payout.bytes) as `0x${string}`;

  await call(alice, naira, MockERC20.abi, "mint", [alice.hex, 1000n * ONE]);
  await call(alice, shilling, MockERC20.abi, "mint", [bytesToHex(broker.bytes), 10_000n * ONE]);

  const doSend = async (
    from: (typeof accounts)[number],
    amountIn: bigint,
    minOut: bigint,
    to: string,
    tokenOut: `0x${string}` = shillingHex,
  ) =>
    call(from, payout, Payout.abi, "send", [
      zeroAddress,
      EXCHANGE_ID,
      nairaHex,
      tokenOut,
      amountIn,
      minOut,
      to,
    ]);

  const expectRevert = async (label: string, r: Awaited<ReturnType<typeof doSend>>, name: string) => {
    const selector = (bytesToHex(r.execResult.returnValue) as string).slice(0, 10);
    if (!r.execResult.exceptionError) return check(label, false, "did not revert");
    const got = ERRORS[selector];
    check(label, got === name, got ? `reverted with ${got}` : `selector ${selector}`);
  };

  console.log("\nthe happy path");
  await call(alice, naira, MockERC20.abi, "approve", [payoutHex, 100n * ONE]);
  const sent = await doSend(alice, 100n * ONE, 0n, recipient.hex);
  check("send succeeds", !sent.execResult.exceptionError);
  check(
    "recipient receives the swapped amount",
    ((await read(shilling, MockERC20.abi, "balanceOf", [recipient.hex])) as bigint) === 200n * ONE,
    "100 naira in, 200 shillings out",
  );
  check(
    "sender is debited exactly the amount",
    ((await read(naira, MockERC20.abi, "balanceOf", [alice.hex])) as bigint) === 900n * ONE,
  );
  check(
    "nothing is left in the contract",
    ((await read(shilling, MockERC20.abi, "balanceOf", [payoutHex])) as bigint) === 0n,
  );
  check(
    "no standing allowance is left for the broker",
    ((await read(naira, MockERC20.abi, "allowance", [payoutHex, bytesToHex(broker.bytes)])) as bigint) === 0n,
  );

  console.log("\nguards");
  await call(alice, naira, MockERC20.abi, "approve", [payoutHex, 500n * ONE]);
  await expectRevert("zero recipient rejected", await doSend(alice, ONE, 0n, zeroAddress), "BadRecipient");
  await expectRevert("the contract itself rejected", await doSend(alice, ONE, 0n, payoutHex), "BadRecipient");

  const noApproval = accounts[2];
  await call(alice, naira, MockERC20.abi, "mint", [noApproval.hex, 10n * ONE]);
  const unapproved = await doSend(noApproval, ONE, 0n, recipient.hex);
  check("a sender without an approval cannot pull funds", !!unapproved.execResult.exceptionError);

  console.log("\nslippage");
  const tooGreedy = await doSend(alice, ONE, 3n * ONE, recipient.hex);
  check("a floor above the real rate reverts", !!tooGreedy.execResult.exceptionError, "broker enforces min out");

  console.log("\nawkward tokens");

  // A fee-on-transfer payout token means less arrives than the broker reported,
  // so paying the recipient the full figure runs out of balance. It reverts in
  // the token rather than reaching the residue check, which is the point: the
  // whole transaction unwinds and nobody is short.
  const feeToken = await deploy(MockERC20, ["FEEm", 100n]);
  await call(alice, feeToken, MockERC20.abi, "mint", [bytesToHex(broker.bytes), 10_000n * ONE]);
  const feeSend = await doSend(alice, ONE, 0n, recipient.hex, bytesToHex(feeToken.bytes) as `0x${string}`);
  check("a fee-on-transfer payout reverts rather than short-paying", !!feeSend.execResult.exceptionError);
  check(
    "and leaves nothing behind",
    ((await read(feeToken, MockERC20.abi, "balanceOf", [payoutHex])) as bigint) === 0n,
  );

  // What ResidueLeftBehind is actually for: a broker that hands over more than
  // it reports. Forwarding only the reported figure would strand the rest here
  // forever, so the transaction is refused instead.
  await call(alice, broker, MockBroker.abi, "setSurplus", [ONE]);
  await expectRevert(
    "a broker that over-delivers is refused rather than stranding funds",
    await doSend(alice, ONE, 0n, recipient.hex),
    "ResidueLeftBehind",
  );
  await call(alice, broker, MockBroker.abi, "setSurplus", [0n]);

  const liar = await deploy(LyingERC20);
  await call(alice, liar, LyingERC20.abi, "mint", [alice.hex, 10n * ONE]);
  const lied = await call(alice, payout, Payout.abi, "send", [
    zeroAddress,
    EXCHANGE_ID,
    bytesToHex(liar.bytes),
    shillingHex,
    ONE,
    0n,
    recipient.hex,
  ]);
  await expectRevert("a token that returns false is caught", lied, "TransferInFailed");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
