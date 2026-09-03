// Deploys Personhood to Celo mainnet. The constructor also registers a
// verification config with Self's hub, so this is two state changes in one
// transaction and needs real gas.
//   npm run deploy:personhood

import { readFileSync } from "node:fs";
import { encodeDeployData, formatUnits } from "viem";
import { NGNM, SELF_HUB, SELF_SCOPE_SEED } from "../src/config.js";
import { account, feeParams, publicClient, tag, walletClient } from "../src/chain.js";

const artifact = JSON.parse(
  readFileSync(new URL("../artifacts/Personhood.json", import.meta.url), "utf8"),
) as { abi: any[]; bytecode: `0x${string}`; solc: string };

// The minimum that proves a real adult person. No country list and no OFAC
// screening: Kobo has no reason to learn anyone's nationality to move their own
// money, and every extra field is one more thing a proof discloses.
const CONFIG = {
  olderThan: 18n,
  forbiddenCountries: [] as string[],
  ofacEnabled: false,
};

async function main() {
  const wallet = walletClient();
  const me = account().address;

  const celo = await publicClient.getBalance({ address: me });
  console.log(`deployer  ${me}`);
  console.log(`CELO      ${Number(formatUnits(celo, 18)).toFixed(4)}`);
  console.log(`hub       ${SELF_HUB}`);
  console.log(`scopeSeed ${SELF_SCOPE_SEED}`);
  console.log(`solc      ${artifact.solc}`);
  console.log(`config    olderThan ${CONFIG.olderThan}, ofac ${CONFIG.ofacEnabled}, countries ${CONFIG.forbiddenCountries.length}\n`);

  const data = tag(
    encodeDeployData({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args: [SELF_HUB, SELF_SCOPE_SEED, CONFIG],
    }),
  );

  const hash = await wallet.sendTransaction({
    data,
    account: account(),
    chain: wallet.chain,
    ...(await feeParams(NGNM, 3_000_000n)),
  } as Parameters<typeof wallet.sendTransaction>[0]);
  console.log(`tx        ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error("deployment reverted");
  const address = receipt.contractAddress!;
  console.log(`deployed  ${address}`);
  console.log(`gas used  ${receipt.gasUsed}`);

  // The scope is derived from the deployed address, so it is only knowable now.
  // The frontend must use the same value or every proof is rejected.
  const [scope, configId] = await Promise.all([
    publicClient.readContract({ address, abi: artifact.abi, functionName: "scope" }).catch(() => null),
    publicClient.readContract({ address, abi: artifact.abi, functionName: "verificationConfigId" }).catch(() => null),
  ]);
  console.log(`scope     ${scope}`);
  console.log(`configId  ${configId}`);
  console.log(`\nadd to .env:\nPERSONHOOD=${address}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
