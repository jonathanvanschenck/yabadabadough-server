/**
 * Pure derivations over the API's model representations, shared by the
 * icon/badge components (and usable anywhere else). Kept out of the
 * component files so those only export components (react-refresh).
 */

/**
 * Derive a fund's "type" from its status flags (the `status` object on the
 * fund's API representation). The kinds are mutually exclusive: pool and
 * monthly imply tracked, and pool excludes monthly.
 */
export function fundTypeOf(status) {
    if ( !status ) return "unknown";
    if ( status.pool ) return "pool";
    if ( status.monthly ) return "monthly";
    if ( status.tracked ) return "tracked";
    return "untracked";
}

const dollarFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/**
 * Format a float-dollar API amount ("balance", "forward_balance", "amount"
 * fields) for display. Null/undefined render as an em-dash.
 */
export function formatDollars(value) {
    return value == null ? "—" : dollarFormatter.format(value);
}

/**
 * Build the tracked-fund hierarchy tree: one node per TRACKED fund that had
 * started by `startedBy` (a fund that did not exist yet has nothing to
 * show) and -- when `activeSince` is given -- was not deprecated before it
 * (`deprecated` is the fund's LAST ACTIVE day, so a fund deprecated ON
 * `activeSince` still shows). Children nest under their parents; a tracked
 * fund whose parents are all filtered out roots its own subtree -- the
 * effective parent is the nearest ancestor that is itself a node.
 *
 * Returns the list of root nodes; every node is
 * `{ fund, depth, children, subtreeIds }` with `subtreeIds` the fund ids of
 * the node and ALL its descendants (the roll-up set), and siblings sorted by
 * name. Both the transactions spreadsheet's columns and the allocations
 * grid's rows are flattenings of this tree.
 */
export function buildFundTree(funds, startedBy, activeSince = null) {
    return buildTreeOver(funds, f => f.status.tracked
        && f.start && f.start.date <= startedBy
        && (activeSince == null || f.deprecated == null || f.deprecated >= activeSince));
}

/**
 * Hierarchy tree over ALL the given funds (tracked or not) -- the selector
 * variant of buildFundTree, for ordering dropdown options and labeling them
 * with ancestor context. Same node shape and effective-parent rule; a fund
 * whose ancestors were all filtered out of `funds` (e.g. by a server-side
 * query filter) roots its own subtree.
 */
export function buildFundOptionTree(funds) {
    return buildTreeOver(funds, () => true);
}

function buildTreeOver(funds, isNode) {
    const byId = new Map(funds.map(f => [ f.id, f ]));
    const nodes = new Map(
        funds.filter(isNode).map(f => [ f.id, { fund: f, children: [] } ])
    );

    const effectiveParentOf = (fund) => {
        let pid = fund.parent_id;
        while ( pid != null ) {
            if ( nodes.has(pid) ) return pid;
            pid = byId.get(pid)?.parent_id ?? null;
        }
        return null;
    };

    const roots = [];
    for ( const node of nodes.values() ) {
        const pid = effectiveParentOf(node.fund);
        if ( pid == null ) roots.push(node);
        else nodes.get(pid).children.push(node);
    }

    const finish = (node, depth) => {
        node.depth = depth;
        node.children.sort((a, b) => a.fund.name.localeCompare(b.fund.name));
        node.subtreeIds = [ node.fund.id ];
        for ( const child of node.children ) {
            finish(child, depth + 1);
            node.subtreeIds.push(...child.subtreeIds);
        }
    };
    roots.sort((a, b) => a.fund.name.localeCompare(b.fund.name));
    roots.forEach(root => finish(root, 0));

    return roots;
}

/**
 * The set of fund ids that ARE monthly or CONTAIN a monthly descendant
 * (walking parent links up from every monthly fund). The server treats the
 * parent of any such fund as history: reparenting it is refused once
 * finalizations exist. Mirrors Fund's `has_monthly_descendant` guard so the
 * UI can pre-emptively lock the field instead of letting the API 400.
 */
export function fundIdsContainingMonthly(funds) {
    const byId = new Map(funds.map(f => [ f.id, f ]));
    const result = new Set();
    for ( const f of funds ) {
        if ( !f.status?.monthly ) continue;
        let cur = f;
        while ( cur != null && !result.has(cur.id) ) {
            result.add(cur.id);
            cur = cur.parent_id != null ? byId.get(cur.parent_id) : null;
        }
    }
    return result;
}

/**
 * A bank statement item's state: prefer the API's canonical `state` field,
 * deriving it from the raw flags only as a fallback (every item is in
 * exactly one of these).
 */
export function statementStateOf(statement) {
    if ( !statement ) return "unknown";
    if ( statement.state ) return statement.state;
    if ( statement.group_id != null ) return "reconciled";
    if ( statement.ignored ) return "ignored";
    return "pending";
}
