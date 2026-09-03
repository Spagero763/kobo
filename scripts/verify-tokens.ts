// Checks the token registry against the chain. Six decimals against eighteen is
// a factor of a trillion, and a wrong constant does not throw, it sends the
// wrong amount.
//   npm run verify:tokens

import { canPayGasWith } from "../src/chain.js";
import { TOKENS, verifyTokens } from "../src/tokens.js";

async function main() {
  const results = await verifyTokens();
  let bad = 0;

  for (const r of results) {
    const t = TOKENS[r.symbol];
    const gas = await canPayGasWith(t.address);
    const mark = r.ok ? "ok  " : "WRONG";
    console.log(
      `${mark} ${r.symbol.padEnd(6)} ${t.address}  decimals expected ${r.expected}, chain says ${r.actual ?? "unreadable"}  pays own gas: ${gas ? "yes" : "no"}`,
    );
    if (!r.ok) bad++;
  }

  if (bad) {
    console.log(`\n${bad} token(s) have the wrong decimals configured. Do not ship this.`);
    process.exit(1);
  }
  console.log("\nevery token matches the chain");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
