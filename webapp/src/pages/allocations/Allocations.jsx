import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import dayjs from 'dayjs';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';

import {
    useGetFundsQuery,
    useGetMonthFinalizationsQuery,
    useGetAllocationsForMonthsQuery,
} from '../../hooks/Queries.jsx';
import { MonthPaginator } from '../../components/MonthPaginator.jsx';
import { IconButton } from '../../components/Buttons.jsx';
import { FundLabel } from '../../components/Badges.jsx';
import { FundTypeIcon } from '../../components/SpecialIcons.jsx';
import {
    SetAllocationModal,
    DeleteAllocationModal,
    CopyAllocationsModal,
} from '../../components/SpecialModals.jsx';
import Spinner from '../../components/Spinner.jsx';
import { formatDollars, buildFundTree } from '../../components/domain.js';
import { fundColorVar } from '../../hooks/fundColors.js';
import { monthWindowOf, fundRowsOf, nearestPoolAncestorOf, canAllocate } from './utils.jsx';
import styles from './Allocations.module.css';

/** How many month columns the grid shows (ending at the selected month). */
const MONTH_COUNT = 12;

/** Tiny borderless icon button -- the page's "subtle, icon-only" affordance. */
function GhostButton({ icon, title, onClick }) {
    return (
        <button
            type="button"
            className={styles.ghostButton}
            onClick={onClick}
            title={title}
            aria-label={title}
        >
            <FontAwesomeIcon icon={`fa-solid ${icon}`} size="xs" />
        </button>
    );
}

/**
 * One allocation cell. Finalized months are static; open months are click-
 * to-set (or click-to-edit), with a hover trash button when an allocation
 * exists. A fund that cannot receive an allocation that month (not started,
 * or no started pool ancestor) renders inert.
 */
function AllocationCell({ fund, allocation, isFinalized, isEditable, isCurrent, title, onSet, onDelete }) {
    return (
        <td
            className={[
                styles.allocCell,
                'tabular-nums',
                isEditable ? styles.editableCell : '',
                isFinalized ? styles.finalizedCell : '',
                !isEditable && !isFinalized && allocation == null ? styles.inertCell : '',
                isCurrent ? styles.currentMonthCell : '',
            ].join(' ')}
            style={{ backgroundColor: fundColorVar(fund.color, 'muted') }}
            onClick={isEditable ? onSet : undefined}
            title={title}
        >
            { allocation != null
                ? <span>{formatDollars(allocation.amount)}</span>
                : ( isEditable &&
                    <span className={styles.hoverPlus} aria-hidden="true">
                        <FontAwesomeIcon icon="fa-solid fa-square-plus" size="xs" />
                    </span>
                )
            }
            { allocation != null && isEditable &&
                <button
                    type="button"
                    className={styles.cellDelete}
                    onClick={(event) => { event.stopPropagation(); onDelete(); }}
                    title="Remove this allocation"
                    aria-label="Remove this allocation"
                >
                    <FontAwesomeIcon icon="fa-solid fa-trash" size="xs" />
                </button>
            }
        </td>
    );
}

