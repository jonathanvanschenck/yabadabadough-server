/**
 * Re-export of the SERVER's provisional-balance registry -- the single source
 * of truth shared by both sides, exactly like queryKeys.js and fundColors.js.
 * The API publishes a `provisional` flag on its balance payloads from these
 * same functions, so the warnings this app renders and the flag the server
 * sends can never disagree.
 *
 * See the registry itself for the rule; the short version is that finalizing
 * a month writes eom_cleanup transactions dated its last day, so any balance
 * at or after the first unfinalized month's eom can still move.
 *
 * The functions are pure and take 'YYYY-MM-DD' strings -- feed them from
 * useProvisionalFrontier() below rather than deriving a frontier by hand.
 */
export {
    first_unfinalized_som,
    provisional_frontier,
    balance_on_is_provisional,
    forward_balance_is_provisional,
} from '../../../lib/provisional.mjs';
