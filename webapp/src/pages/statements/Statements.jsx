import { useCallback, useMemo, useState } from 'react';

import { useGetStatementsQuery, usePatchStatementMutation } from '../../hooks/Queries.jsx';
import { useAuthRoles } from '../../contexts/AuthContext.jsx';
import SearchableTable from '../../components/SearchableTable.jsx';
import { IconButton, TightIconButton } from '../../components/Buttons.jsx';
import { LabeledSelector, LabeledDateRangeInput } from '../../components/Inputs.jsx';
import { StatementStateBadge } from '../../components/Badges.jsx';
import { formatDollars, statementStateOf } from '../../components/domain.js';
import {
    ImportStatementsCSVModal,
    ReconcileStatementsModal,
    LinkStatementModal,
    ViewTransactionGroupModal,
    EditStatementModal,
    DeleteStatementModal
} from '../../components/SpecialModals.jsx';
import styles from './Statements.module.css';

const STATE_FILTER_KEYS = [ 'pending', 'ignored', 'reconciled', 'all' ];
const STATE_FILTER_NAMES = [ 'Pending', 'Ignored', 'Reconciled', 'All states' ];

/**
 * The per-row action buttons, by state:
 *  - pending:    categorize (new group), link (existing group), ignore
 *  - ignored:    un-ignore (back to pending)
 *  - reconciled: view the linked group (which owns the unlink escape hatch)
 * plus edit (note) and delete (with the are-you-sure modal) everywhere.
 */
function RowActions({ statement, isEditor, togglingId, onToggleIgnored, onAction }) {
    const state = statementStateOf(statement);
    const stop = (fn) => (e) => { e.stopPropagation(); fn(); };

    return (
        <div className={styles.rowActions}>
            { state === 'pending' && <>
                <TightIconButton
                    icon="fa-square-plus"
                    ariaLabel="Categorize: create a transaction group from this item"
                    title="Categorize: create a transaction group from this item"
                    disabled={!isEditor}
                    onClick={stop(() => onAction('reconcile', statement))}
                />
                <TightIconButton
                    icon="fa-link"
                    ariaLabel="Link to an existing transaction group"
                    title="Link to an existing transaction group (transfers, pre-entered transactions)"
                    disabled={!isEditor}
                    onClick={stop(() => onAction('link', statement))}
                />
                <TightIconButton
                    icon="fa-eye-slash"
                    ariaLabel="Ignore this item"
                    title="Ignore: hide from the pending list without deleting"
                    disabled={!isEditor}
                    isPending={togglingId === statement.id}
                    onClick={stop(() => onToggleIgnored(statement))}
                />
            </>}
            { state === 'ignored' &&
                <TightIconButton
                    icon="fa-eye"
                    ariaLabel="Un-ignore this item"
                    title="Un-ignore: return this item to pending"
                    disabled={!isEditor}
                    isPending={togglingId === statement.id}
                    onClick={stop(() => onToggleIgnored(statement))}
                />
            }
            { state === 'reconciled' &&
                <TightIconButton
                    icon="fa-arrow-up-right-from-square"
                    ariaLabel="View the linked transaction group"
                    title="View the linked transaction group (unlink from there)"
                    onClick={stop(() => onAction('viewGroup', statement))}
                />
            }
            <TightIconButton
                icon="fa-pen-to-square"
                ariaLabel="Edit this item's note"
                title="Edit note (and raw ignored flag)"
                disabled={!isEditor}
                onClick={stop(() => onAction('edit', statement))}
            />
            <TightIconButton
                icon="fa-trash"
                ariaLabel="Delete this item"
                title="Delete (for undoing bad imports — prefer ignore)"
                disabled={!isEditor}
                onClick={stop(() => onAction('delete', statement))}
            />
        </div>
    );
}

