import { useParams, useNavigate } from 'react-router';
import { useState, useMemo, useEffect, useRef } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';

import { useUrlFragment } from '../../hooks/URLFragment.jsx';
import {
    useGetTransactionGroupQuery,
    useGetFundsQuery,
    useGetMonthFinalizationsQuery,
} from '../../hooks/Queries.jsx';
import Spinner from '../../components/Spinner.jsx';
import { Card, CardActionHeader, CardSection, CardAutoGrid } from '../../components/Card.jsx';
import { LabeledTextInput, LabeledTextArea } from '../../components/Inputs.jsx';
import { IconButton, TightIconButton } from '../../components/Buttons.jsx';
import { BackLink } from '../../components/Links.jsx';
import { FundLabel, FinalizedBadge, Badge } from '../../components/Badges.jsx';
import {
    EditTransactionGroupModal,
    EditTransactionGroupTransactionsModal,
    EditTransactionModal,
    DeleteTransactionGroupModal,
} from '../../components/SpecialModals.jsx';
import { useAuthRoles } from '../../contexts/AuthContext.jsx';
import { formatDollars } from '../../components/domain.js';
import styles from './TransactionGroup.module.css';


/**
 * A single transaction line row. Carries `id="transaction-<id>"` for deep
 * linking (the page scrolls to and briefly highlights the fragment target),
 * and -- when the group is editable -- a per-line edit button wired to the
 * single-line PATCH surface (`EditTransactionModal`).
 */
function TransactionLineRow({ transaction, fundById, isHighlighted, canEdit, onEdit }) {
    const t = transaction;
    return (
        <tr
            id={`transaction-${t.id}`}
            className={`${styles.lineRow} ${isHighlighted ? styles.lineRowHighlighted : ''}`}
        >
            <td className={styles.lineFunds}>
                <FundLabel fund={fundById.get(t.source_fund_id)} />
                <FontAwesomeIcon icon="fa-solid fa-arrow-right" size="xs" className={styles.lineArrow} />
                <FundLabel fund={fundById.get(t.target_fund_id)} />
            </td>
            <td className={styles.lineDesc} title={t.description}>{t.description}</td>
            <td className={`${styles.lineAmount} tabular-nums`}>{formatDollars(t.amount)}</td>
            <td className={styles.lineNote} title={t.note ?? undefined}>
                { t.note
                    ? <span className={styles.lineNoteText}>{t.note}</span>
                    : <span className={styles.lineNoteEmpty}>—</span>
                }
            </td>
            <td className={styles.lineActions}>
                { canEdit &&
                    <TightIconButton
                        icon="fa-pen-to-square"
                        ariaLabel={`Edit transaction #${t.id}`}
                        title="Edit this transaction line"
                        onClick={() => onEdit(t)}
                    />
                }
            </td>
        </tr>
    );
}


