import { formatDollars } from './domain.js';
import styles from './Money.module.css';

/**
 * Every rendered dollar amount in the app goes through here.
 *
 * The point is that the reading of an amount never depends on which page you
 * are on: negatives are always the danger tone, an exact zero always recedes,
 * a missing value is always an em-dash, and digits always align (tabular
 * figures) so a column of amounts scans down cleanly. Before this existed the
 * transactions grid and the statements cards each had their own `.negative`
 * rule while balances, allocations, fund pages and every modal had none, so
 * the same -$40.00 read as an error in one place and as ordinary text in
 * another.
 *
 * `formatDollars` remains the way to get the STRING (titles, aria labels,
 * template literals) -- this component is for anything actually rendered, and
 * delegates to it so the two can never disagree about the format.
 *
 * @param {number|null} value - Float dollars, signed.
 * @param {boolean} faintZero - Recede an exact zero (default). Opt out where a
 *   zero is a real answer the reader is looking for rather than noise.
 * @param {string} placeholder - Shown when `value` is not a finite number.
 */
export function Money({
    value,
    className = '',
    faintZero = true,
    placeholder = '—',
    ...rest
}) {
    const isNumber = Number.isFinite(value);

    const tone = !isNumber ? styles.missing
        : value < 0 ? styles.negative
        : ( faintZero && value === 0 ) ? styles.zero
        : '';

    return (
        <span className={[ 'tabular-nums', tone, className ].filter(Boolean).join(' ')} {...rest}>
            { isNumber ? formatDollars(value) : placeholder }
        </span>
    );
}
