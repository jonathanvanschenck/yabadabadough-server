import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
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
    DeleteTransactionGroupModal,
    FinalizeMonthModal,
    UnfinalizeMonthModal
} from '../../components/SpecialModals.jsx';
import { useAuthRoles } from '../../contexts/AuthContext.jsx';
import { FinalizedBadge, FundLabel } from '../../components/Badges.jsx';
import { HoverPopover } from '../../components/HoverPopover.jsx';
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
    outsideBreakdownOf,
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

/**
 * Run a column-layout change (collapse/hide) inside a View Transition, so the
 * columns it adds or removes cross-fade rather than blinking in and out --
 * collapsing a wide subtree used to vanish half the sheet in one frame.
 *
 * `startViewTransition` snapshots the DOM before and after its callback, so the
 * React state update inside must be applied synchronously (flushSync).
 * Unsupported browsers and reduced-motion users just get the plain update.
 */
function withColumnTransition(mutate) {
    const canAnimate = typeof document.startViewTransition === 'function'
        && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if ( !canAnimate ) { mutate(); return; }
    document.startViewTransition(() => flushSync(mutate));
}

/** Tiny borderless icon button -- the page's "subtle, icon-only" affordance. */
function GhostButton({ icon, title, onClick, disabled = false, className = '' }) {
    return (
        <button
            type="button"
            className={`${styles.ghostButton} ${className}`}
            onClick={onClick}
            title={title}
            aria-label={title}
            disabled={disabled}
        >
            <FontAwesomeIcon icon={`fa-solid ${icon}`} size="xs" />
        </button>
    );
}

/**
 * The per-untracked-fund breakdown of a Total cell, shown in its hover/pin
 * popover: each untracked fund that money crossed to/from, and the net total.
 */
