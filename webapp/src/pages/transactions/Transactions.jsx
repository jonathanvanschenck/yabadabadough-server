import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, useSearchParams } from 'react-router';
import dayjs from 'dayjs';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';

import {
    useGetFundsQuery,
    useGetTransactionGroupsQuery,
    useGetFundBalancesQuery,
    useGetMonthFinalizationsQuery,
    useGetFundFinalizationsQuery,
} from '../../hooks/Queries.jsx';
import { MonthPaginator } from '../../components/MonthPaginator.jsx';
import { IconButton } from '../../components/Buttons.jsx';
import {
    CreateTransactionGroupModal,
    TransactionNoteModal,
    FinalizeMonthModal,
    UnfinalizeMonthModal
} from '../../components/SpecialModals.jsx';
import { FinalizedBadge } from '../../components/Badges.jsx';
import Spinner from '../../components/Spinner.jsx';
import { formatDollars } from '../../components/domain.js';
import { fundColorVar } from '../../hooks/fundColors.js';
import {
    monthBoundsOf,
    hasNote,
    buildFundColumnTree,
    visibleColumnsOf,
    allColumnIdsOf,
    netAmountsByFund,
    outsideTotalOf,
    sumOver
} from './utils.jsx';
import styles from './Transactions.module.css';

/**
 * A Set of ids persisted to localStorage (the user's hidden/collapsed column
 * choices survive reloads).
 */
