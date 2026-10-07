/**
 * Strict command-line flags for the Callbook scripts: a typo like
 * `--dryrun` must stop the script, not quietly run it for real.
 *
 *   const { get, has, problems } = parseFlags(argv, { values: ["--network"], booleans: ["--dry-run", "--yes"] });
 *
 * Value flags take `--name value` or `--name=value`. Anything not declared,
 * and any bare word, is reported in `problems`.
 */
export function parseFlags(argv, { values = [], booleans = [] } = {}) {
  const got = new Map();
  const problems = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      problems.push(`unexpected argument "${arg}"`);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (booleans.includes(name)) {
      if (eq !== -1) problems.push(`${name} takes no value`);
      got.set(name, true);
    } else if (values.includes(name)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value == null || value === "" || (eq === -1 && value.startsWith("--"))) problems.push(`${name} needs a value`);
      else got.set(name, value);
    } else {
      problems.push(`unknown flag ${name} (known: ${[...values, ...booleans].join(", ")})`);
    }
  }
  return { get: (name) => got.get(name), has: (name) => got.get(name) === true, problems };
}

/** A real mainnet run needs --yes; a dry run never does. Returns a problem sentence or null. */
export function mainnetConfirmation({ network, dryRun, yes }) {
  if (network !== "mainnet" || dryRun || yes) return null;
  return "this sends real transactions on Arc mainnet: run with --dry-run first, then again with --yes";
}
