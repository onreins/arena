/**
 * The Circle Web SDK (user-controlled wallets: Google sign-in on Arc) for the
 * browser, as one global, ReinsCircleSdk. Built by `npm run build:circle` into
 * app/public/vendor/circle-wallets.js, and loaded by circle-auth.js only when
 * someone picks "Continue with Google".
 *
 * The SDK requires `jsonwebtoken` only to decode a token it was handed (no
 * verification), so the bundle swaps it for scripts/shims/jwt-decode.js.
 */
import { W3SSdk } from "@circle-fin/w3s-pw-web-sdk";
import { SocialLoginProvider, ChallengeType } from "@circle-fin/w3s-pw-web-sdk/dist/src/types";

export { W3SSdk, SocialLoginProvider, ChallengeType };
