/**
 * The provisional-balance registry: the single source of truth for deciding
 * when a computed balance is "dubious" because an earlier month has not been
 * finalized yet.
 *
 * The hazard: finalizing a month inserts eom_cleanup transactions dated that
 * month's eom_date, sweeping every monthly fund's remainder into its nearest
 * pool ancestor. So a balance that looks settled today can shift the moment
 * an EARLIER month is finalized -- without anyone touching a transaction.
 * Such a balance is PROVISIONAL.
 *
 * Because months finalize contiguously (oldest first), the whole question
 * collapses to a single date: the eom_date of the FIRST unfinalized month
 * (the "frontier"). Every cleanup that has yet to be written lands on or
 * after it.
 *
 *   - a balance ON date D includes transactions up to AND on D, so it is
 *     provisional iff frontier <= D
 *   - a forward balance ENTERING date D excludes D itself, so it is
 *     provisional iff frontier < D
 *
 * That off-by-one is load-bearing, not an accident: the cleanup for the
 * first open month is dated its LAST day, so the balance *on* that day is
 * already provisional while the balance *entering* it is still settled.
 *
 * A null frontier means nothing can ever be provisional -- see
 * provisional_frontier() for the two ways that happens.
 *
 * This file is ESM (.mjs) because it is SHARED with the webapp, exactly like
 * query_keys.mjs and fund_colors.mjs: the CJS server require()s it (Node >=
 * 22.12 supports require(esm)) and the webapp imports it (via the
 * src/hooks/provisional.js shim), so the rule the API publishes and the rule
 * the browser renders warnings from can never drift. Keep it
 * runtime-agnostic: no node builtins, no requires of server code.
 *
 * Everything here works on plain 'YYYY-MM-DD' strings, which compare
 * chronologically under ordinary lexicographic <=. That keeps the module free
 * of both YDate (server) and dayjs (webapp); each side converts at its own
 * boundary.
 */

/**
 * Last day of the month containing `date`, as 'YYYY-MM-DD'.
 * Day 0 of month m+1 is the last day of month m, and Date.UTC treats its
 * month argument as 0-indexed -- so passing the 1-indexed month lands on the
 * following month, and day 0 walks it back.
 */
const end_of_month = (date) => {
    const [ year, month ] = date.split("-").map(Number);
    const last_day = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${date.slice(0, 7)}-${String(last_day).padStart(2, "0")}`;
};

/**
 * The first day of the first month that has NOT been finalized, or null when
 * there is no such month to speak of (no tracked fund exists yet).
 *
 * Inputs are supplied by the caller so this stays pure -- the server reads
 * them from sqlite, the webapp from its query cache:
 *
 *   latest_sonm_date        'YYYY-MM-DD' start-of-next-month of the latest
 *                           finalized month, or null if nothing is finalized
 *   earliest_tracked_start  'YYYY-MM-DD' earliest start_date among tracked
 *                           funds, or null if there are none
 *
 * With a finalization present the answer is exactly its sonm_date
 * (contiguity guarantees no gaps behind it). Otherwise every month since the
 * ledger began is open, and the first one is the month the earliest tracked
 * fund starts in.
 */
export const first_unfinalized_som = ({
    latest_sonm_date = null,
    earliest_tracked_start = null,
}={}) => {
    if ( latest_sonm_date ) return latest_sonm_date;
    if ( !earliest_tracked_start ) return null;
    return `${earliest_tracked_start.slice(0, 7)}-01`;
};

/**
 * The provisional frontier: the eom_date of the first unfinalized month, or
 * null when no balance can ever be provisional.
 *
 * Null happens two ways, and both are worth stating plainly:
 *
 *   1. there is no unfinalized month to worry about (no tracked funds), or
 *   2. `has_monthly_fund` is false -- with no monthly funds anywhere, a
 *      finalization writes no eom_cleanup transactions at all, so finalizing
 *      moves no money and no balance is at risk. Without this gate a ledger
 *      that never uses monthly funds would carry a warning banner forever.
 *
 * Note that (2) is a snapshot of the ledger as it stands: creating the first
 * monthly fund makes previously-settled balances provisional. That is
 * correct -- the cleanup that fund will generate is genuinely pending -- but
 * it does mean the flag can flip without any balance changing.
 */
export const provisional_frontier = ({
    latest_sonm_date = null,
    earliest_tracked_start = null,
    has_monthly_fund = false,
}={}) => {
    if ( !has_monthly_fund ) return null;

    const som = first_unfinalized_som({ latest_sonm_date, earliest_tracked_start });
    if ( !som ) return null;

    return end_of_month(som);
};

/**
 * Is a balance ON `date` provisional? Inclusive of `date` itself, so the
 * frontier day counts.
 *
 * A null `date` means "as of now, with no upper bound" (the current balance),
 * which sits after every pending cleanup -- provisional whenever a frontier
 * exists at all.
 */
export const balance_on_is_provisional = (frontier, date = null) => {
    if ( !frontier ) return false;
    if ( !date ) return true;
    return frontier <= date;
};

/**
 * Is a forward balance ENTERING `date` provisional? Exclusive of `date`, so
 * the frontier day does NOT count.
 */
export const forward_balance_is_provisional = (frontier, date = null) => {
    if ( !frontier ) return false;
    if ( !date ) return true;
    return frontier < date;
};
