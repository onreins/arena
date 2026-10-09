/**
 * Arena's web server: the Arena pages, the Arena API (app/callbook-routes.js:
 * the board, every record, gasless relays), and clean addresses.
 *
 *   npm start                       # http://localhost:4100
 *   ARENA_NETWORK=testnet npm start # read the live testnet contract
 *
 * Without ARENA_NETWORK the API isn't mounted and the pages show the replay
 * export in app/public/data/ (made by `npm run arena:replay`). The pages share
 * Reins's app chrome; links to other Reins pages go to app.reins.one.
 */
import express from "express";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { mountCallbook } from "./callbook-routes.js";
import { mountAuth } from "./arena-auth-routes.js";
import { arenaEnv } from "./verify/callbook-network.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, "public");
const REINS = "https://app.reins.one";
const PORT = Number(process.env.PORT ?? 4100);

export function createApp(env = process.env) {
  const app = express();
  app.disable("x-powered-by");
  const trustProxy = env.TRUST_PROXY ?? (env.VERCEL ? "1" : undefined);
  if (trustProxy) app.set("trust proxy", /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
  app.use(express.json({ limit: "64kb" }));

  // The wallet button asks which chain to offer.
  const network = arenaEnv(env).CALLBOOK_NETWORK || "testnet";
  const record = path.join(here, "..", "deployments", `callbook-${network}.json`);
  const dep = existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) : { network, chainId: network === "mainnet" ? 5042 : 5042002 };
  app.get("/api/config", (_req, res) => res.json({
    network: dep.network ?? network, chainId: dep.chainId,
    explorer: network === "mainnet" ? "https://explorer.arc.io" : "https://explorer.testnet.arc.io",
    contracts: dep.contracts ?? {}, tokens: {},
  }));

  mountCallbook(app, { env });
  // Google sign-in through Circle wallets (off until CIRCLE_API_KEY, CIRCLE_APP_ID and GOOGLE_CLIENT_ID are set).
  mountAuth(app, { env });

  app.get("/", (_req, res) => res.redirect(302, "/arena"));
  // Clean addresses: /arena serves arena.html, and /arena.html redirects there.
  app.get(/^\/([\w-]+)\.html$/, (req, res) => {
    const q = req.url.indexOf("?");
    res.redirect(308, "/" + req.params[0] + (q >= 0 ? req.url.slice(q) : ""));
  });
  // A person's profile: /arena/p/<address> is one page that reads the address itself.
  app.get(/^\/arena\/p\/[^/]+\/?$/, (_req, res) => res.sendFile(path.join(pub, "arena-profile.html")));
  // Confirming an agent's request to link to your wallet (made by the MCP's arena_link_wallet).
  app.get(/^\/arena\/link\/?$/, (_req, res) => res.sendFile(path.join(pub, "arena-link.html")));
  app.get(/^\/([\w-]+)$/, (req, res, next) => {
    const page = path.join(pub, `${req.params[0]}.html`);
    if (existsSync(page)) res.sendFile(page);
    else next();
  });
  app.use(express.static(pub, { extensions: ["html"] }));
  // Anything else is a page of the wider Reins app.
  app.get(/^\/(?!api\/)/, (req, res) => res.redirect(302, REINS + req.originalUrl));
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createApp().listen(PORT, () => console.log(`Arena on http://localhost:${PORT}`));
}
