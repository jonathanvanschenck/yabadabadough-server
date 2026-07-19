import dayjs from 'dayjs';

/**
 * Pure derivations for the balances page: the `?on=` permalink value, the
 * flattened hierarchy rows, and their subtree roll-ups.
 */

/**
 * The `?on=` permalink value, or null when it is absent or malformed (the
 * page then falls back to today). Strict on purpose: a half-parsed date
 * would silently show balances for the WRONG day, which looks exactly like a
 * real answer -- the same reasoning that makes `on` a strict query param on
 * the server side of this endpoint.
 *
 * Round-tripping through dayjs rejects real-looking impossibilities
 * ("2026-02-31") without pulling in the strict-parsing plugin.
 */
export function parseOnParam(raw) {
    if ( !/^\d{4}-\d{2}-\d{2}$/.test(raw ?? '') ) return null;
    const parsed = dayjs(raw);
    return parsed.isValid() && parsed.format('YYYY-MM-DD') === raw ? raw : null;
}

/**
 * Flatten the fund tree (components/domain.js buildFundTree) into the
 * rendered row list -- parents before children, siblings by name -- each
 * `{ fund, depth, subtreeIds, hasChildren }`. `depth` drives the indent and
 * `subtreeIds` the roll-up set (the node AND every descendant).
 *
 * `hasChildren` says whether that roll-up is worth rendering: for a leaf it
 * would just restate the fund's own balance one column over.
 */
export function fundRowsOf(roots) {
    const out = [];
    const walk = (node) => {
        out.push({
            fund: node.fund,
            depth: node.depth,
            subtreeIds: node.subtreeIds,
            hasChildren: node.children.length > 0,
        });
        node.children.forEach(walk);
    };
    roots.forEach(walk);
    return out;
}

/**
 * Sum `balancesById` over `ids`, skipping ids it holds no entry for.
 *
 * A tracked fund can legitimately be missing: the balances response omits
 * funds that had not started by the requested date. Skipping keeps the sum a
 * number instead of poisoning it with a NaN, and the omitted fund had no
 * balance to contribute anyway.
 */
export function sumBalances(ids, balancesById) {
    let total = 0;
    for ( const id of ids ) total += balancesById.get(id) ?? 0;
    return total;
}
