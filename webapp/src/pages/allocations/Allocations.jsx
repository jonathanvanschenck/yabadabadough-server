import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import dayjs from 'dayjs';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';

import {
    useGetFundsQuery,
    useGetMonthFinalizationsQuery,
    useGetAllocationsForMonthsQuery,
} from '../../hooks/Queries.jsx';
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
import { monthRange, fundRowsOf, nearestPoolAncestorOf, canAllocate } from './utils.jsx';
import styles from './Allocations.module.css';

/** Buffer of future months kept past today (and past a deep-linked month) so
 * future allocations stay reachable and a deep-linked month is never pinned to
 * the far-right edge. */
const FUTURE_MONTHS = 3;
/** Months in the initial window, before any scroll-loading in either direction. */
const INITIAL_MONTHS = 15;
/** Months grown onto an edge each time the strip nears it. */
const LOAD_CHUNK = 12;
/** Never load more than this many months total (runaway guard). */
const MAX_MONTHS = 600;
/** Grow the window once the scroll gets within this many px of an edge. */
const LOAD_THRESHOLD_PX = 260;

/** First-of-month string `n` months from `som` (n may be negative). */
function shiftMonth(som, n) {
    return dayjs(som).add(n, 'month').format('YYYY-MM-01');
}

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
 * One allocation cell. The value fills the cell; two FIXED action slots sit on
 * the right so nothing shifts on hover: an always-present (muted) edit/add
 * glyph, and -- only on filled cells -- a delete glyph revealed on cell hover.
 * Every alloc cell reserves the slot width, so the number column stays aligned
 * across editable, finalized, and inert cells. Finalized months are static;
 * open months are click-to-set (or click-to-edit). A fund that cannot receive
 * an allocation that month (not started, or no started pool ancestor) is inert.
 */
