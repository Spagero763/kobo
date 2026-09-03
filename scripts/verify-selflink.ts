// Kobo builds Self's deeplink itself rather than importing a package that opens
// a websocket in a serverless function. This proves the hand-built payload is
// identical to what the official builder produces, so "convenient" and "correct"
// stay the same thing.
//   npm run verify:selflink

import { createRequire } from "node:module";
import { buildLink } from "../src/personhood.js";
import { PERSONHOOD, SELF_SCOPE_SEED } from "../src/config.js";

// The package chain imports JSON without an import attribute, which Node's ESM
// loader refuses outright.
const require = createRequire(import.meta.url);
const { SelfAppBuilder } = require("@selfxyz/qrcode");
const { getUniversalLink } = require("@selfxyz/common");

const USER = "0xE23c44Dd4a51456786c6681cFE928AAcfa00d619";

function payloadOf(link: string): Record<string, unknown> {
  const app = new URL(link).searchParams.get("selfApp");
  if (!app) throw new Error("no selfApp parameter in the link");
  return JSON.parse(app);
}

async function main() {
  if (!PERSONHOOD) throw new Error("PERSONHOOD is not set in .env");

  const official = payloadOf(
    getUniversalLink(
      new SelfAppBuilder({
        version: 2,
        appName: "Kobo",
        scope: SELF_SCOPE_SEED,
        endpoint: PERSONHOOD,
        endpointType: "celo",
        userId: USER,
        userIdType: "hex",
        userDefinedData: "",
        disclosures: { minimumAge: 18 },
      }).build(),
    ),
  );

  const ours = payloadOf(buildLink(USER).link);

  // A session id is random by design, so it is compared for shape only.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  let failed = 0;

  if (!uuid.test(String(ours.sessionId))) {
    console.log("  FAIL  sessionId is not a uuid");
    failed++;
  } else {
    console.log("  pass  sessionId is a uuid");
  }

  const keys = [...new Set([...Object.keys(official), ...Object.keys(ours)])].filter((k) => k !== "sessionId");
  for (const key of keys.sort()) {
    const a = JSON.stringify(official[key]);
    const b = JSON.stringify(ours[key]);
    if (a === b) {
      console.log(`  pass  ${key} = ${a}`);
    } else {
      console.log(`  FAIL  ${key}: official ${a}, ours ${b}`);
      failed++;
    }
  }

  if (failed) {
    console.log(`\n${failed} difference(s). The hand-built link would be rejected by the app.`);
    process.exit(1);
  }
  console.log("\nthe hand-built link matches the official builder exactly");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
