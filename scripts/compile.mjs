import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const solc = require("solc");

const CONTRACTS = [
  { file: "Circles.sol", name: "Circles" },
  { file: "Payout.sol", name: "Payout" },
  // Test fixtures. Compiled so the local suite can run, never deployed.
  { file: "mocks/Mocks.sol", name: "MockERC20" },
  { file: "mocks/Mocks.sol", name: "LyingERC20" },
  { file: "mocks/Mocks.sol", name: "MockBroker" },
];

const sources = Object.fromEntries(
  [...new Set(CONTRACTS.map((c) => c.file))].map((file) => [
    file,
    { content: readFileSync(new URL(`../contracts/${file}`, import.meta.url), "utf8") },
  ]),
);

const out = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources,
      settings: {
        optimizer: { enabled: true, runs: 200 },
        evmVersion: "paris",
        outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
      },
    }),
  ),
);

for (const e of out.errors ?? []) console.log(`${e.severity}: ${e.formattedMessage.trim()}`);
if ((out.errors ?? []).some((e) => e.severity === "error")) process.exit(1);

mkdirSync(new URL("../artifacts/", import.meta.url), { recursive: true });

for (const { file, name } of CONTRACTS) {
  const c = out.contracts[file][name];
  writeFileSync(
    new URL(`../artifacts/${name}.json`, import.meta.url),
    JSON.stringify({ abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` }, null, 2),
  );
  console.log(`${name}: ${c.evm.bytecode.object.length / 2} bytes`);
}

console.log(`solc ${solc.version()}`);