function AllocationCell({ fund, allocation, isFinalized, isEditable, isCurrent, title, onSet, onDelete }) {
    const filled = allocation != null;
    return (
        <td
            className={[
                styles.allocCell,
                'tabular-nums',
                isEditable ? styles.editableCell : '',
                isFinalized ? styles.finalizedCell : '',
                !isEditable && !isFinalized && !filled ? styles.inertCell : '',
                isCurrent ? styles.currentMonthCell : '',
            ].join(' ')}
            style={{ backgroundColor: fundColorVar(fund.color, 'muted') }}
            onClick={isEditable ? onSet : undefined}
            title={title}
        >
            <div className={styles.cellInner}>
                <span className={styles.cellValue}>
                    { filled ? formatDollars(allocation.amount) : '' }
                </span>
                <span className={styles.cellActions}>
                    { isEditable &&
                        <>
                            <span className={styles.editSlot} aria-hidden="true">
                                <FontAwesomeIcon
                                    icon={`fa-solid ${filled ? 'fa-pen-to-square' : 'fa-square-plus'}`}
                                    size="xs"
                                />
                            </span>
                            <span className={styles.deleteSlot}>
                                { filled &&
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
                            </span>
                        </>
                    }
                </span>
            </div>
        </td>
    );
}

export default function Page() {
    const [ searchParams ] = useSearchParams();

    // `?month=` is an INITIAL scroll target only (read once on mount): the strip
    // is a continuous scrolling window, not a paginated selection, so we never
    // write the param back as the view moves.
    const initialMonthRef = useRef(null);
    if ( initialMonthRef.current === null ) {
        const m = searchParams.get('month');
        initialMonthRef.current = /^\d{4}-\d{2}$/.test(m ?? '') ? `${m}-01` : '';
    }
    const initialMonth = initialMonthRef.current || null;

    const currentSom = dayjs().format('YYYY-MM-01');

    // The window is bounded by two growable edges: `newestSom` extends right on
    // forward scroll, `oldestSom` extends left on backward scroll. Both are
    // seeded once from today (and any deep-linked month), then only ever move
    // outward. A future buffer is always kept past the newest content so a
    // deep-linked month is never pinned to the far-right edge.
    const initialEdges = useMemo(() => {
        const bufferedNewest = shiftMonth(currentSom, FUTURE_MONTHS);
        // Keep the future buffer past a deep-linked month too, so it lands as
        // the focus with context on both sides rather than at the very edge.
        const newest = ( initialMonth && initialMonth > bufferedNewest )
            ? shiftMonth(initialMonth, FUTURE_MONTHS)
            : bufferedNewest;
        let oldest = shiftMonth(newest, -(INITIAL_MONTHS - 1));
        // Widen the initial window leftward so a past deep-link is included
        // (with a couple of months of context before it).
        if ( initialMonth && initialMonth < oldest ) oldest = shiftMonth(initialMonth, -2);
        return { oldest, newest };
    // currentSom/initialMonth are stable for the page's life; seed once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const [ oldestSom, setOldestSom ] = useState(initialEdges.oldest);
    const [ newestSom, setNewestSom ] = useState(initialEdges.newest);
    const oldestSomRef = useRef(oldestSom);
    oldestSomRef.current = oldestSom;
    const newestSomRef = useRef(newestSom);
    newestSomRef.current = newestSom;

    const months = useMemo(() => monthRange(oldestSom, newestSom), [oldestSom, newestSom]);
    const monthsLenRef = useRef(months.length);
    monthsLenRef.current = months.length;
    const windowEom = useMemo(() => dayjs(newestSom).endOf('month').format('YYYY-MM-DD'), [newestSom]);

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
    // One Map per month column: fund_id -> allocation (a still-loading older
    // month is `undefined` -> empty map, so its column renders then fills in)
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

    // The full-page spinner covers ONLY the first load: funds/finalizations
    // pending, or no allocation month resolved yet. Once anything has data we
    // render, so scroll-loaded older months fill in place instead of blanking
    // the whole grid.
    const isInitialPending = fundsQ.isPending || monthsQ.isPending
        || (months.length > 0 && allocationsQ.data.every(d => d === undefined));
    const queryError = fundsQ.error ?? monthsQ.error ?? allocationsQ.error;

    // ---- Continuous horizontal scroll: grow the window at whichever edge the
    // scroll approaches (older months on the left, future months on the right) ----
    const scrollRef = useRef(null);
    const prependAnchorRef = useRef(null);   // { width, left } captured before a left-grow
    const didInitialScrollRef = useRef(false);

    const onScroll = useCallback(() => {
        const el = scrollRef.current;
        // A left-grow is in flight (position not yet restored) or we've hit the
        // total-months cap -- nothing to do.
        if ( !el || prependAnchorRef.current ) return;
        if ( monthsLenRef.current >= MAX_MONTHS ) return;
        if ( el.scrollLeft <= LOAD_THRESHOLD_PX ) {
            // Near the left edge: prepend older months. Growing on the LEFT
            // shifts existing content right, so capture an anchor to restore.
            prependAnchorRef.current = { width: el.scrollWidth, left: el.scrollLeft };
            setOldestSom(som => shiftMonth(som, -LOAD_CHUNK));
        } else if ( el.scrollLeft >= el.scrollWidth - el.clientWidth - LOAD_THRESHOLD_PX ) {
            // Near the right edge: append future months. Growing on the RIGHT
            // leaves existing content in place, so no scroll restore is needed.
            setNewestSom(som => shiftMonth(som, LOAD_CHUNK));
        }
    }, []);

    // A left-grow adds content on the LEFT, so restore the scroll offset by the
    // width just added -- the visible months stay put instead of jumping. (A
    // right-grow changes newestSom, not oldestSom, so it never triggers this.)
    useLayoutEffect(() => {
        const el = scrollRef.current;
        const anchor = prependAnchorRef.current;
        if ( el && anchor ) {
            el.scrollLeft = anchor.left + (el.scrollWidth - anchor.width);
            prependAnchorRef.current = null;
        }
    }, [oldestSom]);

    // Initial position (once, after first data): the deep-linked month scrolled
    // just past the sticky fund column, else the newest month at the far right.
    useLayoutEffect(() => {
        if ( isInitialPending || didInitialScrollRef.current ) return;
        const el = scrollRef.current;
        if ( !el ) return;
        didInitialScrollRef.current = true;
        if ( initialMonth ) {
            const th = el.querySelector(`[data-som="${initialMonth}"]`);
            if ( th ) {
                const stickyW = el.querySelector(`.${styles.stickyCol}`)
                    ?.getBoundingClientRect().width ?? 0;
                el.scrollLeft += th.getBoundingClientRect().left
                    - el.getBoundingClientRect().left - stickyW - 8;
                return;
            }
        }
        el.scrollLeft = el.scrollWidth;
    }, [isInitialPending, initialMonth]);

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
                            month: currentSom, fundId: null, fund: null, amount: null,
                            monthFrozen: false, fundFrozen: false
                        })}
                    />
                    <IconButton
                        text="Copy month"
                        icon="fa-copy"
                        ariaLabel="Copy one month's allocations into another"
                        onClick={() => setCopyTarget({
                            from: currentSom,
                            to: dayjs(currentSom).add(1, 'month').format('YYYY-MM-01')
                        })}
                    />
                </div>
                <div className={`${styles.topBarSide} ${styles.topBarRight}`}>
                    <FontAwesomeIcon icon="fa-solid fa-chevron-left" size="xs" />
                    <span>Scroll for past &amp; future months</span>
                    <FontAwesomeIcon icon="fa-solid fa-chevron-right" size="xs" />
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
                : isInitialPending
                ? <div className={styles.centerState}><Spinner size="2rem" /></div>
                : <div className={styles.tableScroll} ref={scrollRef} onScroll={onScroll}>
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
                                            data-som={som}
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
                                        <div className={styles.cellInner}>
                                            <span className={styles.cellValue}>
                                                { monthTotals[i] != null && formatDollars(monthTotals[i]) }
                                            </span>
                                            <span className={styles.cellActions} />
                                        </div>
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
