import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const solc = require("solc");

const name = "Circles.sol";
const source = readFileSync(new URL(`../contracts/${name}`, import.meta.url), "utf8");

const input = {
  language: "Solidity",
  sources: { [name]: { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "paris",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));

const errors = (out.errors ?? []).filter((e) => e.severity === "error");
for (const e of out.errors ?? []) console.log(`${e.severity}: ${e.formattedMessage.trim()}`);
if (errors.length) process.exit(1);

const contract = out.contracts[name].Circles;
mkdirSync(new URL("../artifacts/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("../artifacts/Circles.json", import.meta.url),
  JSON.stringify({ abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` }, null, 2),
);

console.log(`compiled, bytecode ${contract.evm.bytecode.object.length / 2} bytes`);
console.log(`solc ${solc.version()}`);
