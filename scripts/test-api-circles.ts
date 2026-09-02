// Drives the full circle loop against a running server and Celo mainnet:
// the API builds a transaction, the wallet signs it, the API reads it back.
//   npm run test:api -- http://localhost:3200

import { account, feeParams, publicClient, walletClient } from "../src/chain.js";
import { NGNM } from "../src/config.js";

let passed = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  pass" : "  FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  ok ? passed++ : failed++;
};

async function main() {
  const base = (process.argv[2] ?? "http://localhost:3200").replace(/\/$/, "");
  const me = account().address;
  const wallet = walletClient();

  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j;
  };
  const get = async (path: string) => {
    const r = await fetch(`${base}${path}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j;
  };

  const sign = async (tx: { to: string; data: string; gas: string }) => {
    const hash = await wallet.sendTransaction({
      to: tx.to as `0x${string}`,
      data: tx.data as `0x${string}`,
      account: account(),
      chain: wallet.chain,
      ...(await feeParams(NGNM, BigInt(tx.gas))),
    } as Parameters<typeof wallet.sendTransaction>[0]);
    const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (r.status !== "success") throw new Error("transaction reverted");
    return r;
  };

  console.log(`server ${base}`);
  console.log(`wallet ${me}\n`);

  console.log("validation");
  for (const [label, body] of [
    ["rejects bad organiser", { organiser: "nope", name: "X", amount: "100", interval: 3600 }],
    ["rejects empty name", { organiser: me, name: "  ", amount: "100", interval: 3600 }],
    ["rejects zero amount", { organiser: me, name: "X", amount: "0", interval: 3600 }],
    ["rejects short interval", { organiser: me, name: "X", amount: "100", interval: 10 }],
  ] as const) {
    try {
      await post("/v1/circles/build", body);
      check(label, false, "was accepted");
    } catch {
      check(label, true);
    }
  }

  console.log("\ncreate onchain");
  const built = await post("/v1/circles/build", {
    organiser: me,
    name: "Kobo live circle",
    amount: "500",
    interval: 3600,
  });
  check("build returns an id and a transaction", Boolean(built.id && built.transaction));

  const receipt = await sign(built.transaction);
  check("create mined", receipt.status === "success", built.id);

  console.log("\nread it back from the chain");
  const c = await get(`/v1/circles/${built.id}`);
  check("organiser matches", c.organiser.toLowerCase() === me.toLowerCase());
  check("amount round-trips", c.amount === "500");
  check("interval round-trips", c.interval === 3600);
  check("not started", c.started === false);
  check("organiser is a member", c.members.length === 1);
  check("name came from the event", c.members[0]?.name === "Kobo live circle");
  check("standings computed", Array.isArray(c.standings) && c.standings.length === 1);

  console.log("\nguards");
  try {
    await post(`/v1/circles/${built.id}/build/start`, {});
    check("start with one member refused", false, "was allowed");
  } catch (e) {
    check("start with one member refused", true, (e as Error).message);
  }

  const dues = await get(`/v1/circles/${built.id}/dues/${me}`);
  check("no dues before start", dues.owed === false);
  check("no payment tx before start", dues.transaction === null);

  try {
    await get(`/v1/circles/0x${"11".repeat(32)}`);
    check("unknown circle 404s", false, "was found");
  } catch {
    check("unknown circle 404s", true);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(`circle ${built.id}`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
