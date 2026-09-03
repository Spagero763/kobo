import { randomUUID } from "node:crypto";
import { PERSONHOOD, SELF_SCOPE_SEED } from "./config.js";
import { publicClient } from "./chain.js";

const REDIRECT = "https://redirect.self.xyz/";
const CELO_CHAIN_ID = 42220;

const abi = [
  { type: "function", name: "isVerified", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "nullifierOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "sameHuman", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "verifiedCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

/**
 * The payload Self's app expects, built here rather than through
 * @selfxyz/qrcode.
 *
 * That package pulls in 79 dependencies and opens a websocket module on import,
 * neither of which belongs in a serverless function that only needs to produce a
 * URL. The shape is checked against the official builder by
 * `npm run verify:selflink`, so this stays correct rather than merely convenient.
 */
export function buildLink(userAddress: string): { link: string; sessionId: string } {
  if (!PERSONHOOD) throw new Error("PERSONHOOD contract address is not configured");

  const sessionId = randomUUID();
  const selfApp = {
    sessionId,
    userIdType: "hex",
    devMode: false,
    endpointType: "celo",
    header: "",
    logoBase64: "",
    deeplinkCallback: "",
    disclosures: { minimumAge: 18 },
    chainID: CELO_CHAIN_ID,
    version: 2,
    userDefinedData: "",
    appName: "Kobo",
    scope: SELF_SCOPE_SEED,
    endpoint: PERSONHOOD,
    // The app expects the address without its 0x prefix.
    userId: userAddress.replace(/^0x/, ""),
  };

  return {
    link: `${REDIRECT}?selfApp=${encodeURIComponent(JSON.stringify(selfApp))}`,
    sessionId,
  };
}

export async function isVerified(address: `0x${string}`): Promise<boolean> {
  if (!PERSONHOOD) return false;
  return publicClient.readContract({ address: PERSONHOOD, abi, functionName: "isVerified", args: [address] });
}

export async function status(address: `0x${string}`) {
  if (!PERSONHOOD) {
    return { configured: false, verified: false, address, contract: null };
  }
  const [verified, nullifier, total] = await Promise.all([
    publicClient.readContract({ address: PERSONHOOD, abi, functionName: "isVerified", args: [address] }),
    publicClient.readContract({ address: PERSONHOOD, abi, functionName: "nullifierOf", args: [address] }),
    publicClient.readContract({ address: PERSONHOOD, abi, functionName: "verifiedCount", args: [] }).catch(() => 0n),
  ]);
  return {
    configured: true,
    address,
    verified,
    // Published deliberately: it identifies a person across their addresses and
    // discloses nothing about them. It is what a circle checks.
    nullifier: nullifier === 0n ? null : nullifier.toString(),
    verifiedPeople: Number(total),
    contract: PERSONHOOD,
  };
}

/** Whether two addresses belong to the same person. What a circle actually needs. */
export async function sameHuman(a: `0x${string}`, b: `0x${string}`): Promise<boolean> {
  if (!PERSONHOOD) return false;
  return publicClient.readContract({ address: PERSONHOOD, abi, functionName: "sameHuman", args: [a, b] });
}
