/**
 * Builds the publishable Reins MCP package (@onreins/mcp) in packages/reins-mcp/:
 *
 *   npm run build:reins-mcp
 *
 * One self-contained file (dist/onreins-mcp.mjs) with every dependency
 * bundled, so `npx -y @onreins/mcp` runs with nothing else to install. The
 * deployed contract addresses (deployments/callbook-<network>.json, when
 * present) are written into the bundle, so users don't need CALLBOOK_ADDRESS.
 *
 * `--release` (what `npm publish` runs) refuses to build without a testnet or
 * mainnet deployment: a package without one would fail on every network. The
 * package runs on mainnet once it carries a mainnet address, else on testnet.
 */
import { build } from "esbuild";
import { existsSync, readFileSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG = path.join(ROOT, "packages", "reins-mcp");
const OUT = path.join(PKG, "dist", "onreins-mcp.mjs");
const VERSION = JSON.parse(readFileSync(path.join(PKG, "package.json"), "utf8")).version;

// Whatever is deployed now goes in the bundle.
const deployments = {};
for (const net of ["testnet", "mainnet"]) {
  const file = path.join(ROOT, "deployments", `callbook-${net}.json`);
  if (!existsSync(file)) continue;
  // Only these public fields ship in the npm package, whatever else the record holds.
  const d = JSON.parse(readFileSync(file, "utf8"));
  deployments[net] = Object.fromEntries(["network", "chainId", "contracts", "fromBlock", "external", "validator"].filter((k) => d[k] !== undefined).map((k) => [k, d[k]]));
}
if (process.argv.includes("--release") && !deployments.testnet && !deployments.mainnet) {
  console.error("No deployments/callbook-testnet.json or callbook-mainnet.json: deploy Callbook before publishing (docs/CALLBOOK-RUNBOOK.md).");
  process.exit(1);
}

// scripts/artifact.js reads build/<name>.json at run time; the package has no
// build/, so the bundle gets the ABIs it needs written in instead.
const ARTIFACTS = ["Callbook"];
const embedArtifacts = {
  name: "embed-artifacts",
  setup(b) {
    b.onLoad({ filter: /[\\/]scripts[\\/]artifact\.js$/ }, () => {
      const missing = ARTIFACTS.filter((n) => !existsSync(path.join(ROOT, "build", `${n}.json`)));
      if (missing.length) return { errors: [{ text: `build/${missing[0]}.json is missing: run npm run build first` }] };
      const abis = Object.fromEntries(ARTIFACTS.map((n) => [n, { abi: JSON.parse(readFileSync(path.join(ROOT, "build", `${n}.json`), "utf8")).abi }]));
      return {
        loader: "js",
        contents: `const A = ${JSON.stringify(abis)};
export function artifact(name) {
  if (!A[name]) throw new Error("artifact " + name + " is not in the @onreins/mcp bundle");
  return A[name];
}`,
      };
    });
  },
};

mkdirSync(path.dirname(OUT), { recursive: true });
const result = await build({
  plugins: [embedArtifacts],
  entryPoints: [path.join(ROOT, "callbook", "mcp-server.js")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: OUT,
  minify: true,
  legalComments: "eof",
  metafile: true,
  // `require` for bundled CommonJS, and the package's own settings (the entry keeps its shebang).
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
      "globalThis.__CALLBOOK_PACKAGED__ = true;",
      `globalThis.__CALLBOOK_MCP_VERSION__ = ${JSON.stringify(VERSION)};`,
      `globalThis.__CALLBOOK_DEPLOYMENTS__ = ${JSON.stringify(deployments)};`,
    ].join("\n"),
  },
});

// The scoring is ported from Vanta Network (MIT): its notice ships with the package.
copyFileSync(path.join(ROOT, "app", "verify", "NOTICE"), path.join(PKG, "NOTICE"));

const kb = (Object.values(result.metafile.outputs)[0].bytes / 1024).toFixed(0);
const nets = Object.keys(deployments);
console.log(`packages/reins-mcp/dist/onreins-mcp.mjs ${kb} KB` + (nets.length ? `, with ${nets.join(" + ")} addresses, runs on ${deployments.mainnet ? "mainnet" : "testnet"} by default` : ", no deployments yet (users set CALLBOOK_ADDRESS)"));
