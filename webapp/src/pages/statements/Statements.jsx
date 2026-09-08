import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import dayjs from 'dayjs';

import {
    useGetStatementsPageQuery,
    useGetTransactionGroupsQuery,
    usePatchStatementMutation,
    usePostStatementLinkMutation,
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
import { Money } from '../../components/Money.jsx';
import {
    statementStateOf,
    amountsMatch,
    transactionGroupTotal
} from '../../components/domain.js';
import { FloatingKeyboardHelp } from '../../components/KeyboardHelp.jsx';
import {
    ImportStatementsCSVModal,
    ImportStatementsOFXModal,
    ReconcileStatementsModal,
    LinkStatementModal,
    UnlinkStatementModal,
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

// Inline link suggestions are deliberately STRICT -- they only surface when a
// group is very likely THE match, unlike the fuzzy ranking in
// LinkStatementModal (which stays reachable from the card's link action):
//  - the group's date is within ±SUGGEST_WINDOW_DAYS of the item's date
//  - the group's TOTAL equals the item's magnitude (per-line matches are the
//    modal's job -- a coincidental line match is not "very likely")
//  - the group does not already reconcile an item from the SAME source (one
//    group never explains two lines of one bank account; a transfer's second
//    side -- already reconciling the OTHER account's line -- still suggests)
// Ranked closest-date first, then fewest already-linked statements, and capped
// so a generic amount ($20.00 on payday) can't flood a card.
const SUGGEST_WINDOW_DAYS = 2;
const SUGGEST_MAX = 2;

/**
 * Suggestions for every pending item on the page, as a Map of item id ->
 * [{ group, total, dateDistance }], built from ONE groups query spanning the
 * page (allocation/eom_cleanup groups are excluded server-side -- linking
 * them is refused anyway).
 */
function useLinkSuggestions(pendingItems, enabled) {
    const span = useMemo(() => {
        if ( pendingItems.length === 0 ) return null;
        const dates = pendingItems.map(s => s.date).toSorted();
        return {
            since: dayjs(dates[0]).subtract(SUGGEST_WINDOW_DAYS, 'day').format('YYYY-MM-DD'),
            until: dayjs(dates[dates.length - 1]).add(SUGGEST_WINDOW_DAYS, 'day').format('YYYY-MM-DD'),
        };
    }, [pendingItems]);

    const groupsQ = useGetTransactionGroupsQuery(
        {
            since: span?.since,
            until: span?.until,
            allocation: false,
            eomCleanup: false,
        },
        { enabled: enabled && span != null }
    );

    return useMemo(() => {
        const map = new Map();
        const groups = groupsQ.data ?? [];
        if ( groups.length === 0 ) return map;
        for ( const item of pendingItems ) {
            const absAmount = Math.abs(item.amount);
            const matches = groups
                .filter(g => amountsMatch(transactionGroupTotal(g), absAmount))
                .map(g => ({
                    group: g,
                    total: transactionGroupTotal(g),
                    dateDistance: Math.abs(dayjs(g.date).diff(dayjs(item.date), 'day')),
                }))
                .filter(c => c.dateDistance <= SUGGEST_WINDOW_DAYS)
                .filter(c => !c.group.statements.some(s => s.source === item.source))
                .toSorted((a, b) =>
                    a.dateDistance !== b.dateDistance ? a.dateDistance - b.dateDistance
                    : a.group.statements.length !== b.group.statements.length
                        ? a.group.statements.length - b.group.statements.length
                    : b.group.id - a.group.id
                );
            if ( matches.length > 0 ) map.set(item.id, matches.slice(0, SUGGEST_MAX));
        }
        return map;
    }, [groupsQ.data, pendingItems]);
}

// Inline-reconcile PREFILL from reconciliation history: most bank lines are
// recurring ("COSTCO WHSE #0912 ..." week after week), so the funds -- and the
// human-friendly description -- the user chose LAST time are almost always
// right this time. Matching is on the leading tokens of the normalized bank
// note (uppercased, digits/punctuation stripped -- store numbers, dates and
// card suffixes vary per line), requiring at least PREFILL_MIN_TOKENS in
// common (or a full match, for one-word vendors) plus the same amount sign
// (a refund should not prefill like a charge). Only single-routing history
// groups qualify: a group whose lines fan out to several fund pairs has no
// single answer to prefill.
const PREFILL_HISTORY_DAYS = 365;
const PREFILL_MIN_TOKENS = 2;

function normalizeNoteTokens(text) {
    return (text ?? '')
        .toUpperCase()
        .replace(/[^A-Z]+/g, ' ')
        .split(' ')
        .filter(Boolean);
}

function commonPrefixLength(a, b) {
    let n = 0;
    while ( n < a.length && n < b.length && a[n] === b[n] ) n++;
    return n;
}

/**
 * Prefills for every pending item on the page, as a Map of item id ->
 * { sourceId, targetId, description, date, score }, built from one query over
 * the last year's reconciling groups (their hydrated `statements` carry the
 * bank notes to match against). Best match = longest token-prefix score,
 * ties broken by most recent statement date.
 */
function useReconcilePrefills(pendingItems, enabled) {
    // The since-bound is a coarse cache-friendly cutoff, not a semantic date,
    // so a day-granular "now" is fine (and stable across renders).
    const since = useMemo(
        () => dayjs().subtract(PREFILL_HISTORY_DAYS, 'day').format('YYYY-MM-DD'),
        []
    );
    const groupsQ = useGetTransactionGroupsQuery(
        {
            since,
            allocation: false,
            eomCleanup: false,
            hasStatements: true,
        },
        { enabled: enabled && pendingItems.length > 0 }
    );

    return useMemo(() => {
        const map = new Map();
        const history = [];
        for ( const g of groupsQ.data ?? [] ) {
            const pairs = new Set(g.transactions.map(t => `${t.source_fund_id}:${t.target_fund_id}`));
            if ( pairs.size !== 1 ) continue;
            const { source_fund_id, target_fund_id } = g.transactions[0];
            for ( const s of g.statements ) {
                const tokens = normalizeNoteTokens(s.note ?? s.key);
                if ( tokens.length === 0 ) continue;
                history.push({
                    tokens,
                    sign: Math.sign(s.amount),
                    date: s.date,
                    sourceId: source_fund_id,
                    targetId: target_fund_id,
                    description: g.description,
                });
            }
        }
        if ( history.length === 0 ) return map;
        for ( const item of pendingItems ) {
            const tokens = normalizeNoteTokens(item.note ?? item.key);
            if ( tokens.length === 0 ) continue;
            const sign = Math.sign(item.amount);
            let best = null;
            for ( const h of history ) {
                if ( h.sign !== sign ) continue;
                const score = commonPrefixLength(tokens, h.tokens);
                const fullMatch = score === tokens.length && score === h.tokens.length;
                if ( score < PREFILL_MIN_TOKENS && !fullMatch ) continue;
                if ( !best || score > best.score
                    || (score === best.score && h.date > best.date) ) {
                    best = { ...h, score };
                }
            }
            if ( best ) map.set(item.id, best);
        }
        return map;
    }, [groupsQ.data, pendingItems]);
}

// --- Keyboard queue triage ------------------------------------------------
// The page is a burn-down queue, so it gets vi-style keys: J/K (or arrows)
// walk the cards, and single letters act on the selected card. Handlers
// always bail when focus sits in a form control (typing must never trigger
// actions) or while any modal is open. Enter and L need the selected card's
// own state, so those two listeners live in the card's children, gated by
// the same hotkeysActive flag.

function isTypingTarget(el) {
    if ( el == null || !(el instanceof HTMLElement) ) return false;
    return el.tagName === 'INPUT'
        || el.tagName === 'TEXTAREA'
        || el.tagName === 'SELECT'
        || el.isContentEditable;
}

function plainKey(e) {
    if ( e.ctrlKey || e.metaKey || e.altKey ) return null;
    return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

const SHORTCUT_GROUPS = [
    {
        title: 'Navigation',
        shortcuts: [
            { keys: [ 'J', '↓' ], description: 'Select the next card' },
            { keys: [ 'K', '↑' ], description: 'Select the previous card' },
            { keys: [ 'Esc' ], description: 'Clear the selection' },
            { keys: [ '/' ], description: 'Jump to the search box' },
            { keys: [ '?' ], description: 'Show this help' },
        ],
    },
    {
        title: 'Selected pending card',
        shortcuts: [
            { keys: [ 'Enter' ], description: 'Confirm the inline reconcile (once both funds and a description are set; also works from the description field)' },
            { keys: [ 'S', 'T', 'D' ], description: 'Jump into the Source / Target / Description fields — S and T open the fund search (type, then Enter to pick), D selects the description text; Esc returns to the card' },
            { keys: [ 'L' ], description: 'Link the first "likely match" suggestion' },
            { keys: [ [ 'Shift', 'L' ] ], description: 'Open the full link picker — search every group, including ones the suggester did not surface' },
            { keys: [ 'R' ], description: 'Advanced reconcile (split / transfer / custom date)' },
            { keys: [ 'I' ], description: 'Ignore the item (I again on an ignored card un-ignores)' },
        ],
    },
    {
        title: 'Selected reconciled card',
        shortcuts: [
            { keys: [ 'V' ], description: 'View the linked transaction group' },
            { keys: [ 'U' ], description: 'Unlink from the transaction group' },
        ],
    },
    {
        title: 'Any selected card',
        shortcuts: [
            { keys: [ 'E' ], description: "Edit the item's note" },
            { keys: [ 'Del' ], description: 'Delete the item (opens the confirmation)' },
        ],
    },
];

/**
 * One suggested group on a pending card: the group's facts plus a one-click
 * Link button (the same POST /statement/:id/link as the modal -- no
 * transactions are created, the group just absorbs the bank line). Success
 * needs no handler: the broadcast invalidation re-renders the card as
 * reconciled.
 */
function SuggestedLink({ statement, suggestion, hotkeyLink = false }) {
    const navigate = useNavigate();
    const [ submitError, setSubmitError ] = useState(null);
    const { group, total, dateDistance } = suggestion;

    const {
        mutate: linkMutate,
        isPending: linkIsPending
    } = usePostStatementLinkMutation();

    const handleLink = useCallback(() => {
        linkMutate(
            { formData: { id: statement.id, group_id: group.id } },
            {
                onError: (err) => setSubmitError({
                    message: err.message,
                    details: err.details?.message
                })
            }
        );
    }, [linkMutate, statement.id, group.id]);

    // The card-selection "L" hotkey -- only the FIRST suggestion of the
    // selected card gets hotkeyLink, so L is never ambiguous. Shift+L is a
    // DIFFERENT action (open the full picker), handled by the page, so let it
    // pass rather than swallowing it here.
    useEffect(() => {
        if ( !hotkeyLink ) return;
        const onKeyDown = (e) => {
            if ( plainKey(e) !== 'l' || e.shiftKey || isTypingTarget(e.target) ) return;
            if ( linkIsPending || submitError != null ) return;
            e.preventDefault();
            handleLink();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [hotkeyLink, linkIsPending, submitError, handleLink]);

    return (
        <div className={styles.suggestionRow}>
            <span className={`tabular-nums ${styles.suggestionDate}`}>
                {group.date}
                { dateDistance > 0 &&
                    <span className={styles.suggestionDateDistance}> (±{dateDistance}d)</span>
                }
            </span>
            <span className={styles.suggestionDescription} title={group.description}>
                {group.description}
            </span>
            <Money value={total} />
            <span className={styles.suggestionMeta}>
                {group.transactions.length} txn{group.transactions.length === 1 ? '' : 's'}
                { group.statements.length > 0 && ` · reconciles ${group.statements.length}` }
            </span>
            <span className={styles.suggestionActions}>
                <TightIconButton
                    icon="fa-arrow-up-right-from-square"
                    ariaLabel="View this transaction group"
                    title="View this transaction group"
                    onClick={() => navigate(`/transaction-group/${group.id}`)}
                />
                <SpinnerButton
                    isPending={linkIsPending}
                    disabled={submitError != null}
                    text="Link"
                    ariaLabel={`Link to "${group.description}"`}
                    onClick={handleLink}
                />
            </span>
            { submitError &&
                <div className={`${styles.inlineError} ${styles.suggestionError}`} role="alert">
                    {submitError.message}{submitError.details ? `: ${submitError.details}` : ''}
                </div>
            }
        </div>
    );
}

/**
 * The "very likely match" block on a pending card: renders only when the
 * strict heuristic found something, so most cards carry no extra noise.
 */
function SuggestedLinks({ statement, suggestions, hotkeysActive = false }) {
    if ( !suggestions?.length ) return null;
    return (
        <div className={styles.suggestions}>
            <div className={styles.suggestionsLabel}>
                Likely match{suggestions.length === 1 ? '' : 'es'} — link without creating transactions:
            </div>
            { suggestions.map((s, i) => (
                <SuggestedLink
                    key={s.group.id}
                    statement={statement}
                    suggestion={s}
                    hotkeyLink={hotkeysActive && i === 0}
                />
            ))}
        </div>
    );
}

/**
 * The inline "easy path" reconcile shown on a PENDING card for editors: pick a
 * source and target fund, confirm, done. Amount and date come straight from the
 * statement item (abs amount; the server defaults the group date to the item
 * date). One description field fills BOTH the group and its lone transaction
 * (the Stage 4 defaulting rule), so the common single-transaction reconcile
 * never needs the modal. Split/transfer/custom-date reconciles stay in
 * ReconcileStatementsModal, reachable from the card's secondary actions.
 */
function InlinePendingReconcile({ statement, prefill = null, hotkeysActive = false }) {
    const [ sourceId, setSourceId ] = useState(null);
    const [ targetId, setTargetId ] = useState(null);
    // Seed the description from the item's note (its key as a fallback), mirroring
    // the modal's group-description default.
    const [ description, setDescription ] = useState(statement.note ?? statement.key ?? '');
    const [ submitError, setSubmitError ] = useState(null);
    const [ prefillUsed, setPrefillUsed ] = useState(false);

    // Apply the history prefill ONCE when it arrives (the history query
    // resolves after the card mounts), and only onto an untouched form:
    // never clobber funds the user already picked, and only replace the
    // description while it still holds its seeded default.
    useEffect(() => {
        if ( prefill == null || prefillUsed ) return;
        if ( sourceId != null || targetId != null ) return;
        setSourceId(prefill.sourceId);
        setTargetId(prefill.targetId);
        setDescription(prev =>
            prev === (statement.note ?? statement.key ?? '') && prefill.description
                ? prefill.description
                : prev
        );
        setPrefillUsed(true);
    }, [prefill, prefillUsed, sourceId, targetId, statement.note, statement.key]);

    const amount = Math.abs(statement.amount);

    // Field-jump hotkey targets (S/T/D on the selected card). The fund
    // selectors open on trigger click -- and opening autofocuses their search
    // input -- so a synthetic click is the whole "jump into fund search"
    // gesture.
    const sourceWrapRef = useRef(null);
    const targetWrapRef = useRef(null);
    const descriptionWrapRef = useRef(null);

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

    // The card-selection hotkeys for this (the selected) card's form: Enter
    // confirms when submittable; S/T/D jump into the Source/Target/Description
    // fields (so a no-prefill card is still keyboard-only: s, type, Enter,
    // t, type, Enter, Enter).
    useEffect(() => {
        if ( !hotkeysActive ) return;
        const onKeyDown = (e) => {
            if ( isTypingTarget(e.target) ) return;
            switch ( plainKey(e) ) {
                case 'Enter':
                    if ( !canSubmit || postIsPending || submitError != null ) return;
                    e.preventDefault();
                    handleSubmit();
                    break;
                case 's':
                    e.preventDefault();
                    sourceWrapRef.current?.querySelector('[role="combobox"]')?.click();
                    break;
                case 't':
                    e.preventDefault();
                    targetWrapRef.current?.querySelector('[role="combobox"]')?.click();
                    break;
                case 'd': {
                    e.preventDefault();
                    const input = descriptionWrapRef.current?.querySelector('input');
                    input?.focus();
                    input?.select();
                    break;
                }
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [hotkeysActive, canSubmit, postIsPending, submitError, handleSubmit]);

    return (
        <div className={styles.inlineReconcile}>
            <div className={styles.inlineFundRow}>
                <div ref={sourceWrapRef}>
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
                </div>
                <div ref={targetWrapRef}>
                    <FundSearchableSelector
                        label="To (target)"
                        value={targetId}
                        onChange={(v) => { setTargetId(v); setSubmitError(null); }}
                        isFrozen={false}
                        isRequired={true}
                        allowNull={false}
                    />
                </div>
            </div>
            <div ref={descriptionWrapRef}>
                <LabeledTextInput
                    label="Description"
                    value={description}
                    isFrozen={false}
                    isRequired={true}
                    emptyStringPlaceholder="Enter description"
                    onChange={(v) => { setDescription(v); setSubmitError(null); }}
                    onKeyDown={(e) => {
                        // Plain form behavior, independent of card selection:
                        // Enter submits when ready; Escape hands focus back to
                        // the page so J/K navigation resumes.
                        if ( e.key === 'Escape' ) {
                            e.currentTarget.blur();
                            return;
                        }
                        if ( e.key !== 'Enter' || !canSubmit || postIsPending || submitError != null ) return;
                        e.preventDefault();
                        handleSubmit();
                    }}
                />
            </div>
            { prefillUsed && prefill &&
                <div className={styles.prefillHint}>
                    Funds prefilled from &ldquo;{prefill.description}&rdquo; ({prefill.date}) — a past reconcile with a matching note.
                </div>
            }
            <div className={styles.inlineReconcileFooter}>
                <span className={styles.inlineReconcileAmount}>
                    Reconciles <strong><Money value={amount} /></strong>
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
 *  - reconciled: view the linked group, or unlink (release back to pending
 *    without touching the group — distinct from deleting the group)
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
            { state === 'reconciled' && <>
                <TightIconButton
                    icon="fa-arrow-up-right-from-square"
                    tone="info"
                    ariaLabel="View the linked transaction group"
                    title="View the linked transaction group"
                    onClick={() => onAction('viewGroup', statement)}
                />
                <TightIconButton
                    icon="fa-link-slash"
                    tone="warn"
                    ariaLabel="Unlink from the transaction group"
                    title="Unlink: this bank line isn't explained by that group — release it to pending (the group is NOT deleted)"
                    disabled={!isEditor}
                    onClick={() => onAction('unlink', statement)}
                />
            </>}
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

function StatementCard({
    statement, suggestions, prefill, isEditor, togglingId,
    isSelected, hotkeysActive, onSelect, onToggleIgnored, onAction
}) {
    const state = statementStateOf(statement);

    // Keep a keyboard-selected card in view as J/K walk the list.
    const cardRef = useRef(null);
    useEffect(() => {
        if ( isSelected ) cardRef.current?.scrollIntoView({ block: 'nearest' });
    }, [isSelected]);

    return (
        <div
            ref={cardRef}
            className={`${styles.card} ${isSelected ? styles.cardSelected : ''}`}
            data-state={state}
            onClick={() => onSelect(statement.id)}
        >
            <div className={styles.cardHeader}>
                <div className={styles.cardMeta}>
                    <StatementStateBadge statement={statement} />
                    <span className={`tabular-nums ${styles.cardDate}`}>{statement.date}</span>
                    <span className={styles.cardSource}>{statement.source}</span>
                </div>
                <Money value={statement.amount} className={styles.cardAmount} faintZero={false} />
            </div>

            { (statement.note || statement.key) &&
                <div className={styles.cardNote} title={statement.note ?? statement.key}>
                    { statement.note ?? <span className={styles.keyFallback}>{statement.key}</span> }
                </div>
            }

            { state === 'pending' && isEditor && <>
                <SuggestedLinks
                    statement={statement}
                    suggestions={suggestions}
                    hotkeysActive={isSelected && hotkeysActive}
                />
                <InlinePendingReconcile
                    statement={statement}
                    prefill={prefill}
                    hotkeysActive={isSelected && hotkeysActive}
                />
            </>}

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
    const [ isImportOFXOpen, setIsImportOFXOpen ] = useState(false);
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

    const rawItems = statementsQ.data?.data;
    const items = useMemo(() => rawItems ?? [], [rawItems]);
    const totalItems = statementsQ.data?.total ?? 0;
    const pageCount = Math.max(1, Math.ceil(totalItems / pageSize));

    // Inline link suggestions for the pending cards on this page (see
    // useLinkSuggestions for the strict heuristic). Editors only -- the Link
    // button is the whole point of a suggestion.
    const pendingItems = useMemo(
        () => items.filter(s => statementStateOf(s) === 'pending'),
        [items]
    );
    const suggestionsByItemId = useLinkSuggestions(pendingItems, isEditor);
    const prefillsByItemId = useReconcilePrefills(pendingItems, isEditor);

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

    // --- Keyboard queue triage (see the helpers above the components) ----
    const [ isShortcutsOpen, setIsShortcutsOpen ] = useState(false);
    const [ selectedId, setSelectedId ] = useState(null);
    const searchWrapRef = useRef(null);

    const anyModalOpen = isImportOpen || isImportOFXOpen || actionTarget != null || isShortcutsOpen;
    const hotkeysActive = !anyModalOpen;

    const selectedIndex = useMemo(
        () => items.findIndex(s => s.id === selectedId),
        [items, selectedId]
    );

    // When the selected card leaves the list (confirmed/ignored away, or the
    // filters changed), move the selection to the card now in its place --
    // that's what keeps a confirm-J-confirm rhythm going with no mouse.
    const lastIndexRef = useRef(0);
    useEffect(() => {
        if ( selectedIndex >= 0 ) lastIndexRef.current = selectedIndex;
    }, [selectedIndex]);
    useEffect(() => {
        if ( selectedId == null || items.some(s => s.id === selectedId) ) return;
        const idx = Math.min(lastIndexRef.current, items.length - 1);
        setSelectedId(idx >= 0 ? items[idx].id : null);
    }, [items, selectedId]);

    const handleSelect = useCallback((id) => setSelectedId(id), []);

    useEffect(() => {
        if ( !hotkeysActive ) return;
        const onKeyDown = (e) => {
            const key = plainKey(e);
            if ( key == null ) return;
            if ( isTypingTarget(e.target) ) return;
            const selected = items.find(s => s.id === selectedId) ?? null;
            const state = selected ? statementStateOf(selected) : null;
            switch ( key ) {
                case 'j': case 'ArrowDown': {
                    e.preventDefault();
                    if ( items.length === 0 ) break;
                    const idx = selectedIndex < 0 ? 0 : Math.min(selectedIndex + 1, items.length - 1);
                    setSelectedId(items[idx].id);
                    break;
                }
                case 'k': case 'ArrowUp': {
                    e.preventDefault();
                    if ( items.length === 0 ) break;
                    const idx = selectedIndex < 0 ? items.length - 1 : Math.max(selectedIndex - 1, 0);
                    setSelectedId(items[idx].id);
                    break;
                }
                case 'Escape':
                    setSelectedId(null);
                    break;
                case '/':
                    e.preventDefault();
                    searchWrapRef.current?.querySelector('input')?.focus();
                    break;
                case '?':
                    setIsShortcutsOpen(true);
                    break;
                case 'i':
                    if ( selected && isEditor && (state === 'pending' || state === 'ignored') ) {
                        handleToggleIgnored(selected);
                    }
                    break;
                case 'l':
                    // Plain L belongs to the first suggestion (handled on the
                    // suggestion row itself, and a no-op when there is none);
                    // Shift+L opens the full picker, which is the only way to
                    // reach a group the suggester did not surface -- a cheque
                    // written months before it cleared, say.
                    if ( e.shiftKey && selected && isEditor && state === 'pending' ) {
                        e.preventDefault();
                        handleAction('link', selected);
                    }
                    break;
                case 'r':
                    if ( selected && isEditor && state === 'pending' ) handleAction('reconcile', selected);
                    break;
                case 'v':
                    if ( selected && state === 'reconciled' ) handleAction('viewGroup', selected);
                    break;
                case 'u':
                    if ( selected && isEditor && state === 'reconciled' ) handleAction('unlink', selected);
                    break;
                case 'e':
                    if ( selected && isEditor ) handleAction('edit', selected);
                    break;
                case 'Delete':
                    if ( selected && isEditor ) handleAction('delete', selected);
                    break;
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [hotkeysActive, items, selectedId, selectedIndex, isEditor, handleToggleIgnored, handleAction]);

    return (
        <div className={styles.page}>
            <div className={styles.topBar}>
                <h1>Bank Statements</h1>
                <div className={styles.topBarActions}>
                    { /* OFX first: it is the format to reach for when the bank
                         offers both, since its fields are specified rather than
                         laid out for a human to read. */ }
                    <IconButton
                        text="Upload OFX"
                        icon="fa-file-import"
                        ariaLabel="Upload a bank statement OFX or QFX file"
                        disabled={!isEditor}
                        onClick={() => setIsImportOFXOpen(true)}
                    />
                    <IconButton
                        text="Upload CSV"
                        icon="fa-file-arrow-up"
                        ariaLabel="Upload a bank statement CSV"
                        disabled={!isEditor}
                        onClick={() => setIsImportOpen(true)}
                    />
                </div>
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
                <div ref={searchWrapRef}>
                    <LabeledTextInput
                        label="Search"
                        value={searchTerm}
                        isFrozen={false}
                        allowNull={false}
                        emptyStringPlaceholder="Search source, key, or note..."
                        onChange={(value) => setSearchTerm(value ?? '')}
                    />
                </div>
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
                                            suggestions={suggestionsByItemId.get(s.id)}
                                            prefill={prefillsByItemId.get(s.id)}
                                            isEditor={isEditor}
                                            togglingId={togglingId}
                                            isSelected={s.id === selectedId}
                                            hotkeysActive={hotkeysActive}
                                            onSelect={handleSelect}
                                            onToggleIgnored={handleToggleIgnored}
                                            onAction={handleAction}
                                        />
                                    ))}
                                </div>
                                <div className={styles.paginationRow}>
                                    <Pagination
                                        page={page}
                                        pageSize={pageSize}
                                        totalItems={totalItems}
                                        onPageChange={setPage}
                                        onPageSizeChange={setPageSize}
                                        itemLabel="item"
                                    />
                                </div>
                            </>
                        }
                    </div>
            }

            <FloatingKeyboardHelp
                isOpen={isShortcutsOpen}
                setIsOpen={setIsShortcutsOpen}
                intro="Click a card (or press J) to select it, then act on it without touching the mouse. Shortcuts are disabled while typing in a field or while a modal is open."
                groups={SHORTCUT_GROUPS}
            />

            <ImportStatementsCSVModal
                isOpen={isImportOpen}
                setIsOpen={setIsImportOpen}
            />
            <ImportStatementsOFXModal
                isOpen={isImportOFXOpen}
                setIsOpen={setIsImportOFXOpen}
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
            <UnlinkStatementModal
                isOpen={targetKind === 'unlink'}
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
