// Decodes real transactions and confirms the registered tag is actually in
// them. A tag cannot be added after a transaction is sent, so a wiring mistake
// found late is uncounted activity that no fix recovers.
//   npm run verify:tag [txHash ...]

import * as attribution from "@celo/attribution-tags";
import { config } from "../src/config.js";
import { publicClient } from "../src/chain.js";

// Recent tagged transactions from this project, oldest first.
const DEFAULTS = [
  "0x2382911f16bcbeb87290c72a84d615b279e6fc2282677e269eb56b8079866cc9",
  "0xa9a66398b69507922d0b5a935d1e9933ce0f8f12d4a63e44db1b5b33ce8d9065",
  "0xc48d5955bbc006067aa09835322b5501352e31f9a88f69bae8ef8d35fd0f0a95",
];

async function main() {
  const tag = config.attributionTag;
  if (!tag) throw new Error("ATTRIBUTION_TAG is not set");
  console.log(`registered tag  ${tag}`);
  console.log(`valid format    ${/^[a-z0-9_]{1,32}$/.test(tag)}\n`);

  const hashes = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULTS;
  let missing = 0;

  for (const hash of hashes) {
    const tx = await publicClient.getTransaction({ hash: hash as `0x${string}` }).catch(() => null);
    if (!tx) {
      console.log(`${hash}  not found`);
      missing++;
      continue;
    }

    // Prefer the library's own decoder so this checks what Celo checks, rather
    // than a substring match that would pass on a coincidence.
    let codes: string[] | null = null;
    const verify = (attribution as Record<string, unknown>).verifyTx ?? (attribution as Record<string, unknown>).decodeDataSuffix;
    if (typeof verify === "function") {
      try {
        const result = await (verify as (a: unknown) => unknown)({ data: tx.input });
        const found = (result as { codes?: string[] })?.codes ?? result;
        if (Array.isArray(found)) codes = found as string[];
      } catch {
        codes = null;
      }
    }

    const present = codes ? codes.includes(tag) : tx.input.toLowerCase().includes(Buffer.from(tag).toString("hex"));
    console.log(`${hash.slice(0, 18)}...  ${present ? "TAGGED" : "NOT TAGGED"}${codes ? `  codes: ${codes.join(", ")}` : "  (decoded by hex match)"}`);
    if (!present) missing++;
  }

  if (missing) {
    console.log(`\n${missing} transaction(s) are not carrying the tag. Those are permanently uncounted.`);
    process.exit(1);
  }
  console.log("\nevery transaction checked carries the registered tag");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
