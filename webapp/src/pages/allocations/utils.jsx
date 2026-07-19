import dayjs from 'dayjs';

/**
 * Pure derivations for the allocations grid page: the month window and
 * row-level fund facts (flattened hierarchy, allocation eligibility).
 */

/**
 * Every month from `oldestSom` to `newestSom` (both inclusive), oldest first,
 * each as its first-of-month YYYY-MM-DD string (the shape the allocation APIs
 * want). The strip grows on BOTH edges, so the window is bounded by its two
 * ends rather than an end + a count.
 */
export function monthRange(oldestSom, newestSom) {
    const end = dayjs(newestSom).startOf('month');
    const out = [];
    let cur = dayjs(oldestSom).startOf('month');
    while ( !cur.isAfter(end) ) {
        out.push(cur.format('YYYY-MM-01'));
        cur = cur.add(1, 'month');
    }
    return out;
}

/**
 * Flatten the fund tree (components/domain.js buildFundTree) into the
 * rendered row list -- parents before children, siblings by name -- each
 * `{ fund, depth }` (depth drives the indent).
 */
export function fundRowsOf(roots) {
    const out = [];
    const walk = (node) => {
        out.push({ fund: node.fund, depth: node.depth });
        node.children.forEach(walk);
    };
    roots.forEach(walk);
    return out;
}

/**
 * The fund's nearest POOL ancestor (the fund its allocations draw from), or
 * null when it has none. `byId` is a Map of ALL funds by id.
 */
export function nearestPoolAncestorOf(fund, byId) {
    let pid = fund.parent_id;
    while ( pid != null ) {
        const parent = byId.get(pid);
        if ( parent == null ) return null;
        if ( parent.status.pool ) return parent;
        pid = parent.parent_id;
    }
    return null;
}

/**
 * Whether the server would accept an allocation for this fund in the month
 * starting at `som`: the fund is tracked, not deprecated (deprecated funds
 * are frozen -- no new allocations in ANY month), and started by the first
 * of the month, and its nearest pool ancestor has also started. (Mirrors the
 * model checks so ineligible cells render inert instead of collecting 409s.)
 */
export function canAllocate(fund, poolAncestor, som) {
    return fund.status.tracked
        && fund.deprecated == null
        && fund.start != null && fund.start.date <= som
        && poolAncestor != null
        && poolAncestor.start != null && poolAncestor.start.date <= som;
}
