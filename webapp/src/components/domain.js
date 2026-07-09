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
 * Derive a bank statement item's state (see the API docs: every item is in
 * exactly one of these).
 */
export function statementStateOf(statement) {
    if ( !statement ) return "unknown";
    if ( statement.group_id != null ) return "reconciled";
    if ( statement.ignored ) return "ignored";
    return "pending";
}