function OutsideBreakdown({ breakdown, total }) {
    return (
        <div className={styles.breakdownPopover}>
            <div className={styles.breakdownTitle}>Flow from untracked funds</div>
            { breakdown.map(({ fundId, fund, amount }) => (
                <div key={fundId} className={styles.breakdownRow}>
                    { fund
                        ? <FundLabel fund={fund} />
                        : <span className={styles.breakdownUnknown}>Fund #{fundId}</span> }
                    <span className={`tabular-nums ${amount < 0 ? styles.negative : ''}`}>
                        {formatDollars(amount)}
                    </span>
                </div>
            ))}
            <div className={`${styles.breakdownRow} ${styles.breakdownNet}`}>
                <span>Net</span>
                <span className={`tabular-nums ${total < 0 ? styles.negative : ''}`}>
                    {formatDollars(total)}
                </span>
            </div>
        </div>
    );
}

/**
 * One spreadsheet amount cell: empty when null, red negatives, faint zeros.
 * Fund-column cells (`fund` set) are tinted with the fund's color
 * (`variant`: 'main' for transaction rows, 'muted' for balance rows), carry
 * `data-fund-id` for the delegated column-hover handler, and glow while
 * their column is hovered. `isOmitted` replaces a would-be value with a
 * faint mark (an expanded group's amounts live on the rows below it).
 *
 * A `selKey` (with `selCol`) makes the cell selectable for the sum tool. EVERY
 * cell in a selectable column is a selectable position -- it carries the key
 * and highlights while `selected` -- but only one that HOLDS a value also emits
 * `data-sel-value`. So a rectangle select covers empty cells (the region reads
 * as one solid block) without them contributing to the sum or the cell count.
 * Passing `breakdown` (any array, even empty) marks this as a Total
 * cell: it reserves a fixed icon slot to the RIGHT of the number -- so every
 * Total-column number aligns whether or not it has a breakdown -- and, when the
 * array is non-empty, fills that slot with the info affordance opening the
 * untracked-fund breakdown popover.
 */
function AmountCell({
    value, className = '', fund, variant = 'main', isColHovered = false, isOmitted = false,
    selKey = null, selCol = null, selected = null, breakdown = null
}) {
    const hasValue = selKey != null && value != null && !isOmitted;
    const hoverClass = isColHovered ? styles.colHover : '';
    const selectedClass = selKey != null && selected != null ? styles.selected : '';
    // Only the sides of this cell that lie on the selection's boundary get a
    // rule, so a multi-cell region is outlined once rather than cell by cell
    const edges = selected?.edges ?? '';
    const ring = [];
    if ( edges.includes('t') ) ring.push('inset 0 2px 0 0 var(--u-info)');
    if ( edges.includes('b') ) ring.push('inset 0 -2px 0 0 var(--u-info)');
    if ( edges.includes('l') ) ring.push('inset 2px 0 0 0 var(--u-info)');
    if ( edges.includes('r') ) ring.push('inset -2px 0 0 0 var(--u-info)');
    const style = {
        ...(fund ? { backgroundColor: fundColorVar(fund.color, variant) } : {}),
        ...(ring.length > 0 ? { boxShadow: ring.join(', ') } : {})
    };
    const isTotalCell = breakdown != null; // reserve the aligned icon slot
    const hasBreakdown = isTotalCell && breakdown.length > 0 && value != null && !isOmitted;
    return (
        <td
            className={`${styles.amountCell} ${hoverClass} ${selectedClass} ${value != null ? 'tabular-nums' : ''} ${className}`}
            style={style}
            data-fund-id={fund?.id}
            data-sel-key={selKey ?? undefined}
            data-sel-col={selKey != null ? selCol : undefined}
            data-sel-value={hasValue ? value : undefined}
        >
            { value != null && (
                isOmitted
                    ? <span className={styles.omittedMark} title="Shown on the expanded transaction rows below">⋯</span>
                    : <>
                        <span className={value < 0 ? styles.negative : (value === 0 ? styles.zero : '')}>
                            {formatDollars(value)}
                        </span>
                        { isTotalCell &&
                            <span className={styles.breakdownSlot}>
                                { hasBreakdown &&
                                    <HoverPopover
                                        triggerClassName={styles.breakdownTrigger}
                                        trigger={<FontAwesomeIcon icon="fa-solid fa-circle-info" size="xs" />}
                                    >
                                        <OutsideBreakdown breakdown={breakdown} total={value} />
                                    </HoverPopover>
                                }
                            </span>
                        }
                    </>
            )}
        </td>
    );
}

/**
 * A "computed balance" row (month totals / balance forward / finalized EOM):
 * label in the description column, one summed cell per fund column.
 *
 * A `selPrefix` makes the fund cells selectable for the sum tool (keyed
 * `<selPrefix>:<col>`, col aligned with the group rows' fund columns so a
 * rectangle can span both); the balance-forward row opts in.
 */
function BalanceRow({ label, title, map, columns, hoveredFundId, rowClassName = '', selPrefix = null, selectedKeys = null }) {
    return (
        <tr className={`${styles.balanceRow} ${rowClassName}`}>
            <td className={`${styles.dateCell} ${styles.stickyCol1}`} />
            <td className={`${styles.descCell} ${styles.stickyCol2}`}>
                <span title={title}>{label}</span>
            </td>
            <td className={`${styles.amountCell} ${styles.stickyCol3}`} />
            { columns.map((col, i) => {
                const selKey = selPrefix != null ? `${selPrefix}:${i + 1}` : null;
                return (
                    <AmountCell
                        key={col.fund.id}
                        value={sumOver(map, col.memberIds)}
                        fund={col.fund}
                        variant="muted"
                        isColHovered={col.fund.id === hoveredFundId}
                        selKey={selKey}
                        selCol={selKey != null ? i + 1 : null}
                        selected={selKey != null && selectedKeys != null ? selectedKeys.get(selKey) ?? null : null}
                    />
                );
            })}
            <td className={styles.spacerCell} />
        </tr>
    );
}

/**
 * A transaction group row, plus -- when expanded -- one indented row per
 * transaction line.
 */
function GroupRows({ group, columns, trackedIds, fundsById, selectedKeys, hoveredFundId, isExpanded, onToggleExpand, onShowNote, onDeleteGroup, isMonthFinalized = false, isEditor = false, rowClassName = '' }) {
    const netMap = netAmountsByFund(group.transactions);
    const isSpecial = group.status.allocation || group.status.eom_cleanup;
    const deleteDisabledReason = !isEditor
        ? 'Editor role required to delete transaction groups'
        : isSpecial
        ? `Managed ${group.status.allocation ? 'allocation' : 'end-of-month cleanup'} groups cannot be deleted`
        : isMonthFinalized
        ? 'This month is finalized — unfinalize it to delete groups'
        : null;
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
                <GhostButton
                    icon="fa-trash"
                    className={styles.ghostDelete}
                    title={deleteDisabledReason ?? 'Delete this transaction group'}
                    disabled={deleteDisabledReason != null}
                    onClick={() => onDeleteGroup(group)}
                />
            </td>
            <AmountCell
                value={outsideTotalOf(group.transactions, trackedIds)}
                className={styles.stickyCol3}
                isOmitted={isExpanded}
                selKey={`g${group.id}:0`}
                selCol={0}
                selected={selectedKeys.get(`g${group.id}:0`) ?? null}
                breakdown={isExpanded ? null : outsideBreakdownOf(group.transactions, trackedIds, fundsById)}
            />
            { columns.map((col, i) => {
                const selKey = `g${group.id}:${i + 1}`;
                return (
                    <AmountCell
                        key={col.fund.id}
                        value={sumOver(netMap, col.memberIds)}
                        fund={col.fund}
                        isColHovered={col.fund.id === hoveredFundId}
                        isOmitted={isExpanded}
                        selKey={selKey}
                        selCol={i + 1}
                        selected={selectedKeys.get(selKey) ?? null}
                    />
                );
            })}
            <td className={styles.spacerCell} />
        </tr>
        { isExpanded && group.transactions.map(t => {
            const tMap = netAmountsByFund([ t ]);
            return (
                <tr key={t.id} className={`${styles.bodyRow} ${styles.transactionRow}`}>
                    <td className={`${styles.dateCell} ${styles.stickyCol1}`} />
                    <td className={`${styles.descCell} ${styles.stickyCol2}`}>
                        <NavLink
                            to={`/transaction-group/${group.id}#transaction-${t.id}`}
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
                    <AmountCell
                        value={outsideTotalOf([ t ], trackedIds)}
                        className={styles.stickyCol3}
                        selKey={`t${t.id}:0`}
                        selCol={0}
                        selected={selectedKeys.get(`t${t.id}:0`) ?? null}
                        breakdown={outsideBreakdownOf([ t ], trackedIds, fundsById)}
                    />
                    { columns.map((col, i) => {
                        const selKey = `t${t.id}:${i + 1}`;
                        return (
                            <AmountCell
                                key={col.fund.id}
                                value={sumOver(tMap, col.memberIds)}
                                fund={col.fund}
                                isColHovered={col.fund.id === hoveredFundId}
                                selKey={selKey}
                                selCol={i + 1}
                                selected={selectedKeys.get(selKey) ?? null}
                            />
                        );
                    })}
                    <td className={styles.spacerCell} />
                </tr>
            );
        })}
    </>);
}

