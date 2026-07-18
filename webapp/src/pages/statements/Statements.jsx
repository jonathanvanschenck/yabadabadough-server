import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import {
    useGetStatementsPageQuery,
    usePatchStatementMutation,
    usePostTransactionGroupFromStatementsMutation
} from '../../hooks/Queries.jsx';
import { useAuthRoles } from '../../contexts/AuthContext.jsx';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import Spinner from '../../components/Spinner.jsx';
import Pagination from '../../components/Pagination.jsx';
import { IconButton, TightIconButton, SpinnerButton } from '../../components/Buttons.jsx';
import {
    LabeledSelector,
    LabeledDateRangeInput,
    LabeledTextInput
} from '../../components/Inputs.jsx';
import { FundSearchableSelector } from '../../components/SpecialInputs.jsx';
import { StatementStateBadge } from '../../components/Badges.jsx';
import { formatDollars, statementStateOf } from '../../components/domain.js';
import {
    ImportStatementsCSVModal,
    ReconcileStatementsModal,
    LinkStatementModal,
    EditStatementModal,
    DeleteStatementModal
} from '../../components/SpecialModals.jsx';
import styles from './Statements.module.css';

const STATE_FILTER_KEYS = [ 'pending', 'ignored', 'reconciled', 'all' ];
const STATE_FILTER_NAMES = [ 'Pending', 'Ignored', 'Reconciled', 'All states' ];

// Sort is a single control on the cards layout (no column headers to click):
// each option encodes an "<order_by>:<direction>" pair, split at the boundary.
const SORT_KEYS = [
    'date:desc', 'date:asc',
    'amount:desc', 'amount:asc',
    'source:asc', 'state:asc'
];
const SORT_NAMES = [
    'Date (newest first)', 'Date (oldest first)',
    'Amount (high → low)', 'Amount (low → high)',
    'Source (A → Z)', 'State'
];

/**
 * The inline "easy path" reconcile shown on a PENDING card for editors: pick a
 * source and target fund, confirm, done. Amount and date come straight from the
 * statement item (abs amount; the server defaults the group date to the item
 * date). One description field fills BOTH the group and its lone transaction
 * (the Stage 4 defaulting rule), so the common single-transaction reconcile
 * never needs the modal. Split/transfer/custom-date reconciles stay in
 * ReconcileStatementsModal, reachable from the card's secondary actions.
 */
function InlinePendingReconcile({ statement }) {
    const [ sourceId, setSourceId ] = useState(null);
    const [ targetId, setTargetId ] = useState(null);
    // Seed the description from the item's note (its key as a fallback), mirroring
    // the modal's group-description default.
    const [ description, setDescription ] = useState(statement.note ?? statement.key ?? '');
    const [ submitError, setSubmitError ] = useState(null);

    const amount = Math.abs(statement.amount);

    const descOk = !!description?.trim();
    const fundsOk = sourceId != null && targetId != null && sourceId !== targetId;
    const canSubmit = descOk && fundsOk;

    const {
        mutate: postMutate,
        isPending: postIsPending
    } = usePostTransactionGroupFromStatementsMutation();

    const handleSubmit = useCallback(() => {
        if ( !canSubmit ) return;
        const desc = description.trim();
        postMutate(
            {
                formData: {
                    statement_ids: [ statement.id ],
                    description: desc,
                    // Single line inherits the group description (no null line
                    // description sent); amount is the item's magnitude.
                    transactions: [ {
                        source_fund_id: sourceId,
                        target_fund_id: targetId,
                        amount,
                        description: desc,
                        note: null
                    } ]
                }
            },
            {
                // On success the item leaves the pending list (becomes reconciled),
                // so this card simply re-renders in its new state.
                onError: (err) => setSubmitError({
                    message: err.message,
                    details: err.details?.message
                })
            }
        );
    }, [ canSubmit, description, statement.id, sourceId, targetId, amount, postMutate ]);

    return (
        <div className={styles.inlineReconcile}>
            <div className={styles.inlineFundRow}>
                <FundSearchableSelector
                    label="From (source)"
                    value={sourceId}
                    onChange={(v) => { setSourceId(v); setSubmitError(null); }}
                    isFrozen={false}
                    isRequired={true}
                    allowNull={false}
                    validityMessage={
                        fundsOk || sourceId == null ? undefined
                        : (sourceId === targetId ? 'Source and target must differ.' : undefined)
                    }
                />
                <FundSearchableSelector
                    label="To (target)"
                    value={targetId}
                    onChange={(v) => { setTargetId(v); setSubmitError(null); }}
                    isFrozen={false}
                    isRequired={true}
                    allowNull={false}
                />
            </div>
            <LabeledTextInput
                label="Description"
                value={description}
                isFrozen={false}
                isRequired={true}
                emptyStringPlaceholder="Enter description"
                onChange={(v) => { setDescription(v); setSubmitError(null); }}
            />
            <div className={styles.inlineReconcileFooter}>
                <span className={styles.inlineReconcileAmount}>
                    Reconciles <strong className="tabular-nums">{formatDollars(amount)}</strong>
                </span>
                <SpinnerButton
                    isPending={postIsPending}
                    disabled={!canSubmit || submitError != null}
                    text="Confirm"
                    ariaLabel="Confirm reconcile"
                    onClick={handleSubmit}
                />
            </div>
            { submitError &&
                <div className={styles.inlineError} role="alert">
                    {submitError.message}{submitError.details ? `: ${submitError.details}` : ''}
                </div>
            }
        </div>
    );
}

