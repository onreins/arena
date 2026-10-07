/**
 * Compiles contracts/*.sol with solc and writes build/<Name>.json ({ abi, bytecode }).
 * No framework: solc is the only thing that actually has to run here.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const solc = require("solc");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contractsDir = join(root, "contracts");
const buildDir = join(root, "build");

const sources = {};
for (const file of readdirSync(contractsDir).filter((f) => f.endsWith(".sol"))) {
  sources[file] = { content: readFileSync(join(contractsDir, file), "utf8") };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 1_000_000 },
    // Arc runs the Osaka hard fork; solc 0.8.28 tops out at cancun, which is a
    // strict subset, so the output is valid on Arc.
    evmVersion: "cancun",
    outputSelection: {
      "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.gasEstimates"] },
    },
  },
};

/**
 * Resolve library imports (e.g. "@redstone-finance/evm-connector/...") from
 * node_modules. Some packages export no .sol paths, so require.resolve refuses
 * them; read those straight from node_modules.
 */
function findImports(path) {
  for (const file of [() => require.resolve(path), () => join(root, "node_modules", path)]) {
    try {
      return { contents: readFileSync(file(), "utf8") };
    } catch {
      // try the next way
    }
  }
  return { error: `import not found: ${path}` };
}

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

const errors = (output.errors ?? []).filter((e) => e.severity === "error");
const warnings = (output.errors ?? []).filter((e) => e.severity === "warning");

for (const w of warnings) console.warn(`warning: ${w.formattedMessage.trim()}`);
if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage);
  process.exit(1);
}

mkdirSync(buildDir, { recursive: true });
let count = 0;
for (const [file, contracts] of Object.entries(output.contracts ?? {})) {
  if (!sources[file]) continue; // a library's own contracts: compiled in, not written out
  for (const [name, c] of Object.entries(contracts)) {
    writeFileSync(
      join(buildDir, `${name}.json`),
      JSON.stringify(
        {
          abi: c.abi,
          bytecode: `0x${c.evm.bytecode.object}`,
          // Runtime code, for injecting a contract into a simulated call.
          deployedBytecode: `0x${c.evm.deployedBytecode.object}`,
        },
        null,
        2,
      ),
    );
    const size = c.evm.bytecode.object.length / 2;
    console.log(`compiled ${name} (${file}) — ${size} bytes of bytecode`);
    count++;
  }
}
console.log(`\n${count} contract(s) compiled, ${warnings.length} warning(s).`);