/**
 * Spreadsheet-style selection of amount cells (`data-sel-*`) for the sum tool.
 * Click sets an anchor and selects one cell; drag paints a rectangle from the
 * anchor; shift-click / shift-drag keep the existing anchor and extend to the
 * pointer; ctrl/cmd-click / ctrl-drag UNION a fresh rectangle onto the existing
 * selection (accumulate disjoint ranges) instead of replacing it. Coordinates
 * are read fresh from the DOM at each gesture (row = index among tbody rows,
 * col = `data-sel-col`), so nothing is stored that expansion or column changes
 * could make stale.
 *
 * EVERY cell in a selectable column is a position, whether or not it holds a
 * number, so a gesture can start, cross, and end on blank cells and the painted
 * rectangle is the full solid region the user dragged over. Selection is a Map
 * of cell key → value-or-null; the readout sums (and counts) only the non-null
 * ones, so blanks in the region never skew the total. Escape and any pointerdown
 * outside a selectable cell / the readout clear it.
 */
function useCellSelection(tableRef) {
    const [ selection, setSelection ] = useState(() => new Map());
    const selectionRef = useRef(selection); // latest selection for additive snapshots
    selectionRef.current = selection;
    const dragRef = useRef(null);       // { anchorKey, additive, base } while a drag is active
    const anchorKeyRef = useRef(null);  // survives gestures (shift extends from it)

    const clearSelection = useCallback(() => {
        anchorKeyRef.current = null;
        setSelection(prev => (prev.size === 0 ? prev : new Map()));
    }, []);

    const coordsOfCell = useCallback((cell) => {
        const table = tableRef.current;
        if ( table == null || cell == null ) return null;
        const rows = Array.from(table.querySelectorAll('tbody tr'));
        const row = rows.indexOf(cell.closest('tr'));
        if ( row < 0 ) return null;
        return { row, col: parseInt(cell.dataset.selCol, 10) };
    }, [tableRef]);

    const coordsOfKey = useCallback((key) => {
        const table = tableRef.current;
        if ( table == null || key == null ) return null;
        return coordsOfCell(table.querySelector(`[data-sel-key="${key}"]`));
    }, [tableRef, coordsOfCell]);

    /** Strip the edge decoration back to a plain key → value map. */
    const rawOf = useCallback((map) => {
        const out = new Map();
        for ( const [ k, entry ] of map ) out.set(k, entry.value);
        return out;
    }, []);

    /**
     * Tag every selected key with which of its four sides lie on the
     * selection's BOUNDARY (a `tblr` subset), so the region paints as one
     * outlined block rather than a grid of individually ringed cells.
     * Neighbours are read off the live DOM grid, so this handles the ctrl-union
     * of disjoint rectangles as naturally as a single one.
     */
    const withEdges = useCallback((raw) => {
        const table = tableRef.current;
        const out = new Map();
        if ( table == null ) {
            for ( const [ k, value ] of raw ) out.set(k, { value, edges: 'tblr' });
            return out;
        }
        const keyAt = new Map();  // "row:col" → key
        const posOf = new Map();  // key → [ row, col ]
        Array.from(table.querySelectorAll('tbody tr')).forEach((tr, r) => {
            tr.querySelectorAll('[data-sel-key]').forEach(cell => {
                const c = parseInt(cell.dataset.selCol, 10);
                keyAt.set(`${r}:${c}`, cell.dataset.selKey);
                posOf.set(cell.dataset.selKey, [ r, c ]);
            });
        });
        const isSelected = (r, c) => {
            const k = keyAt.get(`${r}:${c}`);
            return k != null && raw.has(k);
        };
        for ( const [ key, value ] of raw ) {
            const pos = posOf.get(key);
            if ( pos == null ) { out.set(key, { value, edges: 'tblr' }); continue; }
            const [ r, c ] = pos;
            let edges = '';
            if ( !isSelected(r - 1, c) ) edges += 't';
            if ( !isSelected(r + 1, c) ) edges += 'b';
            if ( !isSelected(r, c - 1) ) edges += 'l';
            if ( !isSelected(r, c + 1) ) edges += 'r';
            out.set(key, { value, edges });
        }
        return out;
    }, [tableRef]);

    const commit = useCallback((raw) => setSelection(withEdges(raw)), [withEdges]);

    const collectRect = useCallback((a, b) => {
        const table = tableRef.current;
        const out = new Map();
        if ( table == null || a == null || b == null ) return out;
        const minR = Math.min(a.row, b.row), maxR = Math.max(a.row, b.row);
        const minC = Math.min(a.col, b.col), maxC = Math.max(a.col, b.col);
        Array.from(table.querySelectorAll('tbody tr')).forEach((tr, ri) => {
            if ( ri < minR || ri > maxR ) return;
            tr.querySelectorAll('[data-sel-key]').forEach(cell => {
                const c = parseInt(cell.dataset.selCol, 10);
                if ( c < minC || c > maxC ) return;
                // Valueless positions join the region as null -- highlighted,
                // but invisible to the sum and the count
                const raw = cell.dataset.selValue;
                out.set(cell.dataset.selKey, raw == null ? null : Number(raw));
            });
        });
        return out;
    }, [tableRef]);

    const updateFromDrag = useCallback((targetCell) => {
        if ( dragRef.current == null ) return;
        const { anchorKey, additive, base } = dragRef.current;
        const anchor = coordsOfKey(anchorKey);
        const target = coordsOfCell(targetCell);
        if ( anchor == null || target == null ) return;
        const rect = collectRect(anchor, target);
        if ( !additive ) { commit(rect); return; }
        const merged = new Map(base);
        for ( const [ k, v ] of rect ) merged.set(k, v);
        commit(merged);
    }, [coordsOfKey, coordsOfCell, collectRect, commit]);

    // Track the pointer through the drag (over any cell, even under the header)
    useEffect(() => {
        const onMove = (e) => {
            if ( dragRef.current == null ) return;
            // `[data-sel-col]` (not `-key`) so the rectangle keeps tracking across
            // empty cells -- a drag needn't stay over filled cells to grow.
            const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-sel-col]');
            if ( cell != null && tableRef.current?.contains(cell) ) updateFromDrag(cell);
        };
        const onUp = () => { dragRef.current = null; };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
    }, [tableRef, updateFromDrag]);

    const onTablePointerDown = useCallback((e) => {
        if ( e.button !== 0 ) return; // primary button only
        const cell = e.target.closest?.('[data-sel-key]');
        if ( cell == null ) return; // clearing is handled by the document listener
        const target = coordsOfCell(cell);
        if ( target == null ) return;
        e.preventDefault(); // no native text selection while dragging
        // Ctrl/Cmd: anchor a NEW rectangle here and union it onto the existing
        // selection (snapshotted as `base`), so a further drag keeps adding.
        if ( e.ctrlKey || e.metaKey ) {
            anchorKeyRef.current = cell.dataset.selKey;
            const base = rawOf(selectionRef.current);
            dragRef.current = { anchorKey: anchorKeyRef.current, additive: true, base };
            const merged = new Map(base);
            for ( const [ k, v ] of collectRect(target, target) ) merged.set(k, v);
            commit(merged);
            return;
        }
        const keepAnchor = e.shiftKey && coordsOfKey(anchorKeyRef.current) != null;
        if ( !keepAnchor ) anchorKeyRef.current = cell.dataset.selKey;
        dragRef.current = { anchorKey: anchorKeyRef.current, additive: false, base: null };
        commit(collectRect(coordsOfKey(anchorKeyRef.current) ?? target, target));
    }, [coordsOfCell, coordsOfKey, collectRect, commit, rawOf]);

    // Escape clears; any pointerdown outside a selectable cell / the readout clears
    useEffect(() => {
        const onKeyDown = (e) => { if ( e.key === 'Escape' ) clearSelection(); };
        const onPointerDown = (e) => {
            // A blank selectable cell carries data-sel-col (no key); clicking it
            // must not count as "outside" and clear -- the table handler no-ops it.
            const inCell = e.target.closest?.('[data-sel-col]');
            const inReadout = e.target.closest?.('[data-selection-readout]');
            if ( inCell == null && inReadout == null ) clearSelection();
        };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('pointerdown', onPointerDown, true);
        };
    }, [clearSelection]);

    let sum = 0, count = 0;
    for ( const { value } of selection.values() ) {
        if ( value == null ) continue; // a blank position in the region
        sum += value;
        count += 1;
    }
    return {
        selectedKeys: selection,
        onTablePointerDown,
        clearSelection,
        sum,
        count,
        hasSelection: selection.size > 0
    };
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
    const [ deleteTarget, setDeleteTarget ] = useState(null);
    const [ hoveredFundId, setHoveredFundId ] = useState(null);

    const roles = useAuthRoles();
    const isEditor = !!roles.editor;

    const tableRef = useRef(null);
    const {
        selectedKeys,
        onTablePointerDown,
        clearSelection,
        sum: selectionSum,
        count: selectionCount,
        hasSelection
    } = useCellSelection(tableRef);

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
    // Any finalized month can now be unfinalized: the LATEST directly, an
    // earlier one by cascading (recursive unfinalize of it + every later
    // month). The modal spells out exactly which months that touches.
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
    const fundsById = useMemo(
        () => new Map((funds ?? []).map(f => [ f.id, f ])),
        [funds]
    );
    const columnRoots = useMemo(() => buildFundColumnTree(funds ?? [], eom, som), [funds, eom, som]);
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

    // Selection keys are re-resolved from the DOM each gesture, but a selected
    // cell that disappears (month change, group collapse, column hidden) would
    // leave a stale value in the sum -- so drop the selection when the visible
    // structure shifts.
    useEffect(() => {
        clearSelection();
    }, [som, columns, expandedGroupIds, groupsQ.data, clearSelection]);

    // The header must be tall enough for the angled labels plus one group-tier
    // row per nesting level; the totals row sticks directly beneath it (see
    // --thead-height in the CSS)
    const barRows = columns.reduce((max, col) => Math.max(max, col.bars.length), 0);
    const theadHeightRem = 8 + barRows * 1.2;

    // The rem estimate above sets the header's height, but its true rendered
    // height also carries cell padding + the bottom border (content-box), so
    // the totals row -- which sticks at that offset -- was overlapped and
    // squished by the header. Measure the real header box and pin the totals
    // sticky offset (--totals-offset) to it (React 19 ref-callback cleanup).
    const [ theadHeight, setTheadHeight ] = useState(null);
    const theadRef = useCallback((node) => {
        if ( node == null ) return;
        const update = () => setTheadHeight(node.offsetHeight);
        update();
        const observer = new ResizeObserver(update);
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

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
                            title={isLatestFinalization
                                ? `Re-open ${monthTitle} for editing`
                                : `Re-open ${monthTitle} (and every later finalized month) for editing`}
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
                            onClick={() => withColumnTransition(() => toggleHidden(f.id))}
                            title={`Show the ${f.name} column`}
                        >
                            <span style={{ color: fundColorVar(f.color, 'text') }}>{f.name}</span>
                            <FontAwesomeIcon icon="fa-solid fa-eye" size="xs" />
                        </button>
                    ))}
                    <button
                        type="button"
                        className={styles.hiddenStripShowAll}
                        onClick={() => withColumnTransition(() => setHiddenIds(new Set()))}
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
                : <div
                    className={styles.tableScroll}
                    style={{
                        '--thead-height': `${theadHeightRem}rem`,
                        ...(theadHeight != null ? { '--totals-offset': `${theadHeight}px` } : {})
                    }}
                >
                    <table
                        ref={tableRef}
                        className={styles.table}
                        onMouseOver={handleTableMouseOver}
                        onMouseLeave={() => setHoveredFundId(null)}
                        onPointerDown={onTablePointerDown}
                    >
                        <thead ref={theadRef}>
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
                                        // upright base rectangle (tiers/controls) and the
                                        // skewed label parallelogram; it clears the tier rows
                                        style={{ zIndex: 80 - colIndex, '--fund-base-height': `calc(1.7rem + ${barRows * 1.2}rem)` }}
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
                                            // One tier row per nesting level, ROOT tier on top
                                            // (row d shows bars[d]). Every column paints a fill
                                            // for its group at that level; the segment's FIRST
                                            // column also carries the group's label, sized to
                                            // span the whole segment (a subtree's visible
                                            // columns are always a contiguous run) and painting
                                            // over the next columns' fills via the ths'
                                            // descending z-index, like the angled labels
                                            <div className={styles.fundThTiers}>
                                                { Array.from({ length: barRows }, (_, d) => {
                                                    const bar = col.bars[d];
                                                    const isSegmentStart = bar != null
                                                        && columns[colIndex - 1]?.bars[d]?.id !== bar.id;
                                                    let span = 0;
                                                    while ( isSegmentStart && columns[colIndex + span]?.bars[d]?.id === bar.id ) span += 1;
                                                    // The label only toggles collapse when the
                                                    // segment starts on the group's OWN column:
                                                    // with that column hidden, collapsing would
                                                    // vanish the whole subtree with no way back
                                                    const canToggle = isSegmentStart && bar.id === col.fund.id;
                                                    const label = canToggle && col.isCollapsed
                                                        ? `${bar.name} +${col.memberIds.length - 1}`
                                                        : bar?.name;
                                                    // --tier-span drives the label's width in CSS
                                                    // (span × the column pitch), so the column
                                                    // geometry stays in one place
                                                    const labelStyle = {
                                                        '--tier-span': span,
                                                        color: fundColorVar(bar?.color, 'text')
                                                    };
                                                    return (
                                                        <div key={d} className={styles.fundThTier}>
                                                            { bar != null &&
                                                                <div
                                                                    className={styles.fundThTierFill}
                                                                    style={{
                                                                        backgroundColor: fundColorVar(bar.color, 'main'),
                                                                        ...(isSegmentStart
                                                                            ? { borderLeft: `3px solid ${fundColorVar(bar.color, 'dot')}` }
                                                                            : {})
                                                                    }}
                                                                />
                                                            }
                                                            { isSegmentStart && (canToggle
                                                                ? <button
                                                                    type="button"
                                                                    className={styles.fundThTierLabel}
                                                                    style={labelStyle}
                                                                    title={col.isCollapsed
                                                                        ? `Expand the children of ${bar.name}`
                                                                        : `Collapse the children of ${bar.name} into this column`}
                                                                    aria-label={col.isCollapsed
                                                                        ? `Expand the children of ${bar.name}`
                                                                        : `Collapse the children of ${bar.name} into this column`}
                                                                    onClick={() => withColumnTransition(() => toggleCollapsed(bar.id))}
                                                                >
                                                                    <span className={styles.tierCaret}>{col.isCollapsed ? '▸' : '▾'}</span>
                                                                    <span className={styles.tierName}>{label}</span>
                                                                </button>
                                                                : <span
                                                                    className={styles.fundThTierLabel}
                                                                    style={labelStyle}
                                                                    title={bar.name}
                                                                >
                                                                    <span className={styles.tierName}>{label}</span>
                                                                </span>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        }
                                        <div className={styles.fundThControls}>
                                            <GhostButton
                                                icon="fa-eye-slash"
                                                title={`Hide the ${col.fund.name} column`}
                                                onClick={() => withColumnTransition(() => toggleHidden(col.fund.id))}
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
                                selPrefix="tot"
                                selectedKeys={selectedKeys}
                            />
                            <BalanceRow
                                label="Balance forward"
                                title={`Each fund's balance entering ${monthTitle} (every transaction before the 1st)`}
                                map={enteringMap}
                                columns={columns}
                                hoveredFundId={hoveredFundId}
                                rowClassName={styles.forwardRow}
                                selPrefix="fwd"
                                selectedKeys={selectedKeys}
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
                                    fundsById={fundsById}
                                    selectedKeys={selectedKeys}
                                    hoveredFundId={hoveredFundId}
                                    isExpanded={expandedGroupIds.has(group.id)}
                                    onToggleExpand={() => toggleExpanded(group.id)}
                                    onShowNote={setNoteTarget}
                                    onDeleteGroup={setDeleteTarget}
                                    isMonthFinalized={monthFinalization != null}
                                    isEditor={isEditor}
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
                                    selPrefix="eom"
                                    selectedKeys={selectedKeys}
                                />
                                { cleanupGroups.map(group => (
                                    <GroupRows
                                        key={group.id}
                                        group={group}
                                        columns={columns}
                                        trackedIds={trackedIds}
                                        fundsById={fundsById}
                                        selectedKeys={selectedKeys}
                                        hoveredFundId={hoveredFundId}
                                        isExpanded={expandedGroupIds.has(group.id)}
                                        onToggleExpand={() => toggleExpanded(group.id)}
                                        onShowNote={setNoteTarget}
                                        onDeleteGroup={setDeleteTarget}
                                        isMonthFinalized={monthFinalization != null}
                                        isEditor={isEditor}
                                        rowClassName={styles.cleanupRow}
                                    />
                                ))}
                            </>}
                        </tbody>
                    </table>
                </div>
            }

            { hasSelection &&
                <div className={styles.selectionReadout} data-selection-readout>
                    <span className={styles.selectionSum}>{formatDollars(selectionSum)}</span>
                    <span className={styles.selectionMeta}>
                        { selectionCount === 0
                            ? 'no values selected'
                            : `${selectionCount} ${selectionCount === 1 ? 'cell' : 'cells'}` }
                        { selectionCount > 1 && ` · avg ${formatDollars(selectionSum / selectionCount)}` }
                    </span>
                    <button
                        type="button"
                        className={styles.selectionClear}
                        onClick={clearSelection}
                        title="Clear selection (Esc)"
                        aria-label="Clear selection"
                    >
                        <FontAwesomeIcon icon="fa-solid fa-xmark" />
                    </button>
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

            <DeleteTransactionGroupModal
                isOpen={deleteTarget != null}
                setIsOpen={(open) => { if ( !open ) setDeleteTarget(null); }}
                group={deleteTarget}
                closePopoutCallback={() => setDeleteTarget(null)}
            />
        </div>
    );
}