export default function Page() {
    const roles = useAuthRoles();
    const isEditor = !!roles.editor;

    // The page exists to burn down the pending queue, so pending is the
    // default view; the state/date filters are server-side, search is client-side
    const [ stateFilter, setStateFilter ] = useState('pending');
    const [ dateRange, setDateRange ] = useState({ since: null, until: null });
    const [ searchTerm, setSearchTerm ] = useState('');
    const [ sortKey, setSortKey ] = useState('date');
    const [ direction, setDirection ] = useState('desc');

    const [ isImportOpen, setIsImportOpen ] = useState(false);
    // One open modal at a time: { kind: 'reconcile'|'link'|'viewGroup'|'edit'|'delete', statement }
    const [ actionTarget, setActionTarget ] = useState(null);
    const [ togglingId, setTogglingId ] = useState(null);
    const [ toggleError, setToggleError ] = useState(null);

    const statementsQ = useGetStatementsQuery({
        state: stateFilter === 'all' ? undefined : stateFilter,
        since: dateRange.since ?? undefined,
        until: dateRange.until ?? undefined,
    });

    const handleSort = useCallback((key) => {
        if ( sortKey === key ) {
            setDirection(d => d === 'asc' ? 'desc' : 'asc');
        } else {
            setSortKey(key);
            setDirection('asc');
        }
    }, [sortKey]);

    const {
        mutate: patchMutate
    } = usePatchStatementMutation();

    const handleToggleIgnored = useCallback((statement) => {
        setToggleError(null);
        setTogglingId(statement.id);
        patchMutate(
            { formData: { id: statement.id, ignored: !statement.ignored } },
            {
                onError: (err) => setToggleError({
                    message: err.message,
                    details: err.details?.message
                }),
                onSettled: () => setTogglingId(null)
            }
        );
    }, [patchMutate]);

    const handleAction = useCallback((kind, statement) => {
        setActionTarget({ kind, statement });
    }, []);

    // Row click opens the state's "natural next step" (the buttons cover the
    // rest): categorize a pending item, view a reconciled one's group, edit
    // an ignored one
    const handleRowClick = useCallback((statement) => {
        switch ( statementStateOf(statement) ) {
            case 'pending':
                if ( isEditor ) handleAction('reconcile', statement);
                break;
            case 'reconciled':
                handleAction('viewGroup', statement);
                break;
            default:
                handleAction('edit', statement);
                break;
        }
    }, [isEditor, handleAction]);

    const processedData = useMemo(() => {
        let items = statementsQ.data ?? [];

        if ( searchTerm.trim() ) {
            const term = searchTerm.toLowerCase();
            items = items.filter(s =>
                s.source?.toLowerCase().includes(term)
                || s.key?.toLowerCase().includes(term)
                || s.note?.toLowerCase().includes(term)
            );
        }

        return items.toSorted((a, b) => {
            let aVal = a[sortKey] ?? '';
            let bVal = b[sortKey] ?? '';
            if ( typeof aVal === 'string' ) aVal = aVal.toLowerCase();
            if ( typeof bVal === 'string' ) bVal = bVal.toLowerCase();

            let comparison = 0;
            if ( aVal < bVal ) comparison = -1;
            if ( aVal > bVal ) comparison = 1;
            // Stable tiebreak so same-day items don't jump around
            if ( comparison === 0 ) comparison = a.id - b.id;

            return direction === 'asc' ? comparison : -comparison;
        });
    }, [statementsQ.data, searchTerm, sortKey, direction]);

    const columns = [
        {
            header: 'State',
            sortKey: 'state',
            sortable: true,
            render: (s) => <StatementStateBadge statement={s} />
        },
        {
            header: 'Date',
            sortKey: 'date',
            sortable: true,
            render: (s) => <span className="tabular-nums">{s.date}</span>
        },
        {
            header: 'Source',
            sortKey: 'source',
            sortable: true,
            dataKey: 'source'
        },
        {
            header: 'Amount',
            sortKey: 'amount',
            sortable: true,
            render: (s) => (
                <span className={`tabular-nums ${s.amount < 0 ? styles.negativeAmount : ''}`}>
                    {formatDollars(s.amount)}
                </span>
            )
        },
        {
            header: 'Note',
            sortKey: 'note',
            sortable: true,
            render: (s) => (
                <span className={styles.noteCell} title={s.note ?? s.key}>
                    { s.note ?? <span className={styles.keyFallback}>{s.key}</span> }
                </span>
            )
        },
        {
            header: '',
            key: 'actions',
            sortable: false,
            render: (s) => (
                <RowActions
                    statement={s}
                    isEditor={isEditor}
                    togglingId={togglingId}
                    onToggleIgnored={handleToggleIgnored}
                    onAction={handleAction}
                />
            )
        }
    ];

    const closeAction = useCallback((open) => {
        if ( !open ) setActionTarget(null);
    }, []);
    const targetKind = actionTarget?.kind ?? null;
    const targetStatement = actionTarget?.statement ?? null;

    return (
        <div className={styles.page}>
            <div className={styles.topBar}>
                <h1>Bank Statements</h1>
                <IconButton
                    text="Upload statement"
                    icon="fa-file-arrow-up"
                    ariaLabel="Upload a bank statement CSV"
                    disabled={!isEditor}
                    onClick={() => setIsImportOpen(true)}
                />
            </div>

            <div className={styles.filterBar}>
                <LabeledSelector
                    label="State"
                    value={stateFilter}
                    optionKeys={STATE_FILTER_KEYS}
                    optionDisplayNames={STATE_FILTER_NAMES}
                    onChange={(value) => setStateFilter(value)}
                    isFrozen={false}
                    allowNull={false}
                />
                <LabeledDateRangeInput
                    label="Date range"
                    value={dateRange}
                    onChange={setDateRange}
                    isFrozen={false}
                />
                <div className={styles.filterBarCount}>
                    { statementsQ.data != null &&
                        `${processedData.length} item${processedData.length === 1 ? '' : 's'}`
                    }
                </div>
            </div>

            { toggleError &&
                <div className={styles.inlineError} role="alert">
                    {toggleError.message}{toggleError.details ? `: ${toggleError.details}` : ''}
                </div>
            }

            { statementsQ.isError
                ? <div className={styles.centerState}>
                    <h2 className={styles.errorTitle}>Error</h2>
                    <p>
                        { statementsQ.error.details?.message
                            ? `${statementsQ.error.message}: ${statementsQ.error.details.message}`
                            : statementsQ.error.message
                        }
                    </p>
                </div>
                : <div className={styles.tableWrapper}>
                    <SearchableTable
                        data={processedData}
                        columns={columns}
                        searchValue={searchTerm}
                        onSearchChange={setSearchTerm}
                        searchPlaceholder="Search source, key, or note..."
                        sortKey={sortKey}
                        sortDirection={direction}
                        onSort={handleSort}
                        isLoading={statementsQ.isPending}
                        onRowClick={handleRowClick}
                        rowKey="id"
                    />
                    { !statementsQ.isPending && processedData.length === 0 &&
                        <div className={styles.emptyState}>
                            { stateFilter === 'pending'
                                ? 'No pending items — the queue is clear. Upload a statement to import more.'
                                : 'No bank statement items match the current filters.'
                            }
                        </div>
                    }
                </div>
            }

            <ImportStatementsCSVModal
                isOpen={isImportOpen}
                setIsOpen={setIsImportOpen}
            />
            <ReconcileStatementsModal
                isOpen={targetKind === 'reconcile'}
                setIsOpen={closeAction}
                statements={targetKind === 'reconcile' && targetStatement ? [ targetStatement ] : []}
            />
            <LinkStatementModal
                isOpen={targetKind === 'link'}
                setIsOpen={closeAction}
                statement={targetStatement}
            />
            <ViewTransactionGroupModal
                isOpen={targetKind === 'viewGroup'}
                setIsOpen={closeAction}
                groupId={targetKind === 'viewGroup' ? targetStatement?.group_id : null}
            />
            <EditStatementModal
                isOpen={targetKind === 'edit'}
                setIsOpen={closeAction}
                statement={targetStatement}
            />
            <DeleteStatementModal
                isOpen={targetKind === 'delete'}
                setIsOpen={closeAction}
                statement={targetStatement}
            />
        </div>
    );
}
