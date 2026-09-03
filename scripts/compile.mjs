import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Two compilers on purpose. Circles and Payout are already deployed from
 * 0.8.36, and recompiling them under a different version would change the
 * bytecode and break source verification on Celoscan. Personhood cannot use
 * 0.8.36 because Self's contracts pin 0.8.28 exactly.
 */
const COMPILERS = {
  "0.8.36": require("solc"),
  "0.8.28": require("solc-0828"),
};

const GROUPS = [
  {
    solc: "0.8.36",
    contracts: [
      { file: "Circles.sol", name: "Circles" },
      { file: "Payout.sol", name: "Payout" },
      // Test fixtures. Compiled so the local suite can run, never deployed.
      { file: "mocks/Mocks.sol", name: "MockERC20" },
      { file: "mocks/Mocks.sol", name: "LyingERC20" },
      { file: "mocks/Mocks.sol", name: "MockBroker" },
    ],
  },
  {
    solc: "0.8.28",
    contracts: [{ file: "Personhood.sol", name: "Personhood" }],
  },
];

// solc has no filesystem of its own, so anything a contract imports rather than
// something listed above is resolved here. Personhood pulls in Self's
// contracts, which pull in OpenZeppelin.
function resolveImport(path) {
  const roots = [
    new URL("../node_modules/", import.meta.url),
    new URL("../contracts/", import.meta.url),
  ];
  for (const root of roots) {
    try {
      return { contents: readFileSync(new URL(path, root), "utf8") };
    } catch {
      // try the next root
    }
  }
  return { error: `not found: ${path}` };
}

mkdirSync(new URL("../artifacts/", import.meta.url), { recursive: true });

for (const group of GROUPS) {
  const solc = COMPILERS[group.solc];
  const sources = Object.fromEntries(
    [...new Set(group.contracts.map((c) => c.file))].map((file) => [
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
      { import: resolveImport },
    ),
  );

  for (const e of out.errors ?? []) {
    if (e.severity === "error") console.log(`error: ${e.formattedMessage.trim()}`);
  }
  if ((out.errors ?? []).some((e) => e.severity === "error")) process.exit(1);

  for (const { file, name } of group.contracts) {
    const c = out.contracts[file][name];
    writeFileSync(
      new URL(`../artifacts/${name}.json`, import.meta.url),
      JSON.stringify(
        { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}`, solc: solc.version() },
        null,
        2,
      ),
    );
    console.log(`${name.padEnd(12)} ${c.evm.bytecode.object.length / 2} bytes   solc ${group.solc}`);
  }
}
