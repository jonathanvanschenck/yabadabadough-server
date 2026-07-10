import dayjs from 'dayjs';

/**
 * Pure derivations for the transactions spreadsheet page: month arithmetic,
 * the tracked-fund column tree, and per-row amount math over the API's
 * transaction group representations.
 */

/** The month containing `som` (YYYY-MM-DD) as its useful boundary dates. */
export function monthBoundsOf(som) {
    const start = dayjs(som).startOf('month');
    return {
        som: start.format('YYYY-MM-DD'),
        eom: start.endOf('month').format('YYYY-MM-DD'),
        dayBeforeSom: start.subtract(1, 'day').format('YYYY-MM-DD'),
    };
}

/** A note "exists" for display purposes when non-null and non-whitespace. */
export function hasNote(note) {
    return note != null && note.trim() !== '';
}

/**
 * Build the fund column tree for a month: one column per TRACKED fund that
 * had started by `eom` (a fund that did not exist yet that month has nothing
 * to show), children to the right of their parents. A tracked fund whose
 * parents are all untracked (or not started) roots its own subtree -- the
 * effective parent is the nearest ancestor that is itself a column.
 *
 * Returns the list of root nodes; every node is
 * `{ fund, depth, children, subtreeIds }` with `subtreeIds` the fund ids of
 * the node and ALL its descendants (the collapse roll-up set), and siblings
 * sorted by name.
 */
export function buildFundColumnTree(funds, eom) {
    const byId = new Map(funds.map(f => [ f.id, f ]));
    const isColumn = (f) => f.status.tracked && f.start && f.start.date <= eom;
    const nodes = new Map(
        funds.filter(isColumn).map(f => [ f.id, { fund: f, children: [] } ])
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
 * Flatten the column tree into the rendered column list, applying the user's
 * hidden/collapsed sets. A hidden fund drops only its own column (children
 * stay); a collapsed fund keeps its column but swallows every descendant --
 * its `memberIds` become the whole subtree, so cell values roll up into it.
 *
 * Each column carries `bars`: the funds of the parent groups it belongs to
 * (outermost first, including itself when it IS a group). Rendered as
 * stacked colored bar segments under the header, adjacent segments of the
 * same group join into one bar spanning the group's whole subtree -- the
 * parent/child affordance.
 */
export function visibleColumnsOf(roots, hiddenIds, collapsedIds) {
    const out = [];
    const walk = (node, groupTrail) => {
        const isGroup = node.children.length > 0;
        const isCollapsed = isGroup && collapsedIds.has(node.fund.id);
        const bars = isGroup ? [ ...groupTrail, node.fund ] : groupTrail;
        if ( !hiddenIds.has(node.fund.id) ) {
            out.push({
                fund: node.fund,
                depth: node.depth,
                hasChildren: isGroup,
                isCollapsed,
                memberIds: isCollapsed ? node.subtreeIds : [ node.fund.id ],
                bars,
            });
        }
        if ( !isCollapsed ) node.children.forEach(child => walk(child, bars));
    };
    roots.forEach(root => walk(root, []));
    return out;
}

/** Every fund id anywhere in the column tree (for pruning stale hidden ids). */
export function allColumnIdsOf(roots) {
    return roots.flatMap(root => root.subtreeIds);
}

/**
 * Net signed amount per fund over a set of transactions: +amount into the
 * target, -amount out of the source.
 */
export function netAmountsByFund(transactions) {
    const map = new Map();
    for ( const t of transactions ) {
        map.set(t.target_fund_id, (map.get(t.target_fund_id) ?? 0) + t.amount);
        map.set(t.source_fund_id, (map.get(t.source_fund_id) ?? 0) - t.amount);
    }
    return map;
}

/**
 * The "outside" total of a set of transactions: the net amount crossing the
 * tracked/untracked boundary. Money FROM an untracked fund counts positive
 * (it enters the tracked world), money TO an untracked fund negative;
 * transfers between two tracked funds contribute zero.
 */
export function outsideTotalOf(transactions, trackedIds) {
    let total = 0;
    for ( const t of transactions ) {
        if ( !trackedIds.has(t.source_fund_id) ) total += t.amount;
        if ( !trackedIds.has(t.target_fund_id) ) total -= t.amount;
    }
    return total;
}

/**
 * Sum a Map's values over `ids`, or null when NONE of the ids are present
 * (the "empty cell" state, distinct from a legitimate zero).
 */
export function sumOver(map, ids) {
    let sum = 0;
    let touched = false;
    for ( const id of ids ) {
        if ( map.has(id) ) {
            sum += map.get(id);
            touched = true;
        }
    }
    return touched ? sum : null;
}
