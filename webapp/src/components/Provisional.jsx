import { useState } from 'react';

import { Banner } from './Banner.jsx';
import { monthLabel } from './domain.js';
import styles from './Provisional.module.css';

const titleFor = (som) =>
    `Provisional — ${monthLabel(som)} is not finalized, so this figure can still change.`;

/**
 * Marks a rendered money figure as provisional: a value that looks settled
 * but can still move on its own, because finalizing an earlier month writes
 * end-of-month cleanup transfers dated before it.
 *
 * The mark is a dotted underline rather than a glyph or a color swap: money
 * columns are `tabular-nums` and an inserted character would break digit
 * alignment, while recoloring a whole column of figures competes with the
 * fund colors the same cells already carry.
 */
export function ProvisionalValue({ som, className, children }) {
    return (
        <span
            className={[ styles.value, className ].filter(Boolean).join(' ')}
            title={titleFor(som)}
        >
            {children}
        </span>
    );
}

/**
 * The page-level explanation behind the marks. Collapsed by default to a
 * single line: it sits above dense data views where a full paragraph of
 * warning out-weighs the thing it is warning about, and the reader only
 * needs the "why" once. The detail stays one click away rather than being
 * cut, since the mechanism is genuinely non-obvious.
 *
 * `som` is the month to NAME -- the caller's choice, because the month that
 * matters is the one bearing on what's on screen (see the transactions page),
 * not necessarily the earliest unfinalized one.
 */
export function ProvisionalBanner({ som, className }) {
    const [ isExpanded, setIsExpanded ] = useState(false);
    const month = monthLabel(som);

    return (
        <Banner variant="warn" icon="fa-triangle-exclamation" dense className={className}>
            <span>
                <strong>{month} isn&apos;t finalized yet.</strong>{' '}
                Balances here may shift.{' '}
            </span>
            <button
                type="button"
                className={styles.toggle}
                onClick={() => setIsExpanded(v => !v)}
                aria-expanded={isExpanded}
            >
                {isExpanded ? "See less" : "See more"}
            </button>
            { isExpanded &&
                <p className={styles.detail}>
                    Finalizing a month sweeps every monthly fund&apos;s remainder
                    into its pool, using transfers dated that month&apos;s last
                    day — so these figures can change with no action from you. If
                    you&apos;re done entering {month}, finalize it now; if
                    something turns up later, you can always unfinalize to add it.
                </p>
            }
        </Banner>
    );
}