function usePersistedIdSet(storageKey) {
    const [ ids, setIds ] = useState(() => {
        try {
            const stored = JSON.parse(localStorage.getItem(storageKey));
            return new Set(Array.isArray(stored) ? stored : []);
        } catch {
            return new Set();
        }
    });

    useEffect(() => {
        localStorage.setItem(storageKey, JSON.stringify([ ...ids ]));
    }, [storageKey, ids]);

    const toggle = useCallback((id) => {
        setIds(prev => {
            const next = new Set(prev);
            if ( next.has(id) ) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    return [ ids, setIds, toggle ];
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
 * One spreadsheet amount cell: empty when null, red negatives, faint zeros.
 * Fund-column cells (`fund` set) are tinted with the fund's color
 * (`variant`: 'main' for transaction rows, 'muted' for balance rows), carry
 * `data-fund-id` for the delegated column-hover handler, and glow while
 * their column is hovered. `isOmitted` replaces a would-be value with a
 * faint mark (an expanded group's amounts live on the rows below it).
 */
function AmountCell({ value, className = '', fund, variant = 'main', isColHovered = false, isOmitted = false }) {
    const hoverClass = isColHovered ? styles.colHover : '';
    const style = fund ? { backgroundColor: fundColorVar(fund.color, variant) } : undefined;
    return (
        <td
            className={`${styles.amountCell} ${hoverClass} ${value != null ? 'tabular-nums' : ''} ${className}`}
            style={style}
            data-fund-id={fund?.id}
        >
            { value != null && (
                isOmitted
                    ? <span className={styles.omittedMark} title="Shown on the expanded transaction rows below">⋯</span>
                    : <span className={value < 0 ? styles.negative : (value === 0 ? styles.zero : '')}>
                        {formatDollars(value)}
                    </span>
            )}
        </td>
    );
}

/**
 * A "computed balance" row (month totals / balance forward / finalized EOM):
 * label in the description column, one summed cell per fund column.
 */
function BalanceRow({ label, title, map, columns, hoveredFundId, rowClassName = '' }) {
    return (
        <tr className={`${styles.balanceRow} ${rowClassName}`}>
            <td className={`${styles.dateCell} ${styles.stickyCol1}`} />
            <td className={`${styles.descCell} ${styles.stickyCol2}`}>
                <span title={title}>{label}</span>
            </td>
            <td className={`${styles.amountCell} ${styles.stickyCol3}`} />
            { columns.map(col => (
                <AmountCell
                    key={col.fund.id}
                    value={sumOver(map, col.memberIds)}
                    fund={col.fund}
                    variant="muted"
                    isColHovered={col.fund.id === hoveredFundId}
                />
            ))}
            <td className={styles.spacerCell} />
        </tr>
    );
}

/**
 * A transaction group row, plus -- when expanded -- one indented row per
 * transaction line.
 */
function GroupRows({ group, columns, trackedIds, hoveredFundId, isExpanded, onToggleExpand, onShowNote, rowClassName = '' }) {
    const netMap = netAmountsByFund(group.transactions);
    return (<>
        <tr className={`${styles.bodyRow} ${rowClassName}`}>
            <td className={`${styles.dateCell} ${styles.stickyCol1}`}>
                <GhostButton
                    icon={isExpanded ? 'fa-angle-down' : 'fa-angle-right'}
                    title={isExpanded ? 'Collapse transactions' : 'Expand into transactions'}
                    onClick={onToggleExpand}
                />
                <span className="tabular-nums" title={group.date}>{group.date.slice(5)}</span>
            </td>
            <td className={`${styles.descCell} ${styles.stickyCol2}`}>
                <NavLink
                    to={`/transaction-group/${group.id}`}
                    className={styles.descText}
                    title={group.description}
                >
                    {group.description}
                </NavLink>
                { hasNote(group.note) &&
                    <GhostButton
                        icon="fa-circle-info"
                        title="View group note"
                        onClick={() => onShowNote({ group })}
                    />
                }
            </td>
            <AmountCell
                value={outsideTotalOf(group.transactions, trackedIds)}
                className={styles.stickyCol3}
                isOmitted={isExpanded}
            />
            { columns.map(col => (
                <AmountCell
                    key={col.fund.id}
                    value={sumOver(netMap, col.memberIds)}
                    fund={col.fund}
                    isColHovered={col.fund.id === hoveredFundId}
                    isOmitted={isExpanded}
                />
            ))}
            <td className={styles.spacerCell} />
        </tr>
        { isExpanded && group.transactions.map(t => {
            const tMap = netAmountsByFund([ t ]);
            return (
                <tr key={t.id} className={`${styles.bodyRow} ${styles.transactionRow}`}>
                    <td className={`${styles.dateCell} ${styles.stickyCol1}`} />
                    <td className={`${styles.descCell} ${styles.stickyCol2}`}>
                        <NavLink
                            to={`/transaction/${t.id}`}
                            className={`${styles.descText} ${styles.descTextIndent}`}
                            title={t.description}
                        >
                            {t.description}
                        </NavLink>
                        { hasNote(t.note) &&
                            <GhostButton
                                icon="fa-circle-info"
                                title="View transaction note"
                                onClick={() => onShowNote({ transaction: t })}
                            />
                        }
                    </td>
                    <AmountCell value={outsideTotalOf([ t ], trackedIds)} className={styles.stickyCol3} />
                    { columns.map(col => (
                        <AmountCell
                            key={col.fund.id}
                            value={sumOver(tMap, col.memberIds)}
                            fund={col.fund}
                            isColHovered={col.fund.id === hoveredFundId}
                        />
                    ))}
                    <td className={styles.spacerCell} />
                </tr>
            );
        })}
    </>);
}

export default function Page() {
    const [ searchParams, setSearchParams ] = useSearchParams();

    const monthParam = searchParams.get('month');
    const som = /^\d{4}-\d{2}$/.test(monthParam ?? '')
        ? `${monthParam}-01`
        : dayjs().format('YYYY-MM-01');
    const { eom, dayBeforeSom } = monthBoundsOf(som);
    const isCurrentMonth = som === dayjs().format('YYYY-MM-01');
    const monthTitle = dayjs(som).format('MMMM YYYY');

    const setMonth = useCallback((newSom) => {
        setSearchParams(prev => {
            const next = new URLSearchParams(prev);
            next.set('month', newSom.slice(0, 7));
            return next;
        });
    }, [setSearchParams]);

    const [ hiddenIds, setHiddenIds, toggleHidden ] = usePersistedIdSet('transactionsPage.hiddenFundIds');
    const [ collapsedIds, , toggleCollapsed ] = usePersistedIdSet('transactionsPage.collapsedFundIds');
    const [ expandedGroupIds, setExpandedGroupIds ] = useState(() => new Set());
    const [ isCreateOpen, setIsCreateOpen ] = useState(false);
    const [ isFinalizeOpen, setIsFinalizeOpen ] = useState(false);
    const [ isUnfinalizeOpen, setIsUnfinalizeOpen ] = useState(false);
    const [ noteTarget, setNoteTarget ] = useState(null);
    const [ hoveredFundId, setHoveredFundId ] = useState(null);

    // Column hover, delegated: fund cells carry data-fund-id, one handler on
    // the table tracks which column the pointer is in (null elsewhere)
    const handleTableMouseOver = useCallback((event) => {
        const cell = event.target.closest('td, th');
        const fundId = cell?.dataset?.fundId;
        setHoveredFundId(prev => {
            const next = fundId ? parseInt(fundId, 10) : null;
            return prev === next ? prev : next;
        });
    }, []);

    const toggleExpanded = useCallback((groupId) => {
        setExpandedGroupIds(prev => {
            const next = new Set(prev);
            if ( next.has(groupId) ) next.delete(groupId);
            else next.add(groupId);
            return next;
        });
    }, []);

    const fundsQ = useGetFundsQuery();
    const groupsQ = useGetTransactionGroupsQuery({ since: som, until: eom, orderBy: 'date', orderDirection: 'asc' });
    const enteringQ = useGetFundBalancesQuery({ on: dayBeforeSom });
    const eomQ = useGetFundBalancesQuery({ on: eom });
    const monthsQ = useGetMonthFinalizationsQuery();
    const monthFinalization = (monthsQ.data ?? []).find(m => m.som_date === som) ?? null;
    // Months finalize contiguously and unfinalize strictly LIFO, so only two
    // actions ever apply to the viewed month: finalize when it lies past the
    // latest finalized month (a month before the run started can never be
    // finalized), and unfinalize when it IS the latest finalized month
    const latestFinalization = (monthsQ.data ?? []).reduce(
        (latest, m) => (latest == null || m.som_date > latest.som_date) ? m : latest,
        null
    );
    const canFinalize = monthsQ.data != null && monthFinalization == null
        && (latestFinalization == null || som > latestFinalization.som_date);
    const isLatestFinalization = monthFinalization != null && monthFinalization.id === latestFinalization?.id;
    const fundFinalizationsQ = useGetFundFinalizationsQuery(
        { monthId: monthFinalization?.id },
        { enabled: monthFinalization != null }
    );

    const funds = fundsQ.data;

    const trackedIds = useMemo(
        () => new Set((funds ?? []).filter(f => f.status.tracked).map(f => f.id)),
        [funds]
    );
    const columnRoots = useMemo(() => buildFundColumnTree(funds ?? [], eom), [funds, eom]);
    const columns = useMemo(
        () => visibleColumnsOf(columnRoots, hiddenIds, collapsedIds),
        [columnRoots, hiddenIds, collapsedIds]
    );
    const hiddenFunds = useMemo(() => {
        const columnIds = new Set(allColumnIdsOf(columnRoots));
        return (funds ?? []).filter(f => hiddenIds.has(f.id) && columnIds.has(f.id));
    }, [funds, columnRoots, hiddenIds]);

    const enteringMap = useMemo(() => {
        const map = new Map((enteringQ.data ?? []).map(b => [ b.fund_id, b.balance ]));
        // The day-before balances query omits funds starting ON the first of
        // the month; their forward balance into the month IS the start balance
        for ( const f of funds ?? [] ) {
            if ( f.status.tracked && f.start?.date === som && !map.has(f.id) ) {
                map.set(f.id, f.start.forward_balance);
            }
        }
        return map;
    }, [enteringQ.data, funds, som]);
    const eomMap = useMemo(
        () => new Map((eomQ.data ?? []).map(b => [ b.fund_id, b.balance ])),
        [eomQ.data]
    );
    const finalizedEomMap = useMemo(
        () => new Map((fundFinalizationsQ.data ?? []).map(ff => [ ff.fund_id, ff.eom_balance ])),
        [fundFinalizationsQ.data]
    );

    const bodyGroups = useMemo(() =>
        (groupsQ.data ?? [])
            .filter(g => !g.status.eom_cleanup)
            .toSorted((a, b) => a.date === b.date ? a.id - b.id : (a.date < b.date ? -1 : 1)),
        [groupsQ.data]
    );
    const cleanupGroups = useMemo(
        () => (groupsQ.data ?? []).filter(g => g.status.eom_cleanup),
        [groupsQ.data]
    );

    // The header must be tall enough for the angled labels plus one group-bar
    // row per nesting level; the totals row sticks directly beneath it (see
    // --thead-height in the CSS)
    const barRows = columns.reduce((max, col) => Math.max(max, col.bars.length), 0);
    const theadHeightRem = 8 + barRows * 0.4;

    const isPending = fundsQ.isPending || groupsQ.isPending || enteringQ.isPending
        || eomQ.isPending || monthsQ.isPending
        || (monthFinalization != null && fundFinalizationsQ.isPending);
    const queryError = fundsQ.error ?? groupsQ.error ?? enteringQ.error ?? eomQ.error
        ?? monthsQ.error ?? (monthFinalization != null ? fundFinalizationsQ.error : null);

    return (
        <div className={styles.page}>
            <div className={styles.topBar}>
                <div className={styles.topBarSide}>
                    <h1 className={styles.pageTitle}>Transactions</h1>
                    <IconButton
                        text="Add transaction group"
                        icon="fa-square-plus"
                        ariaLabel="Add a new transaction group"
                        onClick={() => setIsCreateOpen(true)}
                    />
                </div>
                <MonthPaginator value={som} onChange={setMonth} />
                <div className={`${styles.topBarSide} ${styles.topBarRight}`}>
                    { canFinalize &&
                        <IconButton
                            text="Finalize month"
                            icon="fa-lock"
                            ariaLabel={`Finalize ${monthTitle}`}
                            title={`Record ${monthTitle}'s end-of-month balances and lock it`}
                            onClick={() => setIsFinalizeOpen(true)}
                        />
                    }
                    { monthFinalization != null &&
                        <IconButton
                            text="Unfinalize month"
                            icon="fa-lock-open"
                            ariaLabel={`Unfinalize ${monthTitle}`}
                            disabled={!isLatestFinalization}
                            title={isLatestFinalization
                                ? `Re-open ${monthTitle} for editing`
                                : 'Only the latest finalized month can be unfinalized'}
                            onClick={() => setIsUnfinalizeOpen(true)}
                        />
                    }
                    <FinalizedBadge value={monthFinalization != null} />
                </div>
            </div>

            { hiddenFunds.length > 0 &&
                <div className={styles.hiddenStrip}>
                    <span className={styles.hiddenStripLabel}>Hidden columns:</span>
                    { hiddenFunds.map(f => (
                        <button
                            key={f.id}
                            type="button"
                            className={styles.hiddenChip}
                            onClick={() => toggleHidden(f.id)}
                            title={`Show the ${f.name} column`}
                        >
                            <span style={{ color: fundColorVar(f.color, 'text') }}>{f.name}</span>
                            <FontAwesomeIcon icon="fa-solid fa-eye" size="xs" />
                        </button>
                    ))}
                    <button
                        type="button"
                        className={styles.hiddenStripShowAll}
                        onClick={() => setHiddenIds(new Set())}
                    >
                        show all
                    </button>
                </div>
            }

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
                : <div className={styles.tableScroll} style={{ '--thead-height': `${theadHeightRem}rem` }}>
                    <table
                        className={styles.table}
                        onMouseOver={handleTableMouseOver}
                        onMouseLeave={() => setHoveredFundId(null)}
                    >
                        <thead>
                            <tr>
                                <th className={`${styles.leadTh} ${styles.stickyCol1}`}>Date</th>
                                <th className={`${styles.leadTh} ${styles.stickyCol2}`}>Description</th>
                                <th
                                    className={`${styles.leadTh} ${styles.leadThAmount} ${styles.stickyCol3}`}
                                    title="Net flow in from outside the tracked funds: positive from untracked sources, negative to untracked targets, zero between tracked funds"
                                >
                                    Total
                                </th>
                                { columns.map((col, colIndex) => (
                                    // Descending z-index: each sticky th is a stacking
                                    // context, so without this a column's opaque
                                    // background clips the previous column's angled
                                    // label where it overhangs to the right
                                    <th
                                        key={col.fund.id}
                                        className={`${styles.fundTh} ${col.fund.id === hoveredFundId ? styles.colHover : ''}`}
                                        // --fund-base-height is the split line between the
                                        // upright base rectangle (bars/controls) and the
                                        // skewed label parallelogram; it clears the bar rows
                                        style={{ zIndex: 80 - colIndex, '--fund-base-height': `calc(1.7rem + ${barRows * 0.4}rem)` }}
                                        data-fund-id={col.fund.id}
                                    >
                                        <div className={styles.fundThBase} />
                                        <div className={styles.fundThSlant} />
                                        <div
                                            className={styles.fundThLabel}
                                            style={{ bottom: 'var(--fund-base-height)' }}
                                        >
                                            <span
                                                title={col.fund.name + (col.isCollapsed ? ' (including collapsed children)' : '')}
                                                style={{ color: fundColorVar(col.fund.color, 'text') }}
                                            >
                                                {col.isCollapsed ? `${col.fund.name} +` : col.fund.name}
                                            </span>
                                        </div>
                                        { barRows > 0 &&
                                            // One stacked segment per nesting level; adjacent
                                            // segments of the same group read as a single bar
                                            // spanning that group's subtree. Deepest level on
                                            // TOP (row d shows bars[barRows - 1 - d], so the
                                            // outermost group always sits on the bottom row)
                                            <div className={styles.fundThBars}>
                                                { Array.from({ length: barRows }, (_, d) => {
                                                    const bar = col.bars[barRows - 1 - d];
                                                    return (
                                                        <div
                                                            key={d}
                                                            className={styles.fundThBar}
                                                            style={{
                                                                backgroundColor: bar
                                                                    ? fundColorVar(bar.color, 'dot')
                                                                    : 'transparent'
                                                            }}
                                                            title={bar?.name}
                                                        />
                                                    );
                                                })}
                                            </div>
                                        }
                                        <div className={styles.fundThControls}>
                                            { col.hasChildren &&
                                                <GhostButton
                                                    icon={col.isCollapsed ? 'fa-square-plus' : 'fa-square-minus'}
                                                    title={col.isCollapsed
                                                        ? `Expand the children of ${col.fund.name}`
                                                        : `Collapse the children of ${col.fund.name} into this column`}
                                                    onClick={() => toggleCollapsed(col.fund.id)}
                                                />
                                            }
                                            <GhostButton
                                                icon="fa-eye-slash"
                                                title={`Hide the ${col.fund.name} column`}
                                                onClick={() => toggleHidden(col.fund.id)}
                                            />
                                        </div>
                                    </th>
                                ))}
                                <th className={styles.spacerTh} style={{ zIndex: 79 - columns.length }} />
                            </tr>
                        </thead>
                        <tbody>
                            <BalanceRow
                                label={`${monthTitle} totals`}
                                title={`Each fund's balance at the end of ${monthTitle}: balance forward plus every transaction in the month, end-of-month cleanups included`}
                                map={eomMap}
                                columns={columns}
                                hoveredFundId={hoveredFundId}
                                rowClassName={styles.totalsRow}
                            />
                            <BalanceRow
                                label="Balance forward"
                                title={`Each fund's balance entering ${monthTitle} (every transaction before the 1st)`}
                                map={enteringMap}
                                columns={columns}
                                hoveredFundId={hoveredFundId}
                                rowClassName={styles.forwardRow}
                            />
                            { bodyGroups.length === 0 &&
                                <tr>
                                    <td className={styles.emptyState} colSpan={4 + columns.length}>
                                        No transactions in {monthTitle}
                                    </td>
                                </tr>
                            }
                            { bodyGroups.map(group => (
                                <GroupRows
                                    key={group.id}
                                    group={group}
                                    columns={columns}
                                    trackedIds={trackedIds}
                                    hoveredFundId={hoveredFundId}
                                    isExpanded={expandedGroupIds.has(group.id)}
                                    onToggleExpand={() => toggleExpanded(group.id)}
                                    onShowNote={setNoteTarget}
                                />
                            ))}
                            { monthFinalization != null && <>
                                <BalanceRow
                                    label="End of month"
                                    title={`Each fund's finalized end-of-month balance -- before the end-of-month cleanup below (the surplus/loss snapshot)`}
                                    map={finalizedEomMap}
                                    columns={columns}
                                    hoveredFundId={hoveredFundId}
                                    rowClassName={styles.finalizedRow}
                                />
                                { cleanupGroups.map(group => (
                                    <GroupRows
                                        key={group.id}
                                        group={group}
                                        columns={columns}
                                        trackedIds={trackedIds}
                                    hoveredFundId={hoveredFundId}
                                        isExpanded={expandedGroupIds.has(group.id)}
                                        onToggleExpand={() => toggleExpanded(group.id)}
                                        onShowNote={setNoteTarget}
                                        rowClassName={styles.cleanupRow}
                                    />
                                ))}
                            </>}
                        </tbody>
                    </table>
                </div>
            }

            <CreateTransactionGroupModal
                isOpen={isCreateOpen}
                setIsOpen={setIsCreateOpen}
                initialDate={isCurrentMonth ? null : som}
            />
            <FinalizeMonthModal
                isOpen={isFinalizeOpen}
                setIsOpen={setIsFinalizeOpen}
                initialMonth={som}
            />
            <UnfinalizeMonthModal
                isOpen={isUnfinalizeOpen}
                setIsOpen={setIsUnfinalizeOpen}
                monthFinalization={monthFinalization}
            />

            <TransactionNoteModal
                isOpen={noteTarget != null}
                setIsOpen={(open) => { if ( !open ) setNoteTarget(null); }}
                group={noteTarget?.group ?? null}
                transaction={noteTarget?.transaction ?? null}
            />
        </div>
    );
}
