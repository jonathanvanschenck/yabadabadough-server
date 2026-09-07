import { useMemo, useState } from 'react';

import { useGetTransactionGroupsQuery } from '../../hooks/Queries.jsx';
import { useAuthRoles } from '../../contexts/AuthContext.jsx';
import { IconButton } from '../../components/Buttons.jsx';
import { BooleanInput } from '../../components/Inputs.jsx';
import { EditTransactionGroupModal } from '../../components/SpecialModals.jsx';
import Spinner from '../../components/Spinner.jsx';
import { NavLink } from 'react-router';
import {
    formatDollars,
    transactionGroupTotal,
    daysOutstanding,
    outstandingIsStale,
    todayYDate,
    STALE_OUTSTANDING_DAYS,
} from '../../components/domain.js';
import styles from './Outstanding.module.css';

/**
 * The mirror image of the statements work queue.
 *
 * That page lists bank lines with no group ("the bank knows about this, you
 * have not explained it"); this one lists groups with no bank line ("you
 * committed this money, the bank does not know yet"). A written-but-uncashed
 * cheque, a pending ACH, a promised refund.
 *
 * Oldest first, deliberately: the top of this list is the item most likely to
 * have gone astray. Everything here is DERIVED -- a group appears because it
 * declared `expects_statement` and nothing has been linked to it, so it leaves
 * the list the moment its item is reconciled, with no write of its own.
 *
 * NOTE : a bespoke table rather than the usual list-page `SearchableTable`,
 *        for the same reason the balances table is bespoke -- the per-row
 *        styling IS the content here (waiting vs. gone stale), and
 *        SearchableTable exposes only a single `highlightedRowIds` treatment.
 *        Filtering is server-side (`outstanding: true`) rather than a client
 *        search box, since the whole page is one filter.
 */
export default function Page() {
    const roles = useAuthRoles();
    const today = todayYDate();

    const [ staleOnly, setStaleOnly ] = useState(false);
    const [ editTarget, setEditTarget ] = useState(null);

    // Ascending: the longest-waiting item is the one that needs attention
    const groupsQ = useGetTransactionGroupsQuery({
        outstanding: true,
        orderBy: 'date',
        orderDirection: 'asc',
    });

    const rows = useMemo(() => (groupsQ.data ?? [])
        .map(group => ({
            group,
            total: transactionGroupTotal(group),
            waited: daysOutstanding(group, today),
            stale: outstandingIsStale(group, today),
        }))
        .filter(r => !staleOnly || r.stale),
    [groupsQ.data, staleOnly, today]);

    const staleCount = useMemo(
        () => (groupsQ.data ?? []).filter(g => outstandingIsStale(g, today)).length,
        [groupsQ.data, today]
    );

    // The sum of what is committed but unconfirmed -- the gap between what
    // your funds say and what the bank will show. Magnitudes, not a signed
    // bank delta: a group is fund-to-fund, so it has no direction relative to
    // any one account.
    const total = useMemo(() => rows.reduce((sum, r) => sum + r.total, 0), [rows]);

    return (
        <div className={styles.page}>
            <div className={styles.topBar}>
                <div className={styles.topBarSide}>
                    <h1 className={styles.pageTitle}>Outstanding</h1>
                    { !groupsQ.isPending && !groupsQ.isError &&
                        <span className={styles.count}>
                            {rows.length} item{rows.length === 1 ? '' : 's'}
                            { staleOnly && ` of ${groupsQ.data.length}` }
                            { total > 0 && ` · ${formatDollars(total)}` }
                        </span>
                    }
                </div>
                <div className={styles.staleControl}>
                    <BooleanInput
                        value={staleOnly}
                        isFrozen={false}
                        onChange={setStaleOnly}
                        trueLabel={`Only over ${STALE_OUTSTANDING_DAYS} days`}
                        falseLabel="All outstanding"
                        title={`${staleCount} item${staleCount === 1 ? '' : 's'} older than most banks will honour`}
                    />
                </div>
                <div className={`${styles.topBarSide} ${styles.topBarRight}`}>
                    <span>Committed here, not yet seen by the bank</span>
                </div>
            </div>

            { groupsQ.isError
                ? <div className={styles.centerState}>
                    <h2 className={styles.errorTitle}>Error</h2>
                    <p>
                        { groupsQ.error.details?.message
                            ? `${groupsQ.error.message}: ${groupsQ.error.details.message}`
                            : groupsQ.error.message
                        }
                    </p>
                </div>
                : groupsQ.isPending
                ? <div className={styles.centerState}><Spinner size="2rem" /></div>
                : <div className={styles.tableScroll}>
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th className={styles.dateCell}>Dated</th>
                                <th className={styles.waitedCell}>Waiting</th>
                                <th>Description</th>
                                <th className={styles.referenceCell}>Reference</th>
                                <th className={styles.moneyCell}>Amount</th>
                                <th className={styles.actionsCell}></th>
                            </tr>
                        </thead>
                        <tbody>
                            { rows.length === 0 &&
                                <tr>
                                    <td className={styles.emptyState} colSpan={6}>
                                        { staleOnly
                                            ? `Nothing has been waiting more than ${STALE_OUTSTANDING_DAYS} days.`
                                            : 'Nothing is waiting on a bank line.' }
                                    </td>
                                </tr>
                            }
                            { rows.map(({ group, total: amount, waited, stale }) => (
                                <tr
                                    key={group.id}
                                    className={`${styles.bodyRow} ${stale ? styles.staleRow : ''}`}
                                >
                                    <td className={`${styles.dateCell} tabular-nums`}>{group.date}</td>
                                    <td
                                        className={`${styles.waitedCell} tabular-nums`}
                                        title={stale
                                            ? 'Older than most banks will honour — chase it, or clear “Awaiting a bank line” to write it off'
                                            : undefined}
                                    >
                                        { waited == null ? '—' : `${waited} day${waited === 1 ? '' : 's'}` }
                                    </td>
                                    <td className={styles.descCell} title={group.description}>
                                        <NavLink
                                            to={`/transaction-group/${group.id}`}
                                            className={styles.descLink}
                                        >
                                            {group.description}
                                        </NavLink>
                                    </td>
                                    <td className={styles.referenceCell} title={group.reference ?? undefined}>
                                        { group.reference ? `#${group.reference}` : '—' }
                                    </td>
                                    <td className={`${styles.moneyCell} tabular-nums`}>
                                        {formatDollars(amount)}
                                    </td>
                                    <td className={styles.actionsCell}>
                                        <IconButton
                                            text="Edit"
                                            icon="fa-pen-to-square"
                                            ariaLabel={`Edit ${group.description}`}
                                            title="Edit the group — clear “Awaiting a bank line” to write it off"
                                            disabled={!roles.editor}
                                            onClick={() => setEditTarget(group)}
                                        />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            }

            <EditTransactionGroupModal
                isOpen={editTarget != null}
                setIsOpen={(open) => { if (!open) setEditTarget(null); }}
                group={editTarget}
            />
        </div>
    );
}
