
/**
 * The tanstack-query key registry: the single source of truth for the query
 * keys the webapp caches under and the invalidation actions the API
 * broadcasts. Invalidations constantly cross collection boundaries (an
 * allocation write invalidates transaction-group queries; a finalization
 * touches nearly everything), so key literals must never be inlined in a
 * controller -- always compose from here.
 *
 * This file is ESM (.mjs) because it is SHARED with the webapp: the CJS
 * server require()s it (Node >= 22.12 supports require(esm)) and the webapp
 * imports it (via the src/hooks/queryKeys.js shim), so the keys the webapp
 * caches under and the keys the server invalidates can never drift. Keep it
 * runtime-agnostic: no node builtins, no requires of server code.
 *
 * Conventions:
 * - list key = plural resource name; single = singular + STRINGIFIED id
 *   (tanstack matches by prefix, so ["fund", "3"] also catches any
 *   ["fund", "3", ...] subkeys the webapp hangs off it)
 * - computed subresources get their own top-level key (fund-balance) so hot
 *   invalidation (every transaction write) doesn't force refetching cold
 *   data (the fund objects themselves)
 * - list controllers may document a parameterized shape (the webapp appends
 *   its filter object: ["allocations", { month }]) -- invalidating the bare
 *   list key catches all of them
 * - when in doubt, over-invalidate
 */
export const QK = {
    versions: ["versions"],

    funds: ["funds"],
    fund: (id) => ["fund", id.toString()],
    fund_balances: ["fund-balance"],
    fund_balance: (id) => ["fund-balance", id.toString()],

    transaction_groups: ["transaction-groups"],
    transaction_group: (id) => ["transaction-group", id.toString()],
    transactions: ["transactions"],
    transaction: (id) => ["transaction", id.toString()],

    statements: ["statements"],
    statement: (id) => ["statement", id.toString()],

    allocations: ["allocations"],

    month_finalizations: ["month-finalizations"],
    month_finalization: (id) => ["month-finalization", id.toString()],
    fund_finalizations: ["fund-finalizations"],
    fund_finalization: (id) => ["fund-finalization", id.toString()],

    users: ["users"],
    // User keys are deliberately id-scoped with NO viewer-relative
    // ["me", ...] variants (and the API has no /me routes to want them):
    // invalidations are broadcast to EVERY connected client, and a
    // viewer-relative key would spuriously invalidate every other user's
    // self-view cache. The webapp keys its self views by its own user id
    // (known from the login/authenticate response).
    user: (id) => ["user", id.toString()],
    user_sessions: (id) => ["user", id.toString(), "sessions"],
    user_api_keys: (id) => ["user", id.toString(), "api-keys"],
};

export const invalidate = (key) => ({ type: "invalidate", key });
export const remove = (key) => ({ type: "remove", key });

/**
 * Every write that adds/removes/moves transactions changes computed balances
 * and the transaction/group lists -- the shared "money moved" action set.
 */
export const money_moved = () => [
    invalidate(QK.transaction_groups),
    invalidate(QK.transactions),
    invalidate(QK.fund_balances),
];