/**
 * Secondary (advanced) actions, by state:
 *  - pending:    advanced reconcile (split/transfer/custom date), link, ignore
 *  - ignored:    un-ignore (back to pending)
 *  - reconciled: view the linked group (which owns the unlink escape hatch)
 * plus edit (note) and delete (with the are-you-sure modal) everywhere.
 */
function CardActions({ statement, isEditor, togglingId, onToggleIgnored, onAction }) {
    const state = statementStateOf(statement);

    return (
        <div className={styles.cardActions}>
            { state === 'pending' && <>
                <TightIconButton
                    icon="fa-square-plus"
                    tone="success"
                    ariaLabel="Advanced reconcile"
                    title="Advanced reconcile: split into several lines, a transfer, or a custom date"
                    disabled={!isEditor}
                    onClick={() => onAction('reconcile', statement)}
                />
                <TightIconButton
                    icon="fa-link"
                    tone="info"
                    ariaLabel="Link to an existing transaction group"
                    title="Link to an existing transaction group (transfers, pre-entered transactions)"
                    disabled={!isEditor}
                    onClick={() => onAction('link', statement)}
                />
                <TightIconButton
                    icon="fa-eye-slash"
                    tone="warn"
                    ariaLabel="Ignore this item"
                    title="Ignore: hide from the pending list without deleting"
                    disabled={!isEditor}
                    isPending={togglingId === statement.id}
                    onClick={() => onToggleIgnored(statement)}
                />
            </>}
            { state === 'ignored' &&
                <TightIconButton
                    icon="fa-eye"
                    tone="success"
                    ariaLabel="Un-ignore this item"
                    title="Un-ignore: return this item to pending"
                    disabled={!isEditor}
                    isPending={togglingId === statement.id}
                    onClick={() => onToggleIgnored(statement)}
                />
            }
            { state === 'reconciled' &&
                <TightIconButton
                    icon="fa-arrow-up-right-from-square"
                    tone="info"
                    ariaLabel="View the linked transaction group"
                    title="View the linked transaction group (unlink from there)"
                    onClick={() => onAction('viewGroup', statement)}
                />
            }
            <TightIconButton
                icon="fa-pen-to-square"
                ariaLabel="Edit this item's note"
                title="Edit note (and raw ignored flag)"
                disabled={!isEditor}
                onClick={() => onAction('edit', statement)}
            />
            <TightIconButton
                icon="fa-trash"
                tone="danger"
                ariaLabel="Delete this item"
                title="Delete (for undoing bad imports — prefer ignore)"
                disabled={!isEditor}
                onClick={() => onAction('delete', statement)}
            />
        </div>
    );
}

function StatementCard({ statement, isEditor, togglingId, onToggleIgnored, onAction }) {
    const state = statementStateOf(statement);

    return (
        <div className={styles.card} data-state={state}>
            <div className={styles.cardHeader}>
                <div className={styles.cardMeta}>
                    <StatementStateBadge statement={statement} />
                    <span className={`tabular-nums ${styles.cardDate}`}>{statement.date}</span>
                    <span className={styles.cardSource}>{statement.source}</span>
                </div>
                <span className={`tabular-nums ${styles.cardAmount} ${statement.amount < 0 ? styles.negativeAmount : ''}`}>
                    {formatDollars(statement.amount)}
                </span>
            </div>

            { (statement.note || statement.key) &&
                <div className={styles.cardNote} title={statement.note ?? statement.key}>
                    { statement.note ?? <span className={styles.keyFallback}>{statement.key}</span> }
                </div>
            }

            { state === 'pending' && isEditor &&
                <InlinePendingReconcile statement={statement} />
            }

            <CardActions
                statement={statement}
                isEditor={isEditor}
                togglingId={togglingId}
                onToggleIgnored={onToggleIgnored}
                onAction={onAction}
            />
        </div>
    );
}

