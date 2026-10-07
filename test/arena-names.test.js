// The rules for Arena profiles (app/verify/arena-names.js): shared by the MCP,
// the relayer and the indexer, so all three agree on what a name may say.
import { test } from "node:test";
import assert from "node:assert/strict";

import { checkProfile, profileForDisplay, isReservedName, linkDomain, cleanProfileText, foldName } from "../app/verify/arena-names.js";

test("a good profile comes back cleaned, with the link made https", () => {
  const r = checkProfile({ name: "  Midnight   Momentum ", bio: "Breakouts\non majors", link: "x.com/midnight" });
  assert.deepEqual(r, { ok: true, profile: { name: "Midnight Momentum", bio: "Breakouts on majors", link: "https://x.com/midnight" } });
});

test("an empty name clears the whole profile", () => {
  assert.deepEqual(checkProfile({ name: " ", bio: "ignored" }), { ok: true, profile: { name: "", bio: "", link: "" } });
});

test("names: 3 to 32 characters, at most 32 bytes, with a letter or digit", () => {
  assert.equal(checkProfile({ name: "ab" }).ok, false);
  assert.equal(checkProfile({ name: "abc" }).ok, true);
  assert.equal(checkProfile({ name: "a".repeat(32) }).ok, true);
  assert.equal(checkProfile({ name: "a".repeat(33) }).ok, false);
  assert.equal(checkProfile({ name: "é".repeat(17) }).ok, false); // 17 characters, 34 bytes
  assert.equal(checkProfile({ name: "🚀🚀🚀" }).ok, false); // no letter or digit
  assert.equal(checkProfile({ name: "Moon 🚀" }).ok, true);
});

test("invisible and bidi characters can't hide inside a name", () => {
  assert.equal(cleanProfileText("Mid​night‮"), "Mid night");
  assert.equal(checkProfile({ name: "​​​" }).profile.name, ""); // nothing left: a clear, not a blank name
  assert.equal(cleanProfileText("ｆｕｌｌ"), "full"); // NFKC folds full-width letters
  assert.equal(cleanProfileText("ab⠀c"), "ab c"); // the Braille blank is a space, not a letter
});

test("our names and look-alikes are reserved", () => {
  for (const n of ["Reins", "R3INS", "reins official", "OnReins Bot", "Arena", "ARENA", "Hot list", "hot-list", "H0t L1st", "Coin flip", "Cold list", "Official picks", "Admin"]) {
    assert.equal(isReservedName(n), true, n);
    assert.equal(checkProfile({ name: n }).ok, false, n);
  }
  for (const n of ["Arena King", "Hot takes", "Midnight", "Listless"]) assert.equal(isReservedName(n), false, n);
  // Cyrillic and Greek look-alikes, and "Arena" with a staff word, read as ours too.
  for (const n of ["Rеins", "RеіnѕBot", "Αrеna", "Arena Support", "Team Arena", "Arena Admin", "Arena Mod"]) assert.equal(isReservedName(n), true, n);
  assert.equal(foldName("H0t-L1st!"), foldName("hot list"));
  assert.equal(isReservedName("RElNS"), true); // a capital I or a lowercase l for the i
});

test("links: https only, no credentials, at most 100 bytes", () => {
  assert.equal(checkProfile({ name: "abc", link: "http://x.com" }).ok, false);
  assert.equal(checkProfile({ name: "abc", link: "javascript:alert(1)" }).ok, false);
  assert.equal(checkProfile({ name: "abc", link: "https://user:pw@x.com" }).ok, false);
  assert.equal(checkProfile({ name: "abc", link: "localhost" }).ok, false);
  assert.equal(checkProfile({ name: "abc", link: `https://x.com/${"a".repeat(90)}` }).ok, false);
  assert.equal(linkDomain("https://www.x.com/abc?q=1"), "x.com");
  assert.equal(linkDomain("ftp://x.com"), null);
});

test("bios: at most 160 bytes", () => {
  assert.equal(checkProfile({ name: "abc", bio: "b".repeat(160) }).ok, true);
  assert.equal(checkProfile({ name: "abc", bio: "b".repeat(161) }).ok, false);
});

test("for display, a bad name hides the profile and a bad link or bio is just dropped", () => {
  assert.equal(profileForDisplay(null), null);
  assert.equal(profileForDisplay({ name: "", bio: "x", link: "" }), null);
  assert.equal(profileForDisplay({ name: "R3ins", bio: "", link: "" }), null);
  assert.deepEqual(profileForDisplay({ name: "Midnight", bio: "hi", link: "https://x.com/m" }), { name: "Midnight", bio: "hi", link: "https://x.com/m", domain: "x.com" });
  assert.deepEqual(profileForDisplay({ name: "Midnight", bio: "", link: "javascript:alert(1)" }), { name: "Midnight", bio: null, link: null, domain: null });
});
