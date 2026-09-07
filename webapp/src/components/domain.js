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

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Human label for a 'YYYY-MM-DD' date string's month ("May 2026").
 * Deliberately not dayjs: the input is already a plain date string, and only
 * the month and year are wanted.
 */
export function monthLabel(date) {
    if ( !date ) return "";
    const [ year, month ] = date.split('-').map(Number);
    return `${MONTH_NAMES[month - 1]} ${year}`;
}

/**
 * The start-of-month date string for the month before the one `som` starts
 * ("2026-09-01" -> "2026-08-01"). Same reasoning as monthLabel: the input is
 * already a plain date string, so this is cheaper and more predictable than
 * routing through dayjs.
 */
export function previousMonthSom(som) {
    if ( !som ) return null;
    const [ year, month ] = som.split('-').map(Number);
    return month === 1
        ? `${year - 1}-12-01`
        : `${year}-${String(month - 1).padStart(2, '0')}-01`;
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
 * Amount comparisons over float dollars: within half a cent counts as equal.
 * Shared by the statement-linking surfaces (the fuzzy modal and the inline
 * suggestions), so "matches the item's amount" means the same thing in both.
 */
export function amountsMatch(a, b) {
    return a != null && b != null && Math.abs(a - b) < 0.005;
}

/**
 * The sum of a transaction group's line amounts -- what a bank statement
 * line for the whole group would show (up to sign; statement amounts are
 * signed, group lines are magnitudes).
 */
export function transactionGroupTotal(group) {
    return group.transactions.reduce((sum, t) => sum + t.amount, 0);
}

/**
 * Today as a 'YYYY-MM-DD' string in the BROWSER's timezone. The server
 * deliberately keeps no clock of its own (it cannot know the user's zone),
 * so "today" is always the client's answer -- this is the one place that
 * decides it.
 */
export function todayYDate() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// Shorter than this and a reference collides with everything -- a bare "12"
// appears inside half the amounts and dates a bank memo carries
const MIN_REFERENCE_MATCH_LENGTH = 3;

/**
 * Whether a bank statement item plausibly NAMES a group's `reference` -- the
 * exact-key half of reconciliation, as opposed to the fuzzy date/amount half.
 *
 * Banks bury the number in free text ("CHECK 1247", "CHK#1247", "Cheque no
 * 1247"), so this matches the reference as a whole token inside the item's
 * searchable text rather than requiring equality. The token boundaries
 * matter: "1247" must not match "31247" or "12470", which are different
 * cheques entirely.
 */
export function statementNamesReference(statement, reference) {
    if ( !statement || !reference ) return false;
    const ref = String(reference).trim();
    if ( ref.length < MIN_REFERENCE_MATCH_LENGTH ) return false;
    const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^0-9A-Za-z])${escaped}(?:[^0-9A-Za-z]|$)`, 'i')
        .test(`${statement.note ?? ''} ${statement.key ?? ''}`);
}

/**
 * Whether a transaction group is still waiting on its bank line: prefer the
 * API's canonical derived `outstanding`, falling back to the rule itself
 * (expects a statement, nothing linked yet) so the helper still answers for
 * a group shape that predates the field.
 */
export function groupIsOutstanding(group) {
    if ( !group ) return false;
    if ( group.status?.outstanding != null ) return group.status.outstanding;
    return !!group.status?.expects_statement && (group.statements?.length ?? 0) === 0;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Plain date strings, so parse them as UTC midnights and subtract -- no
// dayjs, and no DST edge to fall into (same reasoning as monthLabel)
const utcDay = (date) => {
    const [ year, month, day ] = date.split('-').map(Number);
    return Date.UTC(year, month - 1, day) / MS_PER_DAY;
};

/**
 * How many days an outstanding group has been waiting, measured from its own
 * date -- the day the cheque was written, not the day it was entered. Null
 * when the group is not outstanding: there is nothing to be waiting for.
 */
export function daysOutstanding(group, today = todayYDate()) {
    if ( !groupIsOutstanding(group) || !group.date || !today ) return null;
    return Math.max(0, Math.round(utcDay(today) - utcDay(group.date)));
}

/**
 * Most banks refuse a cheque more than six months old. Past this an
 * outstanding item is worth chasing (or writing off with
 * `expects_statement: false`) rather than quietly waiting on.
 */
export const STALE_OUTSTANDING_DAYS = 180;

export function outstandingIsStale(group, today = todayYDate()) {
    const days = daysOutstanding(group, today);
    return days != null && days >= STALE_OUTSTANDING_DAYS;
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