export default function TransactionGroupPage() {
    const { id: groupId } = useParams();
    const { fragment } = useUrlFragment();
    const navigate = useNavigate();
    const roles = useAuthRoles();
    const isEditor = !!roles.editor;

    const groupQ = useGetTransactionGroupQuery(groupId, { retry: 1 });
    const fundsQ = useGetFundsQuery();
    const monthsQ = useGetMonthFinalizationsQuery();

    const group = groupQ.data;

    const fundById = useMemo(
        () => new Map((fundsQ.data ?? []).map(f => [ f.id, f ])),
        [fundsQ.data]
    );

    const isManaged = !!(group?.status?.allocation || group?.status?.eom_cleanup);
    const managedKind = group?.status?.allocation
        ? 'allocation'
        : (group?.status?.eom_cleanup ? 'end-of-month cleanup' : null);

    // A group is locked when its date falls inside a finalized month. Mirrors
    // the server's `assert_month_unfinalized` guard so the page reads-only
    // instead of letting the PATCH/DELETE routes 409.
    const finalizedMonth = useMemo(() => {
        if ( !group || !monthsQ.data ) return null;
        return monthsQ.data.find(m => group.date >= m.som_date && group.date <= m.eom_date) ?? null;
    }, [group, monthsQ.data]);
    const isFinalized = finalizedMonth != null;

    // Every write surface (details, atomic line editor, single line, delete) is
    // refused for managed groups and finalized months, and needs the editor
    // role. Compute it once.
    const canEdit = isEditor && !isManaged && !isFinalized;

    // Modal state
    const [ editDetailsOpen, setEditDetailsOpen ] = useState(false);
    const [ editTxnsOpen, setEditTxnsOpen ] = useState(false);
    const [ editLine, setEditLine ] = useState(null); // the transaction being line-edited
    const [ deleteOpen, setDeleteOpen ] = useState(false);

    // Deep-link scroll + highlight: on load (or when the fragment changes to a
    // different line), scroll the `#transaction-<id>` row into view and flash
    // it. `handledFragmentRef` keeps socket-driven refetches from re-scrolling.
    const [ highlightId, setHighlightId ] = useState(null);
    const handledFragmentRef = useRef(null);
    useEffect(() => {
        if ( groupQ.isPending || !group ) return;
        if ( handledFragmentRef.current === fragment ) return;

        const match = /^transaction-(\d+)$/.exec(fragment ?? '');
        if ( !match ) { handledFragmentRef.current = fragment; return; }

        const txId = parseInt(match[1], 10);
        if ( !group.transactions.some(t => t.id === txId) ) return;

        handledFragmentRef.current = fragment;
        // Small delay so the row is painted before we scroll to it
        const timeoutId = setTimeout(() => {
            const el = document.getElementById(`transaction-${txId}`);
            if ( el ) {
                const rect = el.getBoundingClientRect();
                const isFullyVisible = rect.top >= 0 && rect.bottom <= window.innerHeight;
                if ( !isFullyVisible ) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }
            setHighlightId(txId);
        }, 100);
        return () => clearTimeout(timeoutId);
    }, [groupQ.isPending, group, fragment]);

    // Fade the highlight out after the flash animation
    useEffect(() => {
        if ( highlightId == null ) return;
        const t = setTimeout(() => setHighlightId(null), 2200);
        return () => clearTimeout(t);
    }, [highlightId]);

    if ( groupQ.isPending ) {
        return (
            <div className={styles.container}>
                <div className={styles.loadingContainer}>
                    <Spinner size="2rem" />
                    <span>Loading transaction group...</span>
                </div>
            </div>
        );
    }

    if ( groupQ.isError ) {
        return (
            <div className={styles.container}>
                <div className={styles.centerState}>
                    <h2 className={styles.errorTitle}>Error</h2>
                    <p>
                        { groupQ.error.details?.message
                            ? `${groupQ.error.message}: ${groupQ.error.details.message}`
                            : groupQ.error.message
                        }
                    </p>
                    <BackLink to="/transactions" linkText="Back to Transactions" />
                </div>
            </div>
        );
    }

    const deleteDisabledReason = !isEditor
        ? "You need the editor role to delete transaction groups."
        : isManaged
        ? `Managed ${managedKind} groups cannot be deleted here.`
        : isFinalized
        ? `This group is in a finalized month (${finalizedMonth.som_date.slice(0, 7)}). Unfinalize it first.`
        : undefined;

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <h1 className={styles.title}>Transaction Group</h1>
                { isManaged &&
                    <Badge
                        icon={group.status.allocation ? 'fa-calendar-days' : 'fa-asterisk'}
                        text={group.status.allocation ? 'Allocation' : 'EOM cleanup'}
                        className={styles.managedBadge}
                    />
                }
                <FinalizedBadge value={isFinalized} />
                <BackLink to="/transactions" linkText="Transactions" />
            </div>

            { (isManaged || isFinalized) &&
                <div className={styles.readOnlyBanner} role="note">
                    { isManaged
                        ? `This is a managed ${managedKind} group — its details and transactions are maintained automatically and are read-only here.`
                        : `This group is in a finalized month (${finalizedMonth.som_date.slice(0, 7)}). Unfinalize that month from the Transactions page to edit or delete it.`
                    }
                </div>
            }

            <Card>
                <CardActionHeader
                    title="Details"
                    fontSize="1.25rem"
                >
                    { canEdit &&
                        <IconButton
                            text="Edit"
                            icon="fa-pen-to-square"
                            ariaLabel="Edit group details"
                            onClick={() => setEditDetailsOpen(true)}
                        />
                    }
                    <IconButton
                        text="Delete"
                        icon="fa-trash"
                        ariaLabel="Delete this transaction group"
                        buttonClassName={styles.deleteButton}
                        disabled={!canEdit}
                        title={deleteDisabledReason}
                        onClick={() => setDeleteOpen(true)}
                    />
                </CardActionHeader>

                <CardSection>
                    <CardAutoGrid>
                        <LabeledTextInput label="ID" value={String(group.id)} isFrozen={true} />
                        <LabeledTextInput label="Date" value={group.date} isFrozen={true} />
                        <LabeledTextInput label="Description" value={group.description} isFrozen={true} />
                        <LabeledTextArea
                            label="Note"
                            value={group.note}
                            isFrozen={true}
                            nullPlaceholder="(none)"
                        />
                    </CardAutoGrid>
                </CardSection>
            </Card>

            <Card className={styles.spaced}>
                <CardActionHeader
                    title={`Transactions (${group.transactions.length})`}
                    fontSize="1.25rem"
                >
                    { canEdit &&
                        <IconButton
                            text="Edit transactions"
                            icon="fa-pen-to-square"
                            ariaLabel="Add, edit, or remove transaction lines"
                            title="Add, edit, and remove lines in one atomic batch"
                            onClick={() => setEditTxnsOpen(true)}
                        />
                    }
                </CardActionHeader>

                <CardSection>
                    <div className={styles.lineTableScroll}>
                        <table className={styles.lineTable}>
                            <thead>
                                <tr>
                                    <th>Source → Target</th>
                                    <th>Description</th>
                                    <th className={styles.lineAmount}>Amount</th>
                                    <th>Note</th>
                                    <th aria-label="Actions" />
                                </tr>
                            </thead>
                            <tbody>
                                { group.transactions.map(t => (
                                    <TransactionLineRow
                                        key={t.id}
                                        transaction={t}
                                        fundById={fundById}
                                        isHighlighted={t.id === highlightId}
                                        canEdit={canEdit}
                                        onEdit={setEditLine}
                                    />
                                ))}
                            </tbody>
                        </table>
                    </div>
                </CardSection>
            </Card>

            <Card className={styles.spaced}>
                <CardSection title="Reconciled bank statement items">
                    { group.statements.length === 0
                        ? <p className={styles.mutedNote}>None — this group is not reconciled to any imported items.</p>
                        : <div className={styles.lineTableScroll}>
                            <table className={styles.lineTable}>
                                <thead>
                                    <tr>
                                        <th>Source</th>
                                        <th>Date</th>
                                        <th className={styles.lineAmount}>Amount</th>
                                        <th>Note</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    { group.statements.map(s => (
                                        <tr key={s.id} className={styles.lineRow}>
                                            <td><strong>{s.source}</strong></td>
                                            <td className="tabular-nums">{s.date}</td>
                                            <td className={`${styles.lineAmount} tabular-nums`}>{formatDollars(s.amount)}</td>
                                            <td className={styles.lineNote} title={s.note ?? s.key}>
                                                <span className={styles.lineNoteText}>{s.note ?? s.key}</span>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    }
                </CardSection>
            </Card>

            {/* Edit surfaces reuse the shared modals (all guards live there). */}
            <EditTransactionGroupModal
                isOpen={editDetailsOpen}
                setIsOpen={setEditDetailsOpen}
                group={group}
            />
            <EditTransactionGroupTransactionsModal
                isOpen={editTxnsOpen}
                setIsOpen={setEditTxnsOpen}
                group={group}
            />
            <EditTransactionModal
                isOpen={editLine != null}
                setIsOpen={(open) => { if ( !open ) setEditLine(null); }}
                transaction={editLine}
            />
            <DeleteTransactionGroupModal
                isOpen={deleteOpen}
                setIsOpen={setDeleteOpen}
                group={group}
                closePopoutCallback={() => navigate("/transactions")}
            />
        </div>
    );
}
