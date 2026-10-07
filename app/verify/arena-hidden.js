/**
 * Profiles the site won't show. A name on chain can't be erased, only left
 * unshown: a record listed here falls back to its short address. Use it for
 * abuse or impersonation the name rules (arena-names.js) didn't catch, and say
 * why in a comment. See docs/CALLBOOK-RUNBOOK.md, "Hiding a name".
 *
 *   accounts  lowercase addresses: every profile they set, person and books
 *   books     "chainId:callbook:bookId" (callbook lowercase): one record's name
 */
export const HIDDEN_PROFILES = Object.freeze({
  accounts: [],
  books: [],
});