export default function Page() {
    const navigate = useNavigate();
    const roles = useAuthRoles();
    const isEditor = !!roles.editor;

    // The page exists to burn down the pending queue, so pending is the
    // default view. Filtering, text search, sorting and pagination ALL run
    // server-side (see useGetStatementsPageQuery); the client just holds the
    // control state and reflects the query.
    const [ stateFilter, setStateFilter ] = useState('pending');
    const [ dateRange, setDateRange ] = useState({ since: null, until: null });
    const [ searchTerm, setSearchTerm ] = useState('');
    // Debounced so typing doesn't fire a request per keystroke
    const debouncedSearch = useDebouncedValue(searchTerm.trim(), 300);
    // Combined "<order_by>:<direction>" control (no column headers on cards)
    const [ sort, setSort ] = useState('date:desc');
    const [ sortKey, direction ] = useMemo(() => sort.split(':'), [sort]);

    const [ page, setPage ] = useState(1);
    const [ pageSize, setPageSize ] = useState(25);

    const [ isImportOpen, setIsImportOpen ] = useState(false);
    // One open modal at a time: { kind: 'reconcile'|'link'|'edit'|'delete', statement }
    const [ actionTarget, setActionTarget ] = useState(null);
    const [ togglingId, setTogglingId ] = useState(null);
    const [ toggleError, setToggleError ] = useState(null);

    const statementsQ = useGetStatementsPageQuery({
        state: stateFilter === 'all' ? undefined : stateFilter,
        since: dateRange.since ?? undefined,
        until: dateRange.until ?? undefined,
        search: debouncedSearch || undefined,
        orderBy: sortKey,
        orderDirection: direction,
        limit: pageSize,
        offset: (page - 1) * pageSize,
    });

    const items = statementsQ.data?.data ?? [];
    const totalItems = statementsQ.data?.total ?? 0;
    const pageCount = Math.max(1, Math.ceil(totalItems / pageSize));

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

    // 'viewGroup' links through to the transaction-group page (which owns the
    // unlink escape hatch); every other action opens its modal in place.
    const handleAction = useCallback((kind, statement) => {
        if ( kind === 'viewGroup' ) {
            if ( statement.group_id != null ) navigate(`/transaction-group/${statement.group_id}`);
            return;
        }
        setActionTarget({ kind, statement });
    }, [navigate]);

    // Any change to what's shown (or how it's ordered) sends you back to page 1
    // so you're never stranded past the end of a shorter result set.
    useEffect(() => {
        setPage(1);
    }, [stateFilter, dateRange, debouncedSearch, sort, pageSize]);

    // Keep the page in range if the row count shrinks out from under it.
    useEffect(() => {
        if ( page > pageCount ) setPage(pageCount);
    }, [page, pageCount]);

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
                <LabeledSelector
                    label="Sort by"
                    value={sort}
                    optionKeys={SORT_KEYS}
                    optionDisplayNames={SORT_NAMES}
                    onChange={(value) => setSort(value)}
                    isFrozen={false}
                    allowNull={false}
                />
                <LabeledDateRangeInput
                    label="Date range"
                    value={dateRange}
                    onChange={setDateRange}
                    isFrozen={false}
                />
                <LabeledTextInput
                    label="Search"
                    value={searchTerm}
                    isFrozen={false}
                    allowNull={false}
                    emptyStringPlaceholder="Search source, key, or note..."
                    onChange={(value) => setSearchTerm(value ?? '')}
                />
                <div className={styles.filterBarCount}>
                    { statementsQ.data != null &&
                        `${totalItems} item${totalItems === 1 ? '' : 's'}`
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
                : statementsQ.isPending
                    ? <div className={styles.centerState}>
                        <Spinner size="1.5rem" />
                    </div>
                    : <div className={styles.listWrapper}>
                        { totalItems === 0
                            ? <div className={styles.emptyState}>
                                { stateFilter === 'pending'
                                    ? 'No pending items — the queue is clear. Upload a statement to import more.'
                                    : 'No bank statement items match the current filters.'
                                }
                            </div>
                            : <>
                                <div className={`${styles.cardList} ${statementsQ.isPlaceholderData ? styles.isStale : ''}`}>
                                    { items.map(s => (
                                        <StatementCard
                                            key={s.id}
                                            statement={s}
                                            isEditor={isEditor}
                                            togglingId={togglingId}
                                            onToggleIgnored={handleToggleIgnored}
                                            onAction={handleAction}
                                        />
                                    ))}
                                </div>
                                <Pagination
                                    page={page}
                                    pageSize={pageSize}
                                    totalItems={totalItems}
                                    onPageChange={setPage}
                                    onPageSizeChange={setPageSize}
                                    itemLabel="item"
                                />
                            </>
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
