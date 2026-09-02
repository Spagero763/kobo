// Mints Kobo's ERC-8004 identity on Celo mainnet. Run once.
//   npm run register

import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { config, IDENTITY_REGISTRY } from "../src/config.js";

const registryAbi = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "event",
    name: "Registered",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
    ],
  },
] as const;

const AGENT_URI =
  process.env.AGENT_URI ??
  "https://raw.githubusercontent.com/Spagero763/kobo/main/.well-known/agent-card.json";

async function main() {
  if (!config.agentPrivateKey) throw new Error("AGENT_PRIVATE_KEY is not set in .env");

  if (!config.agentAddress) throw new Error("AGENT_ADDRESS is not set in .env");
  const account = privateKeyToAccount(config.agentPrivateKey as `0x${string}`);
  if (account.address.toLowerCase() !== config.agentAddress.toLowerCase()) {
    throw new Error(`Key belongs to ${account.address}, but AGENT_ADDRESS is ${config.agentAddress}`);
  }

  const publicClient = createPublicClient({ chain: celo, transport: http(config.celoRpc) });
  const wallet = createWalletClient({ account, chain: celo, transport: http(config.celoRpc) });

  // The registry stores this URI verbatim, so a dead link is a dead identity.
  const res = await fetch(AGENT_URI, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`agent card unreachable: HTTP ${res.status}`);
  await res.json();

  console.log(`owner    ${account.address}`);
  console.log(`agentURI ${AGENT_URI}`);

  const hash = await wallet.sendTransaction({
    to: IDENTITY_REGISTRY,
    data: encodeFunctionData({ abi: registryAbi, functionName: "register", args: [AGENT_URI] }),
  });
  console.log(`tx       ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("registration reverted");

  for (const log of receipt.logs) {
    try {
      const parsed = decodeEventLog({ abi: registryAbi, data: log.data, topics: log.topics });
      if (parsed.eventName === "Registered") {
        const agentId = (parsed.args as { agentId: bigint }).agentId;
        console.log(`\nAgent ID ${agentId}`);
        console.log(`https://8004scan.io/agents/celo/${agentId}`);
        return;
      }
    } catch {
      // log from another contract
    }
  }
  console.log("registered, but the event did not decode; check the tx on celoscan");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
