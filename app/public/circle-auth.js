/**
 * Google sign-in with a Circle wallet on Arc, for auth.js. Loaded only when
 * someone picks "Continue with Google" (or comes back from Google's page).
 *
 *   signIn(cfg)            get a device token, then go to Google (the page leaves)
 *   resume()               back from Google: finish the login, create or find the
 *                          person's Arena wallet; resolves { address, walletId } or null
 *   signTypedData(s, t)    an EIP-712 signature through Circle's confirmation screen
 *   forget()               drop this tab's Circle login
 *
 * The Circle login (userToken, encryptionKey) lives in sessionStorage for this
 * tab only; it expires on Circle's side, and signing asks to sign in again.
 */
window.ReinsCircle = (function () {
  "use strict";
  var PENDING = "reins.circle.pending";
  var LOGIN = "reins.circle.login";
  var sdkLoad = null;

  function load() {
    if (window.ReinsCircleSdk) return Promise.resolve(window.ReinsCircleSdk);
    sdkLoad = sdkLoad || new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "/vendor/circle-wallets.js";
      s.onload = function () { resolve(window.ReinsCircleSdk); };
      s.onerror = function () { sdkLoad = null; reject(new Error("Google sign-in couldn't load. Try again.")); };
      document.head.appendChild(s);
    });
    return sdkLoad;
  }
  async function post(path, body) {
    var res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    var out = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(out.error || "Google sign-in failed. Try again.");
    return out;
  }
  var get = function (k) { try { return JSON.parse(sessionStorage.getItem(k) || "null"); } catch (e) { return null; } };
  var put = function (k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage off */ } };
  var drop = function (k) { try { sessionStorage.removeItem(k); } catch (e) { /* storage off */ } };

  function sdkFor(C, cfg, device, onLogin) {
    return new C.W3SSdk({
      appSettings: { appId: cfg.circleAppId },
      loginConfigs: {
        deviceToken: device.deviceToken,
        deviceEncryptionKey: device.deviceEncryptionKey,
        google: { clientId: cfg.googleClientId, redirectUri: location.origin + "/arena", selectAccountPrompt: true },
      },
    }, onLogin);
  }
  /** Run a Circle challenge (create a wallet, sign) with the person's confirmation. */
  function execute(sdk, login, challengeId) {
    sdk.setAuthentication({ userToken: login.userToken, encryptionKey: login.encryptionKey });
    return new Promise(function (resolve, reject) {
      sdk.execute(challengeId, function (err, result) {
        if (err) reject(new Error(err.message || "Circle didn't confirm that."));
        else resolve(result);
      });
    });
  }

  async function signIn(cfg) {
    if (!cfg || !cfg.google) throw new Error("Google sign-in isn't set up here yet.");
    var C = await load();
    var probe = new C.W3SSdk({ appSettings: { appId: cfg.circleAppId } });
    var deviceId = await probe.getDeviceId();
    var device = await post("/api/auth/circle/device", { deviceId: deviceId });
    put(PENDING, { cfg: cfg, device: device, back: location.pathname + location.search });
    var sdk = sdkFor(C, cfg, device, function () {});
    sdk.performLogin(C.SocialLoginProvider.GOOGLE); // leaves for Google; resume() finishes on the way back
    return null;
  }

  async function resume() {
    var pending = get(PENDING);
    if (!pending) return null;
    var C = await load();
    var login = await new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error("Google sign-in didn't finish. Try again.")); }, 30000);
      sdkFor(C, pending.cfg, pending.device, function (err, result) {
        clearTimeout(timer);
        if (err || !result || !result.userToken) reject(new Error((err && err.message) || "Google sign-in was cancelled."));
        else resolve({ userToken: result.userToken, encryptionKey: result.encryptionKey });
      });
    }).finally(function () { drop(PENDING); });
    put(LOGIN, login);
    var w = await post("/api/auth/circle/wallet", { userToken: login.userToken });
    if (w.challengeId) {
      // First sign-in: Circle creates the Arena wallet once the person confirms.
      await execute(sdkFor(C, pending.cfg, pending.device, function () {}), login, w.challengeId);
      w = await post("/api/auth/circle/wallet", { userToken: login.userToken });
    }
    if (!w.address) throw new Error("Circle didn't return a wallet. Try signing in again.");
    put(LOGIN, Object.assign({}, login, { walletId: w.walletId, cfg: pending.cfg, device: pending.device }));
    if (pending.back && pending.back !== location.pathname + location.search) location.replace(pending.back);
    return { address: w.address, walletId: w.walletId };
  }

  async function signTypedData(s, typed) {
    var login = get(LOGIN);
    if (!login || !login.userToken || !login.walletId) throw new Error("Your Google sign-in has expired. Sign out, then sign in with Google again.");
    var C = await load();
    var ch = await post("/api/auth/circle/sign", { userToken: login.userToken, walletId: login.walletId, typedData: typed });
    var result = await execute(sdkFor(C, login.cfg, login.device, function () {}), login, ch.challengeId);
    var sig = result && result.data && result.data.signature;
    if (!/^0x[0-9a-fA-F]{130}$/.test(sig || "")) throw new Error("Circle didn't return a signature.");
    return sig;
  }

  /** True while this tab holds a Circle login (it doesn't survive a new tab). */
  function hasLogin() { var l = get(LOGIN); return !!(l && l.userToken && l.walletId); }

  return { signIn: signIn, resume: resume, signTypedData: signTypedData, hasLogin: hasLogin, forget: function () { drop(LOGIN); drop(PENDING); } };
})();