export default function Page() {
    const [ searchParams, setSearchParams ] = useSearchParams();

    // The paginator selects the NEWEST visible month; the grid shows it plus
    // the MONTH_COUNT - 1 months before it, oldest on the left
    const monthParam = searchParams.get('month');
    const endSom = /^\d{4}-\d{2}$/.test(monthParam ?? '')
        ? `${monthParam}-01`
        : dayjs().format('YYYY-MM-01');
    const currentSom = dayjs().format('YYYY-MM-01');

    const setMonth = useCallback((newSom) => {
        setSearchParams(prev => {
            const next = new URLSearchParams(prev);
            next.set('month', newSom.slice(0, 7));
            return next;
        });
    }, [setSearchParams]);

    const months = useMemo(() => monthWindowOf(endSom, MONTH_COUNT), [endSom]);
    const windowEom = dayjs(endSom).endOf('month').format('YYYY-MM-DD');

    const [ setTarget, setSetTarget ] = useState(null);       // { month, fundId, fund, amount, monthFrozen, fundFrozen }
    const [ deleteTarget, setDeleteTarget ] = useState(null); // { month, fund }
    const [ copyTarget, setCopyTarget ] = useState(null);     // { from, to }

    const fundsQ = useGetFundsQuery();
    const monthsQ = useGetMonthFinalizationsQuery();
    const allocationsQ = useGetAllocationsForMonthsQuery(months);

    const funds = fundsQ.data;

    const fundsById = useMemo(() => new Map((funds ?? []).map(f => [ f.id, f ])), [funds]);
    const rows = useMemo(() => fundRowsOf(buildFundTree(funds ?? [], windowEom)), [funds, windowEom]);
    const poolAncestors = useMemo(
        () => new Map(rows.map(({ fund }) => [ fund.id, nearestPoolAncestorOf(fund, fundsById) ])),
        [rows, fundsById]
    );
    const finalizedSoms = useMemo(
        () => new Set((monthsQ.data ?? []).map(m => m.som_date)),
        [monthsQ.data]
    );
    // Months finalize contiguously and nothing may change in OR BEFORE a
    // finalized month, so everything up to the latest finalization is locked
    // (even the unfinalized months before the first one with data)
    const latestFinalizedSom = useMemo(
        () => (monthsQ.data ?? []).reduce((max, m) => (max == null || m.som_date > max ? m.som_date : max), null),
        [monthsQ.data]
    );
    const isLockedSom = (som) => latestFinalizedSom != null && som <= latestFinalizedSom;
    // One Map per month column: fund_id -> allocation
    const allocMaps = useMemo(
        () => months.map((_, i) => new Map((allocationsQ.data[i] ?? []).map(a => [ a.fund_id, a ]))),
        [months, allocationsQ.data]
    );
    const monthTotals = useMemo(
        () => allocMaps.map(map => {
            let total = null;
            for ( const a of map.values() ) total = (total ?? 0) + a.amount;
            return total;
        }),
        [allocMaps]
    );

    // Keep the newest (rightmost) months in view when the grid overflows
    const scrollRef = useRef(null);
    const isPending = fundsQ.isPending || monthsQ.isPending || allocationsQ.isPending;
    useEffect(() => {
        if ( !isPending && scrollRef.current ) {
            scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
        }
    }, [isPending, endSom]);

    const queryError = fundsQ.error ?? monthsQ.error ?? allocationsQ.error;

    const monthTitleOf = (som) => dayjs(som).format('MMMM YYYY');

    return (
        <div className={styles.page}>
            <div className={styles.topBar}>
                <div className={styles.topBarSide}>
                    <h1 className={styles.pageTitle}>Allocations</h1>
                    <IconButton
                        text="Set allocation"
                        icon="fa-square-plus"
                        ariaLabel="Set an allocation"
                        onClick={() => setSetTarget({
                            month: endSom, fundId: null, fund: null, amount: null,
                            monthFrozen: false, fundFrozen: false
                        })}
                    />
                    <IconButton
                        text="Copy month"
                        icon="fa-copy"
                        ariaLabel="Copy one month's allocations into another"
                        onClick={() => setCopyTarget({
                            from: endSom,
                            to: dayjs(endSom).add(1, 'month').format('YYYY-MM-01')
                        })}
                    />
                </div>
                <MonthPaginator value={endSom} onChange={setMonth} />
                <div className={`${styles.topBarSide} ${styles.topBarRight}`}>
                    Showing the {MONTH_COUNT} months through {monthTitleOf(endSom)}
                </div>
            </div>

            { queryError
                ? <div className={styles.centerState}>
                    <h2 className={styles.errorTitle}>Error</h2>
                    <p>
                        { queryError.details?.message
                            ? `${queryError.message}: ${queryError.details.message}`
                            : queryError.message
                        }
                    </p>
                </div>
                : isPending
                ? <div className={styles.centerState}><Spinner size="2rem" /></div>
                : <div className={styles.tableScroll} ref={scrollRef}>
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th className={`${styles.fundTh} ${styles.stickyCol}`}>Fund</th>
                                { months.map((som, i) => {
                                    const prevSom = i > 0
                                        ? months[i - 1]
                                        : dayjs(som).subtract(1, 'month').format('YYYY-MM-01');
                                    return (
                                        <th
                                            key={som}
                                            className={`${styles.monthTh} ${som === currentSom ? styles.currentMonthTh : ''}`}
                                        >
                                            <div className={styles.monthLabel} title={monthTitleOf(som)}>
                                                {dayjs(som).format('MMM')}
                                                <span className={styles.monthYear}>{dayjs(som).format('’YY')}</span>
                                            </div>
                                            <div className={styles.monthControls}>
                                                { isLockedSom(som)
                                                    ? <span
                                                        className={styles.lockMark}
                                                        title={ finalizedSoms.has(som)
                                                            ? `${monthTitleOf(som)} is finalized (read-only)`
                                                            : `${monthTitleOf(som)} precedes a finalized month (read-only)`
                                                        }
                                                    >
                                                        <FontAwesomeIcon icon="fa-solid fa-lock" size="xs" />
                                                    </span>
                                                    : <>
                                                        <GhostButton
                                                            icon="fa-square-plus"
                                                            title={`Add an allocation in ${monthTitleOf(som)}`}
                                                            onClick={() => setSetTarget({
                                                                month: som, fundId: null, fund: null, amount: null,
                                                                monthFrozen: true, fundFrozen: false
                                                            })}
                                                        />
                                                        <GhostButton
                                                            icon="fa-copy"
                                                            title={`Copy ${monthTitleOf(prevSom)}'s allocations into ${monthTitleOf(som)}`}
                                                            onClick={() => setCopyTarget({ from: prevSom, to: som })}
                                                        />
                                                    </>
                                                }
                                            </div>
                                        </th>
                                    );
                                })}
                            </tr>
                        </thead>
                        <tbody>
                            <tr className={styles.totalsRow}>
                                <td className={`${styles.totalsLabel} ${styles.stickyCol}`}>Total allocated</td>
                                { months.map((som, i) => (
                                    <td key={som} className={`${styles.allocCell} ${styles.totalsCell} tabular-nums`}>
                                        { monthTotals[i] != null && formatDollars(monthTotals[i]) }
                                    </td>
                                ))}
                            </tr>
                            { rows.length === 0 &&
                                <tr>
                                    <td className={styles.emptyState} colSpan={1 + months.length}>
                                        No tracked funds to allocate to yet
                                    </td>
                                </tr>
                            }
                            { rows.map(({ fund, depth }) => {
                                const poolAncestor = poolAncestors.get(fund.id);
                                return (
                                    <tr key={fund.id} className={styles.bodyRow}>
                                        <td
                                            className={`${styles.fundCell} ${styles.stickyCol}`
                                                + (fund.status.pool ? ` ${styles.poolCell}` : '')}
                                            style={{
                                                backgroundColor: fundColorVar(fund.color, 'main'),
                                                paddingLeft: `${0.5 + depth * 1.1}rem`
                                            }}
                                        >
                                            <FundLabel fund={fund} />
                                            { fund.status.pool &&
                                                <FundTypeIcon
                                                    status={fund.status}
                                                    marginLeft="0.4rem"
                                                    title="Pool — allocations to its descendants are drawn from here"
                                                />
                                            }
                                        </td>
                                        { months.map((som, i) => {
                                            const allocation = allocMaps[i].get(fund.id) ?? null;
                                            const isLocked = isLockedSom(som);
                                            // An existing allocation stays clickable even when
                                            // eligibility says no (edits re-check server-side)
                                            const isEditable = !isLocked
                                                && (allocation != null || canAllocate(fund, poolAncestor, som));
                                            const title = allocation != null
                                                ? `From ${fundsById.get(allocation.source_fund_id)?.name ?? 'unknown'}`
                                                    + (isLocked ? ' (finalized)' : '')
                                                : isLocked
                                                ? `${monthTitleOf(som)} is read-only (finalized)`
                                                : isEditable
                                                ? `Set ${fund.name}'s allocation for ${monthTitleOf(som)}`
                                                : `${fund.name} cannot receive an allocation in ${monthTitleOf(som)} (fund or pool ancestor not started, or no pool ancestor)`;
                                            return (
                                                <AllocationCell
                                                    key={som}
                                                    fund={fund}
                                                    isFinalized={isLocked}
                                                    allocation={allocation}
                                                    isEditable={isEditable}
                                                    isCurrent={som === currentSom}
                                                    title={title}
                                                    onSet={() => setSetTarget({
                                                        month: som, fundId: fund.id, fund,
                                                        amount: allocation?.amount ?? null,
                                                        monthFrozen: true, fundFrozen: true
                                                    })}
                                                    onDelete={() => setDeleteTarget({ month: som, fund })}
                                                />
                                            );
                                        })}
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            }

            <SetAllocationModal
                isOpen={setTarget != null}
                setIsOpen={(open) => { if ( !open ) setSetTarget(null); }}
                initialMonth={setTarget?.month ?? null}
                initialFundId={setTarget?.fundId ?? null}
                initialFund={setTarget?.fund ?? null}
                initialAmount={setTarget?.amount ?? null}
                monthFrozen={setTarget?.monthFrozen ?? false}
                fundFrozen={setTarget?.fundFrozen ?? false}
            />
            <DeleteAllocationModal
                isOpen={deleteTarget != null}
                setIsOpen={(open) => { if ( !open ) setDeleteTarget(null); }}
                month={deleteTarget?.month ?? null}
                fund={deleteTarget?.fund ?? null}
            />
            <CopyAllocationsModal
                isOpen={copyTarget != null}
                setIsOpen={(open) => { if ( !open ) setCopyTarget(null); }}
                initialFrom={copyTarget?.from ?? null}
                initialTo={copyTarget?.to ?? null}
            />
        </div>
    );
}
