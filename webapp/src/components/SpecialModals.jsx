import { useState, useEffect, useCallback, useMemo } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';

import { CardModal, ConfirmationModal } from './Modal.jsx';
import { CardSection, CardAutoGrid, CardActionFooter, CardErrorSection } from './Card.jsx';
import {
    FundSearchableSelector,
    LabeledMonthInput
} from './SpecialInputs.jsx';
import {
    LabeledNumberInput,
    LabeledTextInput,
    LabeledDateInput,
    LabeledBooleanInput,
    LabeledSingleFileInput,
    LabeledSelector,
    LabeledTextArea
} from './Inputs.jsx';
import { IconButton, SpinnerButton, TightIconButton } from './Buttons.jsx';
import {
    usePostFundMutation,
    usePatchFundMutation,
    useDeleteFundMutation,
    usePostTransactionGroupMutation,
    usePostTransactionGroupFromStatementsMutation,
    usePatchTransactionGroupMutation,
    usePatchTransactionGroupTransactionsMutation,
    useDeleteTransactionGroupMutation,
    usePatchTransactionMutation,
    usePostImportStatementsMutation,
    usePatchStatementMutation,
    useDeleteStatementMutation,
    usePutAllocationMutation,
    useDeleteAllocationMutation,
    usePostCopyAllocationsMutation,
    usePostMonthFinalizationMutation,
    useDeleteMonthFinalizationMutation,
    usePostUserMutation,
    usePatchUserMutation,
    useDeleteUserMutation,
    usePostUserPasswordMutation,
    useDeleteUserSessionMutation,
    usePostUserApiKeyMutation,
    useDeleteUserApiKeyMutation
} from '../hooks/Queries.jsx';
import { useAuth, useAuthRoles } from '../contexts/AuthContext.jsx';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard.js';
import CopiedToast from './CopiedToast.jsx';

import styles from './SpecialModals.module.css';


function todayYDate() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function monthLabel(ydate) {
    return ydate ? ydate.slice(0, 7) : 'unknown';
}

function formatMoney(amount) {
    if ( amount == null ) return 'unknown';
    return (amount < 0 ? '-$' : '$') + Math.abs(amount).toFixed(2);
}

/**
 * Build a changed-fields-only PATCH payload: the API's PATCH endpoints only
 * touch the keys you send, and several fields are conditionally immutable
 * (e.g. a fund's history-affecting fields once finalizations exist) -- so
 * never send a field the user didn't actually change.
 */
function changedFields(initial, current, fields) {
    const changes = {};
    for ( const field of fields ) {
        if ( (current[field] ?? null) !== (initial[field] ?? null) ) {
            changes[field] = current[field] ?? null;
        }
    }
    return changes;
}


// ---------------------------------------------------------------------------
// Funds
// ---------------------------------------------------------------------------

export function CreateFundModal({ isOpen, setIsOpen, initialParentId = null, initialParent = null, parentFrozen = false }) {

    const defaultData = () => ({
        name: null,
        parent_id: initialParentId,
        tracked: true,
        monthly: false,
        pool: false,
        start_date: todayYDate(),
        start_balance: 0,
        color: null
    });

    const [ data, setData ] = useState(defaultData);
    const [ submitError, setSubmitError ] = useState(null);

    const reset = useCallback(() => {
        setData(defaultData());
        setSubmitError(null);
    }, [initialParentId]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (isOpen) reset();
    }, [isOpen, reset]);

    const handleChange = (field, value) => {
        setData(prevData => {
            const next = { ...prevData, [field]: value };
            // Keep the flag interdependencies consistent client-side (the
            // server enforces them too): pool/monthly imply tracked and
            // exclude each other; untracked funds have no start point
            if ( field === 'monthly' && value ) next.pool = false;
            if ( field === 'pool' && value ) next.monthly = false;
            if ( (field === 'monthly' || field === 'pool') && value ) next.tracked = true;
            if ( field === 'tracked' && !value ) {
                next.monthly = false;
                next.pool = false;
                next.start_date = null;
                next.start_balance = null;
            }
            if ( field === 'tracked' && value ) {
                next.start_date = prevData.start_date ?? todayYDate();
                next.start_balance = prevData.start_balance ?? 0;
            }
            return next;
        });
        setSubmitError(null);
    };

    const dataValidity = {
        name: !data.name?.trim() ? 'Name is required.' : null,
        start_date: data.tracked && !data.start_date ? 'Tracked funds need a start date.' : null,
        start_balance: data.tracked && data.start_balance == null ? 'Tracked funds need a start balance.' : null,
        monthly: data.monthly && !data.parent_id ? 'Monthly funds need a parent (with a pool ancestor).' : null,
    };

    const {
        mutate: postMutate,
        isPending: postIsPending
    } = usePostFundMutation();

    const handleSubmit = useCallback(() => {
        postMutate(
            { formData: { ...data } },
            {
                onSuccess: () => setIsOpen(false),
                onError: (err) => setSubmitError({
                    message: err.message,
                    details: err.details?.message
                })
            }
        );
    }, [data, postMutate, setIsOpen]);

    return (
        <CardModal
            title="Create a new Fund"
            isOpen={isOpen}
            setIsOpen={setIsOpen}
        >
            <CardSection title="Details">
                <CardAutoGrid>
                    <LabeledTextInput
                        label="Name"
                        value={data.name}
                        isRequired={true}
                        isFrozen={false}
                        nullPlaceholder="Enter fund name"
                        onChange={(value) => handleChange('name', value)}
                        allowNull={false}
                        validityMessage={dataValidity.name}
                    />
                    <FundSearchableSelector
                        label="Parent Fund"
                        value={data.parent_id}
                        originalFund={initialParent}
                        onChange={(value) => handleChange('parent_id', value)}
                        isFrozen={parentFrozen}
                        allowNull={true}
                    />
                    <LabeledBooleanInput
                        label="Tracked?"
                        value={data.tracked}
                        isFrozen={false}
                        onChange={(value) => handleChange('tracked', value)}
                    />
                    <LabeledBooleanInput
                        label="Pool?"
                        value={data.pool}
                        isFrozen={false}
                        onChange={(value) => handleChange('pool', value)}
                        inputTitle="Pools are the source/sink of money for their descendants (allocations draw from them)"
                    />
                    <LabeledBooleanInput
                        label="Monthly?"
                        value={data.monthly}
                        isFrozen={false}
                        onChange={(value) => handleChange('monthly', value)}
                        inputTitle="Monthly funds reset into their pool at end of month"
                        validityMessage={dataValidity.monthly}
                    />
                    <LabeledDateInput
                        label="Start Date"
                        value={data.start_date}
                        isRequired={data.tracked}
                        isFrozen={!data.tracked}
                        nullPlaceholder="(untracked)"
                        onChange={(value) => handleChange('start_date', value || null)}
                        validityMessage={dataValidity.start_date}
                    />
                    <LabeledNumberInput
                        label="Start Balance ($)"
                        value={data.start_balance}
                        isRequired={data.tracked}
                        isFrozen={!data.tracked}
                        step={0.01}
                        nullPlaceholder="(untracked)"
                        onChange={(value) => handleChange('start_balance', value)}
                        validityMessage={dataValidity.start_balance}
                    />
                    <LabeledTextInput
                        label="Color"
                        value={data.color}
                        isFrozen={false}
                        nullPlaceholder="(none)"
                        onChange={(value) => handleChange('color', value || null)}
                        allowNull={true}
                    />
                </CardAutoGrid>
            </CardSection>

            <CardActionFooter>
                <SpinnerButton
                    isPending={postIsPending}
                    disabled={Object.values(dataValidity).some(v => v != null) || submitError != null}
                    text="Submit"
                    ariaLabel="Submit new fund"
                    onClick={handleSubmit}
                />
            </CardActionFooter>

            { submitError &&
                <CardErrorSection errorMessage={submitError.message} errorMessageDetails={submitError.details} />
            }
        </CardModal>
    );
}

export function EditFundModal({ isOpen, setIsOpen, fund }) {

    const initialData = useCallback(() => ({
        name: fund?.name ?? null,
        parent_id: fund?.parent_id ?? null,
        tracked: fund?.status?.tracked ?? false,
        monthly: fund?.status?.monthly ?? false,
        pool: fund?.status?.pool ?? false,
        start_date: fund?.start?.date ?? null,
        start_balance: fund?.start?.forward_balance ?? null,
        color: fund?.color ?? null
    }), [fund]);

    const [ data, setData ] = useState(initialData);
    const [ submitError, setSubmitError ] = useState(null);

    const reset = useCallback(() => {
        setData(initialData());
        setSubmitError(null);
    }, [initialData]);

    useEffect(() => {
        if (isOpen) reset();
    }, [isOpen, reset]);

    const handleChange = (field, value) => {
        setData(prevData => ({ ...prevData, [field]: value }));
        setSubmitError(null);
    };

    const patch = changedFields(initialData(), data, [
        'name', 'parent_id', 'tracked', 'monthly', 'pool', 'start_date', 'start_balance', 'color'
    ]);

    const dataValidity = {
        name: !data.name?.trim() ? 'Name is required.' : null,
        start_date: data.tracked && !data.start_date ? 'Tracked funds need a start date.' : null,
        start_balance: data.tracked && data.start_balance == null ? 'Tracked funds need a start balance.' : null,
    };

    const {
        mutate: patchMutate,
        isPending: patchIsPending
    } = usePatchFundMutation();

    const handleSubmit = useCallback(() => {
        patchMutate(
            { formData: { id: fund.id, ...patch } },
            {
                onSuccess: () => setIsOpen(false),
                onError: (err) => setSubmitError({
                    message: err.message,
                    details: err.details?.message
                })
            }
        );
    }, [fund, patch, patchMutate, setIsOpen]);  

    return (
        <CardModal
            title={`Edit Fund: ${fund?.name ?? ''}`}
            isOpen={isOpen}
            setIsOpen={setIsOpen}
        >
            <CardSection title="Details">
                <p className={styles.modalHint}>
                    Only changed fields are sent. History-affecting fields (start
                    point, tracked/monthly/pool, and the parent of monthly funds)
                    are refused by the server while any finalizations exist.
                </p>
                <CardAutoGrid>
                    <LabeledTextInput
                        label="Name"
                        value={data.name}
                        isRequired={true}
                        isFrozen={false}
                        isChanged={'name' in patch}
                        onChange={(value) => handleChange('name', value)}
                        validityMessage={dataValidity.name}
                    />
                    <FundSearchableSelector
                        label="Parent Fund"
                        value={data.parent_id}
                        onChange={(value) => handleChange('parent_id', value)}
                        isFrozen={false}
                        isChanged={'parent_id' in patch}
                        allowNull={true}
                        excludeIds={fund ? [fund.id] : []}
                    />
                    <LabeledBooleanInput
                        label="Tracked?"
                        value={data.tracked}
                        isFrozen={false}
                        isChanged={'tracked' in patch}
                        onChange={(value) => handleChange('tracked', value)}
                    />
                    <LabeledBooleanInput
                        label="Pool?"
                        value={data.pool}
                        isFrozen={false}
                        isChanged={'pool' in patch}
                        onChange={(value) => handleChange('pool', value)}
                    />
                    <LabeledBooleanInput
                        label="Monthly?"
                        value={data.monthly}
                        isFrozen={false}
                        isChanged={'monthly' in patch}
                        onChange={(value) => handleChange('monthly', value)}
                    />
                    <LabeledDateInput
                        label="Start Date"
                        value={data.start_date}
                        isFrozen={!data.tracked}
                        isChanged={'start_date' in patch}
                        nullPlaceholder="(untracked)"
                        onChange={(value) => handleChange('start_date', value || null)}
                        validityMessage={dataValidity.start_date}
                    />
                    <LabeledNumberInput
                        label="Start Balance ($)"
                        value={data.start_balance}
                        isFrozen={!data.tracked}
                        isChanged={'start_balance' in patch}
                        step={0.01}
                        nullPlaceholder="(untracked)"
                        onChange={(value) => handleChange('start_balance', value)}
                        validityMessage={dataValidity.start_balance}
                    />
                    <LabeledTextInput
                        label="Color"
                        value={data.color}
                        isFrozen={false}
                        isChanged={'color' in patch}
                        nullPlaceholder="(none)"
                        onChange={(value) => handleChange('color', value || null)}
                        allowNull={true}
                    />
                </CardAutoGrid>
            </CardSection>

            <CardActionFooter>
                <SpinnerButton
                    isPending={patchIsPending}
                    disabled={
                        Object.keys(patch).length === 0
                        || Object.values(dataValidity).some(v => v != null)
                        || submitError != null
                    }
                    text="Save Changes"
                    ariaLabel="Save fund changes"
                    onClick={handleSubmit}
                />
            </CardActionFooter>

            { submitError &&
                <CardErrorSection errorMessage={submitError.message} errorMessageDetails={submitError.details} />
            }
        </CardModal>
    );
}

export function DeleteFundModal({ isOpen, setIsOpen, fund, closePopoutCallback }) {

    const {
        mutateAsync: deleteMutate // NOTE, mutateAsync to return a promise, which throws on error -> handled by ConfirmationModal
    } = useDeleteFundMutation();

    const deleteOnConfirm = useCallback(async () => {
        return deleteMutate(
            { formData: { id: fund.id } },
            {
                onSuccess: () => {
                    if (closePopoutCallback) closePopoutCallback();
                }
            }
        );
    }, [ deleteMutate, closePopoutCallback, fund ]);

    return (
        <ConfirmationModal
            isOpen={isOpen}
            setIsOpen={setIsOpen}
            title="Delete Fund"
            content={<>
                <div style={{ width: '30rem', textAlign: 'center' }}>
                    Are you sure you want to delete the fund <strong>{fund?.name ?? 'unknown'}</strong>?
                </div>
                <div style={{ width: '30rem', textAlign: 'center', marginTop: '1rem' }}>
                    This action cannot be undone. The server refuses deletion while the
                    fund still has transactions, children, or finalization history.
                </div>
            </>}
            confirmText="Delete Fund"
            confirmButtonClassName={styles.dangerConfirmButton}
            onConfirm={deleteOnConfirm}
        />
    );
}


// ---------------------------------------------------------------------------
// Transaction groups & transactions
// ---------------------------------------------------------------------------

let __lineKeyCounter = 1;

function newTransactionLine(fields = {}) {
    return {
        _key: __lineKeyCounter++,
        id: null, // Non-null when the line already exists on the server
        source_fund_id: null,
        target_fund_id: null,
        amount: null,
        description: null,
        note: null,
        ...fields
    };
}

function transactionLineValidity(line) {
    return {
        source_fund_id: !line.source_fund_id
            ? 'Source fund is required.'
            : (line.source_fund_id === line.target_fund_id ? 'Source and target must differ.' : null),
        target_fund_id: !line.target_fund_id ? 'Target fund is required.' : null,
        amount: (line.amount == null || line.amount <= 0) ? 'Amount must be positive.' : null,
        description: !line.description?.trim() ? 'Description is required.' : null,
    };
}

function transactionLineHasProblem(line) {
    return Object.values(transactionLineValidity(line)).some(v => v != null);
}

function transactionLineToSpec(line) {
    return {
        source_fund_id: line.source_fund_id,
        target_fund_id: line.target_fund_id,
        amount: line.amount,
        description: line.description,
        note: line.note ?? null
    };
}

function TransactionLineFields({ line, onChange, onRemove, removable = true }) {

    const validity = transactionLineValidity(line);

    return (
        <div className={styles.transactionLineContainer}>
            <div className={styles.transactionLineHeader}>
                <span className={styles.transactionLineTitle}>
                    { line.id != null ? `Transaction #${line.id}` : 'New transaction' }
                </span>
                { removable &&
                    <TightIconButton
                        icon="fa-trash"
                        ariaLabel="Remove transaction line"
                        title="Remove this line"
                        onClick={onRemove}
                    />
                }
            </div>
            <CardAutoGrid>
                <FundSearchableSelector
                    label="Source Fund"
                    value={line.source_fund_id}
                    onChange={(value) => onChange('source_fund_id', value)}
                    isFrozen={false}
                    isRequired={true}
                    allowNull={false}
                    validityMessage={validity.source_fund_id}
                />
                <FundSearchableSelector
                    label="Target Fund"
                    value={line.target_fund_id}
                    onChange={(value) => onChange('target_fund_id', value)}
                    isFrozen={false}
                    isRequired={true}
                    allowNull={false}
                    validityMessage={validity.target_fund_id}
                />
                <LabeledNumberInput
                    label="Amount ($)"
                    value={line.amount}
                    isFrozen={false}
                    isRequired={true}
                    min={0.01}
                    step={0.01}
                    nullPlaceholder="Enter amount"
                    onChange={(value) => onChange('amount', value)}
                    allowNull={false}
                    validityMessage={validity.amount}
                />
                <LabeledTextInput
                    label="Description"
                    value={line.description}
                    isFrozen={false}
                    isRequired={true}
                    nullPlaceholder="Enter description"
                    onChange={(value) => onChange('description', value)}
                    allowNull={false}
                    validityMessage={validity.description}
                />
                <LabeledTextArea
                    label="Note"
                    value={line.note}
                    isFrozen={false}
                    minHeight="4rem"
                    nullPlaceholder="(none)"
                    onChange={(value) => onChange('note', value)}
                    allowNull={true}
                />
            </CardAutoGrid>
        </div>
    );
}

function TransactionLinesEditor({ lines, setLines, minLines = 1 }) {

    const updateLine = (key, field, value) => {
        setLines(prev => prev.map(l => l._key === key ? { ...l, [field]: value } : l));
    };
    const removeLine = (key) => {
        setLines(prev => prev.filter(l => l._key !== key));
    };
    const addLine = () => {
        setLines(prev => [ ...prev, newTransactionLine() ]);
    };

    return (
        <div className={styles.transactionLinesEditor}>
            { lines.map((line) => (
                <TransactionLineFields
                    key={line._key}
                    line={line}
                    onChange={(field, value) => updateLine(line._key, field, value)}
                    onRemove={() => removeLine(line._key)}
                    removable={lines.length > minLines}
                />
            ))}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <IconButton
                    text="Add transaction"
                    icon="fa-square-plus"
                    ariaLabel="Add a transaction line"
                    onClick={addLine}
                />
            </div>
        </div>
    );
}

export function CreateTransactionGroupModal({ isOpen, setIsOpen, initialDate = null }) {

    const defaultData = () => ({
        date: initialDate ?? todayYDate(),
        description: null,
        note: null
    });

    const [ data, setData ] = useState(defaultData);
    const [ lines, setLines ] = useState(() => [ newTransactionLine() ]);
    const [ submitError, setSubmitError ] = useState(null);

    const reset = useCallback(() => {
        setData(defaultData());
        setLines([ newTransactionLine() ]);
        setSubmitError(null);
    }, [initialDate]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (isOpen) reset();
    }, [isOpen, reset]);

    const handleChange = (field, value) => {
        setData(prevData => ({ ...prevData, [field]: value }));
        setSubmitError(null);
    };

    const dataValidity = {
        date: !data.date ? 'Date is required.' : null,
        description: !data.description?.trim() ? 'Description is required.' : null,
    };
    const linesHaveProblems = lines.length < 1 || lines.some(transactionLineHasProblem);

    const {
        mutate: postMutate,
        isPending: postIsPending
    } = usePostTransactionGroupMutation();

    const handleSubmit = useCallback(() => {
        postMutate(
            {
                formData: {
                    date: data.date,
                    description: data.description,
                    note: data.note ?? null,
                    transactions: lines.map(transactionLineToSpec)
                }
            },
            {
                onSuccess: () => setIsOpen(false),
                onError: (err) => setSubmitError({
                    message: err.message,
                    details: err.details?.message
                })
            }
        );
    }, [data, lines, postMutate, setIsOpen]);

    return (
        <CardModal
            title="Create a new Transaction Group"
            isOpen={isOpen}
            setIsOpen={setIsOpen}
            cardClassName={styles.wideModalCard}
        >
            <CardSection title="Group Details">
                <CardAutoGrid>
                    <LabeledDateInput
                        label="Date"
                        value={data.date}
                        isRequired={true}
                        isFrozen={false}
                        onChange={(value) => handleChange('date', value || null)}
                        validityMessage={dataValidity.date}
                    />
                    <LabeledTextInput
                        label="Description"
                        value={data.description}
                        isRequired={true}
                        isFrozen={false}
                        nullPlaceholder="Enter description"
                        onChange={(value) => handleChange('description', value)}
                        validityMessage={dataValidity.description}
                    />
                    <LabeledTextArea
                        label="Note"
                        value={data.note}
                        isFrozen={false}
                        minHeight="4rem"
                        nullPlaceholder="(none)"
                        onChange={(value) => handleChange('note', value)}
                        allowNull={true}
                    />
                </CardAutoGrid>
            </CardSection>

            <CardSection title="Transactions">
                <TransactionLinesEditor lines={lines} setLines={setLines} />
            </CardSection>

            <CardActionFooter>
                <SpinnerButton
                    isPending={postIsPending}
                    disabled={
                        Object.values(dataValidity).some(v => v != null)
                        || linesHaveProblems
                        || submitError != null
                    }
                    text="Submit"
                    ariaLabel="Submit new transaction group"
                    onClick={handleSubmit}
                />
            </CardActionFooter>

            { submitError &&
                <CardErrorSection errorMessage={submitError.message} errorMessageDetails={submitError.details} />
            }
        </CardModal>
    );
}

export function EditTransactionGroupModal({ isOpen, setIsOpen, group }) {

    const initialData = useCallback(() => ({
        date: group?.date ?? null,
        description: group?.description ?? null,
        note: group?.note ?? null
    }), [group]);

    const [ data, setData ] = useState(initialData);
    const [ submitError, setSubmitError ] = useState(null);

    const reset = useCallback(() => {
        setData(initialData());
        setSubmitError(null);
    }, [initialData]);

    useEffect(() => {
        if (isOpen) reset();
    }, [isOpen, reset]);

    const handleChange = (field, value) => {
        setData(prevData => ({ ...prevData, [field]: value }));
        setSubmitError(null);
    };

    const patch = changedFields(initialData(), data, [ 'date', 'description', 'note' ]);

    const dataValidity = {
        date: !data.date ? 'Date is required.' : null,
        description: !data.description?.trim() ? 'Description is required.' : null,
    };

    const isManaged = group?.status?.allocation || group?.status?.eom_cleanup;

    const {
        mutate: patchMutate,
        isPending: patchIsPending
    } = usePatchTransactionGroupMutation();

    const handleSubmit = useCallback(() => {
        patchMutate(
            { formData: { id: group.id, ...patch } },
            {
                onSuccess: () => setIsOpen(false),
                onError: (err) => setSubmitError({
                    message: err.message,
                    details: err.details?.message
                })
            }
        );
    }, [group, patch, patchMutate, setIsOpen]);  

    return (
        <CardModal
            title="Edit Transaction Group"
            isOpen={isOpen}
            setIsOpen={setIsOpen}
        >
            <CardSection title="Group Details">
                { isManaged &&
                    <p className={styles.modalWarning}>
                        This is a managed {group?.status?.allocation ? 'allocation' : 'end-of-month cleanup'} group:
                        it cannot be edited here.
                    </p>
                }
                <CardAutoGrid>
                    <LabeledDateInput
                        label="Date"
                        value={data.date}
                        isRequired={true}
                        isFrozen={isManaged}
                        isChanged={'date' in patch}
                        onChange={(value) => handleChange('date', value || null)}
                        validityMessage={dataValidity.date}
                        inputTitle="Changing the date cascades to every transaction in the group"
                    />
                    <LabeledTextInput
                        label="Description"
                        value={data.description}
                        isRequired={true}
                        isFrozen={isManaged}
                        isChanged={'description' in patch}
                        onChange={(value) => handleChange('description', value)}
                        validityMessage={dataValidity.description}
                    />
                    <LabeledTextArea
                        label="Note"
                        value={data.note}
                        isFrozen={isManaged}
                        isChanged={'note' in patch}
                        minHeight="4rem"
                        nullPlaceholder="(none)"
                        onChange={(value) => handleChange('note', value)}
                        allowNull={true}
                    />
                </CardAutoGrid>
            </CardSection>

            <CardActionFooter>
                <SpinnerButton
                    isPending={patchIsPending}
                    disabled={
                        isManaged
                        || Object.keys(patch).length === 0
                        || Object.values(dataValidity).some(v => v != null)
                        || submitError != null
                    }
                    text="Save Changes"
                    ariaLabel="Save transaction group changes"
                    onClick={handleSubmit}
                />
            </CardActionFooter>

            { submitError &&
                <CardErrorSection errorMessage={submitError.message} errorMessageDetails={submitError.details} />
            }
        </CardModal>
    );
}

export function EditTransactionGroupTransactionsModal({ isOpen, setIsOpen, group }) {

    const [ lines, setLines ] = useState([]);
    const [ submitError, setSubmitError ] = useState(null);

    const reset = useCallback(() => {
        setLines((group?.transactions ?? []).map(t => newTransactionLine({
            id: t.id,
            source_fund_id: t.source_fund_id,
            target_fund_id: t.target_fund_id,
            amount: t.amount,
            description: t.description,
            note: t.note
        })));
        setSubmitError(null);
    }, [group]);

    useEffect(() => {
        if (isOpen) reset();
    }, [isOpen, reset]);

    const setLinesAndClearError = useCallback((updater) => {
        setSubmitError(null);
        setLines(updater);
    }, []);

    const originalById = useMemo(
        () => new Map((group?.transactions ?? []).map(t => [ t.id, t ])),
        [group]
    );

    // Removed EXISTING lines are derived, not tracked: any original id no
    // longer present in the editor lands in the payload's `remove` list
    // (new, never-saved lines just disappear)
    const removedIds = [ ...originalById.keys() ].filter(id => !lines.some(l => l.id === id));

    const add = lines.filter(l => l.id == null).map(transactionLineToSpec);
    const update = lines
        .filter(l => l.id != null)
        .map(l => {
            const changes = changedFields(originalById.get(l.id) ?? {}, l, [
                'source_fund_id', 'target_fund_id', 'amount', 'description', 'note'
            ]);
            return Object.keys(changes).length ? { id: l.id, ...changes } : null;
        })
        .filter(Boolean);

    const linesHaveProblems = lines.some(transactionLineHasProblem);
    const nothingToDo = add.length === 0 && update.length === 0 && removedIds.length === 0;
    const isManaged = group?.status?.allocation || group?.status?.eom_cleanup;

    const {
        mutate: patchMutate,
        isPending: patchIsPending
    } = usePatchTransactionGroupTransactionsMutation();

    const handleSubmit = useCallback(() => {
        patchMutate(
            {
                formData: {
                    id: group.id,
                    ...(add.length ? { add } : {}),
                    ...(update.length ? { update } : {}),
                    ...(removedIds.length ? { remove: removedIds } : {})
                }
            },
            {
                onSuccess: () => setIsOpen(false),
                onError: (err) => setSubmitError({
                    message: err.message,
                    details: err.details?.message
                })
            }
        );
    }, [group, add, update, removedIds, patchMutate, setIsOpen]);

    return (
        <CardModal
            title="Edit Transactions"
            isOpen={isOpen}
            setIsOpen={setIsOpen}
            cardClassName={styles.wideModalCard}
        >
            <CardSection title={`Transactions of: ${group?.description ?? ''} (${group?.date ?? ''})`}>
                { isManaged &&
                    <p className={styles.modalWarning}>
                        This is a managed {group?.status?.allocation ? 'allocation' : 'end-of-month cleanup'} group:
                        its transactions cannot be edited here.
                    </p>
                }
                <p className={styles.modalHint}>
                    All adds, edits, and removals are applied in one atomic batch.
                    The group must keep at least one transaction — to empty it,
                    delete the group instead.
                </p>
                <TransactionLinesEditor lines={lines} setLines={setLinesAndClearError} />
            </CardSection>

            <CardActionFooter>
                <SpinnerButton
                    isPending={patchIsPending}
                    disabled={
                        isManaged
                        || nothingToDo
                        || lines.length < 1
                        || linesHaveProblems
                        || submitError != null
                    }
                    text="Save Changes"
                    ariaLabel="Save transaction edits"
                    onClick={handleSubmit}
                />
            </CardActionFooter>

            { submitError &&
                <CardErrorSection errorMessage={submitError.message} errorMessageDetails={submitError.details} />
            }
        </CardModal>
    );
}

export function DeleteTransactionGroupModal({ isOpen, setIsOpen, group, closePopoutCallback }) {

    const {
        mutateAsync: deleteMutate // NOTE, mutateAsync to return a promise, which throws on error -> handled by ConfirmationModal
    } = useDeleteTransactionGroupMutation();

    const deleteOnConfirm = useCallback(async () => {
        return deleteMutate(
            { formData: { id: group.id } },
            {
                onSuccess: () => {
                    if (closePopoutCallback) closePopoutCallback();
                }
            }
        );
    }, [ deleteMutate, closePopoutCallback, group ]);

    const transactionCount = group?.transactions?.length ?? 0;
    const statementCount = group?.statements?.length ?? 0;

    return (
        <ConfirmationModal
            isOpen={isOpen}
            setIsOpen={setIsOpen}
            title="Delete Transaction Group"
            content={<>
                <div style={{ width: '30rem', textAlign: 'center' }}>
                    Are you sure you want to delete <strong>{group?.description ?? 'unknown'}</strong> ({group?.date ?? 'unknown'})
                    and its {transactionCount} transaction{transactionCount === 1 ? '' : 's'}?
                </div>
                { statementCount > 0 &&
                    <div style={{ width: '30rem', textAlign: 'center', marginTop: '1rem' }} className={styles.modalWarning}>
                        This group reconciles {statementCount} bank statement item{statementCount === 1 ? '' : 's'},
                        which will be released back to pending. Reconciling them again
                        without removing these transactions elsewhere double-counts.
                    </div>
                }
                <div style={{ width: '30rem', textAlign: 'center', marginTop: '1rem' }}>
                    This action cannot be undone.
                </div>
            </>}
            confirmText="Delete Transaction Group"
            confirmButtonClassName={styles.dangerConfirmButton}
            onConfirm={deleteOnConfirm}
        />
    );
}

export function EditTransactionModal({ isOpen, setIsOpen, transaction }) {

    const initialData = useCallback(() => ({
        source_fund_id: transaction?.source_fund_id ?? null,
        target_fund_id: transaction?.target_fund_id ?? null,
        amount: transaction?.amount ?? null,
        description: transaction?.description ?? null,
        note: transaction?.note ?? null
    }), [transaction]);

    const [ data, setData ] = useState(initialData);
    const [ submitError, setSubmitError ] = useState(null);

    const reset = useCallback(() => {
        setData(initialData());
        setSubmitError(null);
    }, [initialData]);

    useEffect(() => {
        if (isOpen) reset();
    }, [isOpen, reset]);

    const handleChange = (field, value) => {
        setData(prevData => ({ ...prevData, [field]: value }));
        setSubmitError(null);
    };

    const patch = changedFields(initialData(), data, [
        'source_fund_id', 'target_fund_id', 'amount', 'description', 'note'
    ]);

    const validity = transactionLineValidity(data);
    const isManaged = transaction?.allocation || transaction?.eom_cleanup_id != null;

    const {
        mutate: patchMutate,
        isPending: patchIsPending
    } = usePatchTransactionMutation();

    const handleSubmit = useCallback(() => {
        patchMutate(
            { formData: { id: transaction.id, ...patch } },
            {
                onSuccess: () => setIsOpen(false),
                onError: (err) => setSubmitError({
                    message: err.message,
                    details: err.details?.message
                })
            }
        );
    }, [transaction, patch, patchMutate, setIsOpen]);  

    return (
        <CardModal
            title="Edit Transaction"
            isOpen={isOpen}
            setIsOpen={setIsOpen}
        >
            <CardSection title="Details">
                { isManaged &&
                    <p className={styles.modalWarning}>
                        This is a managed {transaction?.allocation ? 'allocation' : 'end-of-month cleanup'} transaction:
                        it cannot be edited here.
                    </p>
                }
                <p className={styles.modalHint}>
                    The transaction's date belongs to its group — edit the group to change it.
                </p>
                <CardAutoGrid>
                    <FundSearchableSelector
                        label="Source Fund"
                        value={data.source_fund_id}
                        onChange={(value) => handleChange('source_fund_id', value)}
                        isFrozen={isManaged}
                        isRequired={true}
                        isChanged={'source_fund_id' in patch}
                        allowNull={false}
                        validityMessage={validity.source_fund_id}
                    />
                    <FundSearchableSelector
                        label="Target Fund"
                        value={data.target_fund_id}
                        onChange={(value) => handleChange('target_fund_id', value)}
                        isFrozen={isManaged}
                        isRequired={true}
                        isChanged={'target_fund_id' in patch}
                        allowNull={false}
                        validityMessage={validity.target_fund_id}
                    />
                    <LabeledNumberInput
                        label="Amount ($)"
                        value={data.amount}
                        isFrozen={isManaged}
                        isRequired={true}
                        isChanged={'amount' in patch}
                        min={0.01}
                        step={0.01}
                        onChange={(value) => handleChange('amount', value)}
                        allowNull={false}
                        validityMessage={validity.amount}
                    />
                    <LabeledTextInput
                        label="Description"
                        value={data.description}
                        isFrozen={isManaged}
                        isRequired={true}
                        isChanged={'description' in patch}
                        onChange={(value) => handleChange('description', value)}
                        validityMessage={validity.description}
                    />
                    <LabeledTextArea
                        label="Note"
                        value={data.note}
                        isFrozen={isManaged}
                        isChanged={'note' in patch}
                        minHeight="4rem"
                        nullPlaceholder="(none)"
                        onChange={(value) => handleChange('note', value)}
                        allowNull={true}
                    />
                </CardAutoGrid>
            </CardSection>

            <CardActionFooter>
                <SpinnerButton
                    isPending={patchIsPending}
                    disabled={
                        isManaged
                        || Object.keys(patch).length === 0
                        || Object.values(validity).some(v => v != null)
                        || submitError != null
                    }
                    text="Save Changes"
                    ariaLabel="Save transaction changes"
                    onClick={handleSubmit}
                />
            </CardActionFooter>

            { submitError &&
                <CardErrorSection errorMessage={submitError.message} errorMessageDetails={submitError.details} />
            }
        </CardModal>
    );
}

/**
 * View (and edit in place) the note on a transaction group or a single
 * transaction: pass exactly one of `group`/`transaction`. Managed
 * allocation/eom_cleanup rows are read-only (their PATCH routes 409), as are
 * non-editor viewers.
 */
export function TransactionNoteModal({ isOpen, setIsOpen, group = null, transaction = null }) {

    const entity = group ?? transaction;
    const roles = useAuthRoles();

    const [ note, setNote ] = useState(null);
    const [ isEditing, setIsEditing ] = useState(false);
    const [ submitError, setSubmitError ] = useState(null);

    useEffect(() => {
        if (isOpen) {
            setNote(entity?.note ?? null);
            setIsEditing(false);
            setSubmitError(null);
        }
    }, [isOpen, entity]);

    const isManaged = group
        ? (group.status?.allocation || group.status?.eom_cleanup)
        : (transaction?.allocation || transaction?.eom_cleanup_id != null);
    const canEdit = roles.editor && !isManaged;
    const isChanged = (note ?? null) !== (entity?.note ?? null);

    const {
        mutate: patchGroupMutate,
        isPending: patchGroupIsPending
    } = usePatchTransactionGroupMutation();
    const {
        mutate: patchTransactionMutate,
        isPending: patchTransactionIsPending
    } = usePatchTransactionMutation();

    const handleSubmit = useCallback(() => {
        const mutate = group ? patchGroupMutate : patchTransactionMutate;
        mutate(
            { formData: { id: entity.id, note: note?.trim() ? note : null } },
            {
                onSuccess: () => setIsOpen(false),
                onError: (err) => setSubmitError({
                    message: err.message,
                    details: err.details?.message
                })
            }
        );
    }, [group, entity, note, patchGroupMutate, patchTransactionMutate, setIsOpen]);

    return (
        <CardModal
            title={`Note: ${entity?.description ?? ''}`}
            isOpen={isOpen}
            setIsOpen={setIsOpen}
        >
            <CardSection>
                <LabeledTextArea
                    label={group ? "Transaction group note" : "Transaction note"}
                    value={note}
                    isFrozen={!isEditing}
                    isChanged={isChanged}
                    minHeight="6rem"
                    collapseWhenFrozen={false}
                    nullPlaceholder="(none)"
                    onChange={(value) => { setNote(value); setSubmitError(null); }}
                    allowNull={true}
                />
            </CardSection>

            <CardActionFooter>
                { !isEditing
                    ? <IconButton
                        text="Edit"
                        icon="fa-pen-to-square"
                        ariaLabel="Edit note"
                        disabled={!canEdit}
                        title={ !canEdit ? "This note cannot be edited" : undefined }
                        onClick={() => setIsEditing(true)}
                    />
                    : <SpinnerButton
                        isPending={patchGroupIsPending || patchTransactionIsPending}
                        disabled={!isChanged || submitError != null}
                        text="Save Note"
                        ariaLabel="Save note"
                        onClick={handleSubmit}
                    />
                }
            </CardActionFooter>

            { submitError &&
                <CardErrorSection errorMessage={submitError.message} errorMessageDetails={submitError.details} />
            }
        </CardModal>
    );
}


// ---------------------------------------------------------------------------
// Bank statements
// ---------------------------------------------------------------------------

/**
 * Generic CSV → JSON importer (ported from the template): file input, one
 * column-mapping selector per CSV header (auto-matched where possible), and
 * a Process button that emits the mapped rows via onProcessedData.
 *
 * `transformers` entries: { key, displayName?, renderer?, autoMatch?,
 * autoMatcher? }. `requiredKeys` lists the keys that must be mapped before
 * processing is allowed.
 */
function CSVImporter({ onProcessedData, transformers = [], requiredKeys = [], file: extFile, setFile: setExtFile }) {

    const {
        optionKeys,
        optionDisplayNames,
        rendererByKey,
        autoMatchersByKey
    } = useMemo(() => {
        return {
            optionKeys: transformers.map(t => t.key),
            optionDisplayNames: transformers.map(t => t.displayName || t.key),
            rendererByKey: transformers.reduce((agg,cur) => { agg[cur.key] = cur.renderer; return agg }, {}),
            autoMatchersByKey: transformers.reduce((agg,cur) => {
                if ( !cur.autoMatch ) return agg;
                if ( cur.autoMatcher ) {
                    agg[cur.key] = cur.autoMatcher;
                } else {
                    agg[cur.key] = (header) => {
                        const lowered = header.toLowerCase().replace(/[_-\s]/g, '');
                        const loweredKey = cur.key.toLowerCase().replace(/[_-\s]/g, '');
                        return lowered === loweredKey || lowered.includes(loweredKey) || loweredKey.includes(lowered);
                    }
                }
                return agg
            }, {})
        };
    }, [transformers])

    const [ intFile, setIntFile ] = useState(null); // HACK : save a reference to the file, purely so that we can clear it later
    const file = extFile || intFile;
    const setFile = setExtFile || setIntFile;
    const [ csvParserError, setCSVParserError ] = useState(null);
    const [ parsedCSVData, setParsedCSVData ] = useState(null);
    const [ csvToJsonMap, setCSVToJsonMap ] = useState(null);

    const parseCSV = useCallback((file) => {
        onProcessedData(null); // Clear previous processed data
        setFile(file); // HACK : Set the file first, so it is always up to date

        if ( !file ) {
            setCSVParserError(null);
            setParsedCSVData(null);
            setCSVToJsonMap(null);
            return;
        }
        const reader = new FileReader();
        reader.readAsText(file, `UTF-8`);
        reader.onload = function({ target }) {
            const text = target.result.trim();
            const lines = text.split(/\r\n|\n/);
            const headers = lines[0].split(',').map(h => h.trim());
            const data = [];

            // Helper function to clean Excel string-forcing characters
            const cleanExcelStringValue = (value) => {
                if (typeof value === 'string' && value.startsWith('="') && value.endsWith('"')) {
                    // Strip the Excel string-forcing wrapper: ="value" -> value
                    return value.slice(2, -1);
                }
                return value;
            };

            for ( let i = 1; i < lines.length; i++ ) {
                const values = lines[i].split(',');
                if ( values.length !== headers.length ) {
                    setCSVParserError({ message: `CSV parsing error on line ${i + 1}: Expected ${headers.length} values, but got ${values.length}. Do your strings have commas in them?` });
                    console.error("Error parsing CSV: ", { line_number: i + 1, expected: headers.length, got: values.length, line: lines[i], parsed_values: values });
                    return;
                }
                const row = {};
                for ( let j = 0; j < headers.length; j++ ) {
                    row[headers[j]] = cleanExcelStringValue(values[j]);
                }
                data.push(row);
            }
            setParsedCSVData({ headers, rows: data });
            setCSVToJsonMap(headers.map((h,i) => {
                if ( !h.trim() ) return null;
                let key = null;
                // Auto-match
                for ( const [ matcherKey, matcherFunc ] of Object.entries( autoMatchersByKey ) ) {
                    if ( matcherFunc(h) ) {
                        key = matcherKey;
                        break;
                    }
                }
                return {
                    index: i,
                    displayName: h,
                    key
                };
            }).filter(h => h != null));
            setCSVParserError(null);
        }
        reader.onerror = function({ target }) {
            setCSVParserError({ message: 'Error reading CSV file.', details: target.error?.message });
            setParsedCSVData(null);
            setCSVToJsonMap(null);
        }
    }, [ autoMatchersByKey, onProcessedData, setFile ]);

    const readyToRender = !!parsedCSVData && !!csvToJsonMap
        && requiredKeys.every(rk => csvToJsonMap.some(m => m.key === rk));

    const renderJSON = useCallback(() => {
        if ( !readyToRender ) return;

        const mappedData = parsedCSVData.rows.map(row => {
            const mappedRow = {};
            for ( const mapping of csvToJsonMap ) {
                if ( mapping.key != null ) {
                    mappedRow[mapping.key] = rendererByKey[mapping.key] ? rendererByKey[mapping.key](row[mapping.displayName]) : row[mapping.displayName];
                }
            }
            return mappedRow;
        });

        if ( onProcessedData ) onProcessedData(mappedData);
    }, [ readyToRender, onProcessedData, parsedCSVData, csvToJsonMap, rendererByKey ]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <LabeledSingleFileInput
                value={file}
                label="CSV File"
                accept=".csv,text/csv"
                onChange={parseCSV}
                isFrozen={false}
            />
            { csvToJsonMap &&
                csvToJsonMap.map(({ index, displayName, key }, i) => (
                    <LabeledSelector
                        key={index}
                        label={`Column: ${displayName} mapping`}
                        value={key}
                        onChange={(value) => {
                            setCSVToJsonMap(prev => {
                                const newMap = [ ...prev ];
                                newMap[i].key = value;
                                return newMap;
                            });
                        }}
                        optionKeys={optionKeys}
                        optionDisplayNames={optionDisplayNames}
                        isFrozen={false}
                        allowNull={true}
                    />
                ))
            }
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <IconButton
                    text="Process CSV"
                    buttonClassName={styles.processCSVButton}
                    icon="fa-bolt"
                    ariaLabel="Process CSV"
                    onClick={renderJSON}
                    disabled={!readyToRender}
                />
            </div>

            { csvParserError && <CardErrorSection errorMessage={csvParserError.message} errorMessageDetails={csvParserError.details} /> }
        </div>
    );
}

function renderCSVDate(value) {
    const raw = String(value ?? '').trim();
    if ( /^\d{4}-\d{2}-\d{2}$/.test(raw) ) return raw;
    // Common US bank export format: M/D/YYYY
    const mdY = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if ( mdY ) return `${mdY[3]}-${mdY[1].padStart(2, '0')}-${mdY[2].padStart(2, '0')}`;
    return raw; // Anything else gets flagged by the client-side row check below
}

function renderCSVAmount(value) {
    let raw = String(value ?? '').trim();
    let negative = false;
    // Accounting-style negatives: (12.34)
    if ( /^\(.*\)$/.test(raw) ) {
        negative = true;
        raw = raw.slice(1, -1);
    }
    raw = raw.replace(/[$\s]/g, '');
    const num = parseFloat(raw);
    if ( isNaN(num) ) return null;
    return negative ? -num : num;
}

const CSVStatementTransformers = [
    {
        key: 'key',
        displayName: 'Unique key (dedupe id)',
        autoMatch: true,
        autoMatcher: (header) => /\b(key|id|ref|reference|fitid|number)\b/i.test(header),
        renderer: (value) => String(value ?? '').trim()
    },
    {
        key: 'date',
        displayName: 'Date',
        autoMatch: true,
        renderer: renderCSVDate
    },
    {
        key: 'amount',
        displayName: 'Amount (signed)',
        autoMatch: true,
        renderer: renderCSVAmount
    },
    {
        key: 'note',
        displayName: 'Note',
        autoMatch: true,
        autoMatcher: (header) => /(note|desc|memo|payee|name|detail)/i.test(header),
        renderer: (value) => {
            const trimmed = String(value ?? '').trim();
            return trimmed || null;
        }
    },
];

function statementImportRowProblem(row) {
    if ( !row.key ) return 'missing key';
    if ( !/^\d{4}-\d{2}-\d{2}$/.test(row.date ?? '') ) return 'unparseable date';
    if ( row.amount == null ) return 'unparseable amount';
    return null;
}

export function ImportStatementsCSVModal({ isOpen, setIsOpen, initialSource = null }) {

    const [ source, setSource ] = useState(initialSource);
    const [ file, setFile ] = useState(null);
    const [ processedData, setProcessedData ] = useState(null);
    const [ importResult, setImportResult ] = useState(null);
    const [ submitError, setSubmitError ] = useState(null);

    const reset = useCallback(() => {
        setSource(initialSource);
        setFile(null);
        setProcessedData(null);
        setImportResult(null);
        setSubmitError(null);
    }, [initialSource]);

    useEffect(() => {
        if (isOpen) reset();
    }, [isOpen, reset]);

    const onProcessedData = useCallback((data) => {
        setProcessedData(data);
        setImportResult(null);
        setSubmitError(null);
    }, []);

    const badRows = (processedData ?? [])
        .map((row, i) => ({ index: i, problem: statementImportRowProblem(row) }))
        .filter(r => r.problem != null);

    const {
        mutate: importMutate,
        isPending: importIsPending
    } = usePostImportStatementsMutation();

    const handleSubmit = useCallback(() => {
        importMutate(
            {
                formData: {
                    items: processedData.map(row => ({
                        source: source.trim(),
                        key: row.key,
                        date: row.date,
                        amount: row.amount,
                        note: row.note ?? null
                    }))
                }
            },
            {
                onSuccess: (result) => setImportResult(result.data),
                onError: (err) => setSubmitError({
                    message: err.message,
                    details: err.details?.message
                })
            }
        );
    }, [processedData, source, importMutate]);

    return (
        <CardModal
            title="Import Bank Statement Items"
            isOpen={isOpen}
            setIsOpen={setIsOpen}
            cardClassName={styles.wideModalCard}
        >
            <CardSection title="Source">
                <p className={styles.modalHint}>
                    Imports are idempotent per (source, key): re-importing an
                    overlapping export never duplicates or updates existing items.
                    Use one consistent source name per bank account.
                </p>
                <LabeledTextInput
                    label="Source"
                    value={source}
                    isRequired={true}
                    isFrozen={false}
                    nullPlaceholder="e.g. checking"
                    onChange={(value) => { setSource(value); setSubmitError(null); }}
                    validityMessage={!source?.trim() ? 'Source is required.' : null}
                />
            </CardSection>

            <CardSection title="CSV">
                <CSVImporter
                    onProcessedData={onProcessedData}
                    transformers={CSVStatementTransformers}
                    requiredKeys={[ 'key', 'date', 'amount' ]}
                    file={file}
                    setFile={setFile}
                />
            </CardSection>

            { processedData &&
                <CardSection title="Preview">
                    <p>
                        {processedData.length} row{processedData.length === 1 ? '' : 's'} ready to import.
                    </p>
                    { badRows.length > 0 &&
                        <p className={styles.modalWarning}>
                            {badRows.length} row{badRows.length === 1 ? '' : 's'} cannot be imported
                            (first problem: line {badRows[0].index + 2}, {badRows[0].problem}).
                            Check the column mappings.
                        </p>
                    }
                </CardSection>
            }

            { importResult &&
                <CardSection title="Result">
                    <p className={styles.importSuccess}>
                        <FontAwesomeIcon icon="fa-solid fa-circle-check" style={{ marginRight: '0.5rem' }} />
                        Imported {importResult.created?.length ?? 0} new item{(importResult.created?.length ?? 0) === 1 ? '' : 's'};
                        skipped {importResult.skipped ?? 0} already-known item{(importResult.skipped ?? 0) === 1 ? '' : 's'}.
                    </p>
                </CardSection>
            }

            <CardActionFooter>
                <SpinnerButton
                    isPending={importIsPending}
                    disabled={
                        !source?.trim()
                        || !processedData?.length
                        || badRows.length > 0
                        || importResult != null
                        || submitError != null
                    }
                    text="Import"
                    ariaLabel="Import statement items"
                    onClick={handleSubmit}
                />
            </CardActionFooter>

            { submitError &&
                <CardErrorSection errorMessage={submitError.message} errorMessageDetails={submitError.details} />
            }
        </CardModal>
    );
}

export function EditStatementModal({ isOpen, setIsOpen, statement }) {

    const initialData = useCallback(() => ({
        ignored: statement?.ignored ?? false,
        note: statement?.note ?? null
    }), [statement]);

    const [ data, setData ] = useState(initialData);
    const [ submitError, setSubmitError ] = useState(null);

    const reset = useCallback(() => {
        setData(initialData());
        setSubmitError(null);
    }, [initialData]);

    useEffect(() => {
        if (isOpen) reset();
    }, [isOpen, reset]);

    const handleChange = (field, value) => {
        setData(prevData => ({ ...prevData, [field]: value }));
        setSubmitError(null);
    };

    const patch = changedFields(initialData(), data, [ 'ignored', 'note' ]);
    const isReconciled = statement?.group_id != null;

    const {
        mutate: patchMutate,
        isPending: patchIsPending
    } = usePatchStatementMutation();

    const handleSubmit = useCallback(() => {
        patchMutate(
            { formData: { id: statement.id, ...patch } },
            {
                onSuccess: () => setIsOpen(false),
                onError: (err) => setSubmitError({
                    message: err.message,
                    details: err.details?.message
                })
            }
        );
    }, [statement, patch, patchMutate, setIsOpen]);  

    return (
        <CardModal
            title="Edit Bank Statement Item"
            isOpen={isOpen}
            setIsOpen={setIsOpen}
        >
            <CardSection title="Bank Facts (immutable)">
                <CardAutoGrid>
                    <LabeledTextInput label="Source" value={statement?.source} isFrozen={true} />
                    <LabeledTextInput label="Key" value={statement?.key} isFrozen={true} />
                    <LabeledTextInput label="Date" value={statement?.date} isFrozen={true} />
                    <LabeledNumberInput label="Amount ($)" value={statement?.amount} isFrozen={true} render={() => formatMoney(statement?.amount)} />
                </CardAutoGrid>
            </CardSection>

            <CardSection title="Editable">
                <CardAutoGrid>
                    <LabeledBooleanInput
                        label="Ignored?"
                        value={data.ignored}
                        isFrozen={isReconciled}
                        isChanged={'ignored' in patch}
                        onChange={(value) => handleChange('ignored', value)}
                        inputTitle={isReconciled ? 'A reconciled item cannot be ignored' : 'Ignored items are hidden from the pending list without being deleted'}
                    />
                    <LabeledTextArea
                        label="Note"
                        value={data.note}
                        isFrozen={false}
                        isChanged={'note' in patch}
                        minHeight="4rem"
                        nullPlaceholder="(none)"
                        onChange={(value) => handleChange('note', value)}
                        allowNull={true}
                    />
                </CardAutoGrid>
            </CardSection>

            <CardActionFooter>
                <SpinnerButton
                    isPending={patchIsPending}
                    disabled={Object.keys(patch).length === 0 || submitError != null}
                    text="Save Changes"
                    ariaLabel="Save statement item changes"
                    onClick={handleSubmit}
                />
            </CardActionFooter>

            { submitError &&
                <CardErrorSection errorMessage={submitError.message} errorMessageDetails={submitError.details} />
            }
        </CardModal>
    );
}

export function DeleteStatementModal({ isOpen, setIsOpen, statement, closePopoutCallback }) {

    const [ withGroup, setWithGroup ] = useState(true);

    useEffect(() => {
        if (isOpen) setWithGroup(true);
    }, [isOpen]);

    const {
        mutateAsync: deleteMutate // NOTE, mutateAsync to return a promise, which throws on error -> handled by ConfirmationModal
    } = useDeleteStatementMutation();

    const deleteOnConfirm = useCallback(async () => {
        return deleteMutate(
            { formData: { id: statement.id, with_group: withGroup } },
            {
                onSuccess: () => {
                    if (closePopoutCallback) closePopoutCallback();
                }
            }
        );
    }, [ deleteMutate, closePopoutCallback, statement, withGroup ]);

    const isReconciled = statement?.group_id != null;

    return (
        <ConfirmationModal
            isOpen={isOpen}
            setIsOpen={setIsOpen}
            title="Delete Bank Statement Item"
            content={<>
                <div style={{ width: '30rem', textAlign: 'center' }}>
                    Are you sure you want to delete the item <strong>{statement?.key ?? 'unknown'}</strong> from <strong>{statement?.source ?? 'unknown'}</strong> ({statement?.date ?? 'unknown'}, {formatMoney(statement?.amount)})?
                </div>
                <div style={{ width: '30rem', textAlign: 'center', marginTop: '1rem' }} className={styles.modalWarning}>
                    Deletion is for undoing bad imports, NOT for hiding items (use
                    ignored for that): the item reappears as pending on the next
                    re-sync, and reconciling it again double-counts.
                </div>
                { isReconciled &&
                    <div style={{ width: '30rem', marginTop: '1rem' }}>
                        <LabeledBooleanInput
                            label="Also delete the reconciling transaction group?"
                            value={withGroup}
                            isFrozen={false}
                            onChange={setWithGroup}
                            inputTitle="If not, the group and its transactions survive with the reconciliation link removed"
                        />
                    </div>
                }
            </>}
            confirmText="Delete Statement Item"
            confirmButtonClassName={styles.dangerConfirmButton}
            onConfirm={deleteOnConfirm}
        />
    );
}

export function ReconcileStatementsModal({ isOpen, setIsOpen, statements = [] }) {

    const defaultData = () => ({
        date: null, // null -> server default: the latest item date
        description: null, // null -> server default: the items' notes (fallback: keys)
        note: null
    });

    const [ data, setData ] = useState(defaultData);
    const [ lines, setLines ] = useState(() => [ newTransactionLine() ]);
    const [ submitError, setSubmitError ] = useState(null);

    const reset = useCallback(() => {
        setData(defaultData());
        setLines([ newTransactionLine() ]);
        setSubmitError(null);
    }, []);

    useEffect(() => {
        if (isOpen) reset();
    }, [isOpen, reset]);

    const handleChange = (field, value) => {
        setData(prevData => ({ ...prevData, [field]: value }));
        setSubmitError(null);
    };

    const linesHaveProblems = lines.length < 1 || lines.some(transactionLineHasProblem);

    const {
        mutate: postMutate,
        isPending: postIsPending
    } = usePostTransactionGroupFromStatementsMutation();

    const handleSubmit = useCallback(() => {
        postMutate(
            {
                formData: {
                    statement_ids: statements.map(s => s.id),
                    ...(data.date ? { date: data.date } : {}),
                    ...(data.description ? { description: data.description } : {}),
                    ...(data.note ? { note: data.note } : {}),
                    transactions: lines.map(transactionLineToSpec)
                }
            },
            {
                onSuccess: () => setIsOpen(false),
                onError: (err) => setSubmitError({
                    message: err.message,
                    details: err.details?.message
                })
            }
        );
    }, [statements, data, lines, postMutate, setIsOpen]);

    return (
        <CardModal
            title="Reconcile Bank Statement Items"
            isOpen={isOpen}
            setIsOpen={setIsOpen}
            cardClassName={styles.wideModalCard}
        >
            <CardSection title={`Item${statements.length === 1 ? '' : 's'} to reconcile`}>
                <p className={styles.modalHint}>
                    One pending item normally; both sides' items for a transfer
                    between two imported accounts.
                </p>
                <div className={styles.statementItemsList}>
                    { statements.map(s => (
                        <div key={s.id} className={styles.statementItem}>
                            <strong>{s.source}</strong>
                            <span>{s.date}</span>
                            <span>{formatMoney(s.amount)}</span>
                            <span className={styles.statementItemNote}>{s.note ?? s.key}</span>
                        </div>
                    ))}
                </div>
            </CardSection>

            <CardSection title="Group Details">
                <CardAutoGrid>
                    <LabeledDateInput
                        label="Date"
                        value={data.date}
                        isFrozen={false}
                        nullPlaceholder="(default: latest item date)"
                        onChange={(value) => handleChange('date', value || null)}
                        allowNull={true}
                    />
                    <LabeledTextInput
                        label="Description"
                        value={data.description}
                        isFrozen={false}
                        nullPlaceholder="(default: item notes)"
                        onChange={(value) => handleChange('description', value || null)}
                        allowNull={true}
                    />
                    <LabeledTextArea
                        label="Note"
                        value={data.note}
                        isFrozen={false}
                        minHeight="4rem"
                        nullPlaceholder="(none)"
                        onChange={(value) => handleChange('note', value)}
                        allowNull={true}
                    />
                </CardAutoGrid>
            </CardSection>

            <CardSection title="Transactions">
                <TransactionLinesEditor lines={lines} setLines={setLines} />
            </CardSection>

            <CardActionFooter>
                <SpinnerButton
                    isPending={postIsPending}
                    disabled={
                        statements.length < 1
                        || linesHaveProblems
                        || submitError != null
                    }
                    text="Reconcile"
                    ariaLabel="Reconcile statement items"
                    onClick={handleSubmit}
                />
            </CardActionFooter>

            { submitError &&
                <CardErrorSection errorMessage={submitError.message} errorMessageDetails={submitError.details} />
            }
        </CardModal>
    );
}


// ---------------------------------------------------------------------------
// Allocations
// ---------------------------------------------------------------------------

export function SetAllocationModal({ isOpen, setIsOpen, initialMonth = null, initialFundId = null, initialFund = null, initialAmount = null, monthFrozen = false, fundFrozen = false }) {

    const defaultData = () => ({
        month: initialMonth,
        fund_id: initialFundId,
        amount: initialAmount
    });

    const [ data, setData ] = useState(defaultData);
    const [ submitError, setSubmitError ] = useState(null);

    const reset = useCallback(() => {
        setData(defaultData());
        setSubmitError(null);
    }, [initialMonth, initialFundId, initialAmount]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (isOpen) reset();
    }, [isOpen, reset]);

    const handleChange = (field, value) => {
        setData(prevData => ({ ...prevData, [field]: value }));
        setSubmitError(null);
    };

    const dataValidity = {
        month: !data.month ? 'Month is required.' : null,
        fund_id: !data.fund_id ? 'Fund is required.' : null,
        amount: (data.amount == null || data.amount <= 0) ? 'Amount must be positive (remove the allocation instead of zeroing it).' : null,
    };

    const {
        mutate: putMutate,
        isPending: putIsPending
    } = usePutAllocationMutation();

    const handleSubmit = useCallback(() => {
        putMutate(
            { formData: { ...data } },
            {
                onSuccess: () => setIsOpen(false),
                onError: (err) => setSubmitError({
                    message: err.message,
                    details: err.details?.message
                })
            }
        );
    }, [data, putMutate, setIsOpen]);

    return (
        <CardModal
            title="Set Allocation"
            isOpen={isOpen}
            setIsOpen={setIsOpen}
        >
            <CardSection title="Details">
                <p className={styles.modalHint}>
                    Sets (create-or-replace) the fund's allocation for the month:
                    a transfer from its nearest pool ancestor, dated the first of
                    the month.
                </p>
                <CardAutoGrid>
                    <LabeledMonthInput
                        value={data.month}
                        isRequired={true}
                        isFrozen={monthFrozen}
                        onChange={(value) => handleChange('month', value)}
                        validityMessage={dataValidity.month}
                    />
                    <FundSearchableSelector
                        label="Fund"
                        value={data.fund_id}
                        originalFund={initialFund}
                        tracked={true}
                        onChange={(value) => handleChange('fund_id', value)}
                        isFrozen={fundFrozen}
                        isRequired={true}
                        allowNull={false}
                        validityMessage={dataValidity.fund_id}
                    />
                    <LabeledNumberInput
                        label="Amount ($)"
                        value={data.amount}
                        isRequired={true}
                        isFrozen={false}
                        min={0.01}
                        step={0.01}
                        nullPlaceholder="Enter amount"
                        onChange={(value) => handleChange('amount', value)}
                        allowNull={false}
                        validityMessage={dataValidity.amount}
                    />
                </CardAutoGrid>
            </CardSection>

            <CardActionFooter>
                <SpinnerButton
                    isPending={putIsPending}
                    disabled={Object.values(dataValidity).some(v => v != null) || submitError != null}
                    text="Set Allocation"
                    ariaLabel="Set allocation"
                    onClick={handleSubmit}
                />
            </CardActionFooter>

            { submitError &&
                <CardErrorSection errorMessage={submitError.message} errorMessageDetails={submitError.details} />
            }
        </CardModal>
    );
}

export function DeleteAllocationModal({ isOpen, setIsOpen, month, fund }) {

    const {
        mutateAsync: deleteMutate // NOTE, mutateAsync to return a promise, which throws on error -> handled by ConfirmationModal
    } = useDeleteAllocationMutation();

    const deleteOnConfirm = useCallback(async () => {
        return deleteMutate({ formData: { month, fund_id: fund.id } });
    }, [ deleteMutate, month, fund ]);

    return (
        <ConfirmationModal
            isOpen={isOpen}
            setIsOpen={setIsOpen}
            title="Remove Allocation"
            content={<>
                <div style={{ width: '30rem', textAlign: 'center' }}>
                    Are you sure you want to remove the <strong>{monthLabel(month)}</strong> allocation
                    for <strong>{fund?.name ?? 'unknown'}</strong>?
                </div>
            </>}
            confirmText="Remove Allocation"
            confirmButtonClassName={styles.dangerConfirmButton}
            onConfirm={deleteOnConfirm}
        />
    );
}

export function CopyAllocationsModal({ isOpen, setIsOpen, initialFrom = null, initialTo = null }) {

    const defaultData = () => ({
        from: initialFrom,
        to: initialTo,
        on_conflict: 'error'
    });

    const [ data, setData ] = useState(defaultData);
    const [ submitError, setSubmitError ] = useState(null);

    const reset = useCallback(() => {
        setData(defaultData());
        setSubmitError(null);
    }, [initialFrom, initialTo]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (isOpen) reset();
    }, [isOpen, reset]);

    const handleChange = (field, value) => {
        setData(prevData => ({ ...prevData, [field]: value }));
        setSubmitError(null);
    };

    const dataValidity = {
        from: !data.from ? 'Source month is required.' : null,
        to: !data.to
            ? 'Target month is required.'
            : (data.from && monthLabel(data.from) === monthLabel(data.to) ? 'Source and target months must differ.' : null),
    };

    const {
        mutate: postMutate,
        isPending: postIsPending
    } = usePostCopyAllocationsMutation();

    const handleSubmit = useCallback(() => {
        postMutate(
            { formData: { ...data } },
            {
                onSuccess: () => setIsOpen(false),
                onError: (err) => setSubmitError({
                    message: err.message,
                    details: err.details?.message
                })
            }
        );
    }, [data, postMutate, setIsOpen]);

    return (
        <CardModal
            title="Copy Allocations"
            isOpen={isOpen}
            setIsOpen={setIsOpen}
        >
            <CardSection title="Details">
                <p className={styles.modalHint}>
                    Copies every allocation from one month into another, atomically
                    — the "same budget as last month" workflow.
                </p>
                <CardAutoGrid>
                    <LabeledMonthInput
                        label="Copy From"
                        value={data.from}
                        isRequired={true}
                        isFrozen={false}
                        onChange={(value) => handleChange('from', value)}
                        validityMessage={dataValidity.from}
                    />
                    <LabeledMonthInput
                        label="Copy To"
                        value={data.to}
                        isRequired={true}
                        isFrozen={false}
                        onChange={(value) => handleChange('to', value)}
                        validityMessage={dataValidity.to}
                    />
                    <LabeledSelector
                        label="If a fund is already allocated in the target"
                        value={data.on_conflict}
                        optionKeys={[ 'error', 'merge', 'overwrite' ]}
                        optionDisplayNames={[
                            'Error (copy nothing)',
                            'Merge (keep the target\'s existing amounts)',
                            'Overwrite (replace with the source\'s amounts)'
                        ]}
                        onChange={(value) => handleChange('on_conflict', value)}
                        isFrozen={false}
                        allowNull={false}
                    />
                </CardAutoGrid>
            </CardSection>

            <CardActionFooter>
                <SpinnerButton
                    isPending={postIsPending}
                    disabled={Object.values(dataValidity).some(v => v != null) || submitError != null}
                    text="Copy Allocations"
                    ariaLabel="Copy allocations"
                    onClick={handleSubmit}
                />
            </CardActionFooter>

            { submitError &&
                <CardErrorSection errorMessage={submitError.message} errorMessageDetails={submitError.details} />
            }
        </CardModal>
    );
}


// ---------------------------------------------------------------------------
// Month finalizations
// ---------------------------------------------------------------------------

export function FinalizeMonthModal({ isOpen, setIsOpen, initialMonth = null }) {

    const defaultData = () => ({
        month: initialMonth,
        recursive: false
    });

    const [ data, setData ] = useState(defaultData);
    const [ submitError, setSubmitError ] = useState(null);

    const reset = useCallback(() => {
        setData(defaultData());
        setSubmitError(null);
    }, [initialMonth]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (isOpen) reset();
    }, [isOpen, reset]);

    const handleChange = (field, value) => {
        setData(prevData => ({ ...prevData, [field]: value }));
        setSubmitError(null);
    };

    const dataValidity = {
        month: !data.month ? 'Month is required.' : null,
    };

    const {
        mutate: postMutate,
        isPending: postIsPending
    } = usePostMonthFinalizationMutation();

    const handleSubmit = useCallback(() => {
        postMutate(
            { formData: { ...data } },
            {
                onSuccess: () => setIsOpen(false),
                onError: (err) => setSubmitError({
                    message: err.message,
                    details: err.details?.message
                })
            }
        );
    }, [data, postMutate, setIsOpen]);

    return (
        <CardModal
            title="Finalize a Month"
            isOpen={isOpen}
            setIsOpen={setIsOpen}
        >
            <CardSection title="Details">
                <p className={styles.modalHint}>
                    Finalizing records every tracked fund's end-of-month balance and
                    returns each monthly fund's remainder to its pool. A finalized
                    month becomes immutable (no new or edited transactions in or
                    before it), but the LATEST finalized month can be unfinalized.
                    Months finalize contiguously, oldest first — enable recursive to
                    auto-finalize the months in between.
                </p>
                <CardAutoGrid>
                    <LabeledMonthInput
                        value={data.month}
                        isRequired={true}
                        isFrozen={false}
                        onChange={(value) => handleChange('month', value)}
                        validityMessage={dataValidity.month}
                    />
                    <LabeledBooleanInput
                        label="Recursively finalize intervening months?"
                        value={data.recursive}
                        isFrozen={false}
                        onChange={(value) => handleChange('recursive', value)}
                    />
                </CardAutoGrid>
            </CardSection>

            <CardActionFooter>
                <SpinnerButton
                    isPending={postIsPending}
                    disabled={Object.values(dataValidity).some(v => v != null) || submitError != null}
                    text="Finalize Month"
                    ariaLabel="Finalize month"
                    onClick={handleSubmit}
                />
            </CardActionFooter>

            { submitError &&
                <CardErrorSection errorMessage={submitError.message} errorMessageDetails={submitError.details} />
            }
        </CardModal>
    );
}

export function UnfinalizeMonthModal({ isOpen, setIsOpen, monthFinalization }) {

    const {
        mutateAsync: deleteMutate // NOTE, mutateAsync to return a promise, which throws on error -> handled by ConfirmationModal
    } = useDeleteMonthFinalizationMutation();

    const deleteOnConfirm = useCallback(async () => {
        return deleteMutate({ formData: { id: monthFinalization.id } });
    }, [ deleteMutate, monthFinalization ]);

    return (
        <ConfirmationModal
            isOpen={isOpen}
            setIsOpen={setIsOpen}
            title="Unfinalize Month"
            content={<>
                <div style={{ width: '30rem', textAlign: 'center' }}>
                    Are you sure you want to unfinalize <strong>{monthLabel(monthFinalization?.som_date)}</strong>?
                </div>
                <div style={{ width: '30rem', textAlign: 'center', marginTop: '1rem' }}>
                    This removes the month's end-of-month cleanup transactions and
                    re-opens it (and everything after it) for editing. Only the
                    LATEST finalized month can be unfinalized.
                </div>
            </>}
            confirmText="Unfinalize Month"
            confirmButtonClassName={styles.dangerConfirmButton}
            onConfirm={deleteOnConfirm}
        />
    );
}


// ---------------------------------------------------------------------------
// Users, sessions & API keys
// ---------------------------------------------------------------------------

export function CreateUserModal({ isOpen, setIsOpen }) {

    const defaultData = () => ({
        email: null,
        password: null,
        admin: false,
        reader: true,
        editor: false
    });

    const [ data, setData ] = useState(defaultData);
    const [ submitError, setSubmitError ] = useState(null);

    const reset = useCallback(() => {
        setData(defaultData());
        setSubmitError(null);
    }, []);

    useEffect(() => {
        if (isOpen) reset();
    }, [isOpen, reset]);

    const handleChange = (field, value) => {
        setData(prevData => ({ ...prevData, [field]: value }));
        setSubmitError(null);
    };

    const dataValidity = {
        email: !data.email?.includes('@') ? 'A valid email is required.' : null,
        password: (data.password?.length ?? 0) < 8 ? 'Password must be at least 8 characters.' : null,
    };

    const {
        mutate: postMutate,
        isPending: postIsPending
    } = usePostUserMutation();

    const handleSubmit = useCallback(() => {
        postMutate(
            { formData: { ...data } },
            {
                onSuccess: () => setIsOpen(false),
                onError: (err) => setSubmitError({
                    message: err.message,
                    details: err.details?.message
                })
            }
        );
    }, [data, postMutate, setIsOpen]);

    return (
        <CardModal
            title="Create a new User"
            isOpen={isOpen}
            setIsOpen={setIsOpen}
        >
            <CardSection title="Details">
                <CardAutoGrid>
                    <LabeledTextInput
                        label="Email"
                        type="email"
                        value={data.email}
                        isRequired={true}
                        isFrozen={false}
                        nullPlaceholder="Enter email"
                        onChange={(value) => handleChange('email', value)}
                        validityMessage={dataValidity.email}
                    />
                    <LabeledTextInput
                        label="Password"
                        type="password"
                        value={data.password}
                        isRequired={true}
                        isFrozen={false}
                        nullPlaceholder="Min 8 characters"
                        onChange={(value) => handleChange('password', value)}
                        validityMessage={dataValidity.password}
                    />
                    <LabeledBooleanInput
                        label="Reader?"
                        value={data.reader}
                        isFrozen={false}
                        onChange={(value) => handleChange('reader', value)}
                    />
                    <LabeledBooleanInput
                        label="Editor?"
                        value={data.editor}
                        isFrozen={false}
                        onChange={(value) => handleChange('editor', value)}
                    />
                    <LabeledBooleanInput
                        label="Admin?"
                        value={data.admin}
                        isFrozen={false}
                        onChange={(value) => handleChange('admin', value)}
                        inputTitle="Admin implies every other role"
                    />
                </CardAutoGrid>
            </CardSection>

            <CardActionFooter>
                <SpinnerButton
                    isPending={postIsPending}
                    disabled={Object.values(dataValidity).some(v => v != null) || submitError != null}
                    text="Create User"
                    ariaLabel="Create user"
                    onClick={handleSubmit}
                />
            </CardActionFooter>

            { submitError &&
                <CardErrorSection errorMessage={submitError.message} errorMessageDetails={submitError.details} />
            }
        </CardModal>
    );
}

export function EditUserModal({ isOpen, setIsOpen, user }) {

    // NOTE: initialized from the user's EXPLICITLY GRANTED flags (admin/
    // reader/editor), not the effective `roles` (where admin implies all)
    const initialData = useCallback(() => ({
        email: user?.email ?? null,
        admin: user?.admin ?? false,
        reader: user?.reader ?? true,
        editor: user?.editor ?? false
    }), [user]);

    const [ data, setData ] = useState(initialData);
    const [ submitError, setSubmitError ] = useState(null);

    const reset = useCallback(() => {
        setData(initialData());
        setSubmitError(null);
    }, [initialData]);

    useEffect(() => {
        if (isOpen) reset();
    }, [isOpen, reset]);

    const handleChange = (field, value) => {
        setData(prevData => ({ ...prevData, [field]: value }));
        setSubmitError(null);
    };

    const patch = changedFields(initialData(), data, [ 'email', 'admin', 'reader', 'editor' ]);

    const dataValidity = {
        email: !data.email?.includes('@') ? 'A valid email is required.' : null,
    };

    const {
        mutate: patchMutate,
        isPending: patchIsPending
    } = usePatchUserMutation();

    const handleSubmit = useCallback(() => {
        patchMutate(
            { formData: { id: user.id, ...patch } },
            {
                onSuccess: () => setIsOpen(false),
                onError: (err) => setSubmitError({
                    message: err.message,
                    details: err.details?.message
                })
            }
        );
    }, [user, patch, patchMutate, setIsOpen]);  

    return (
        <CardModal
            title={`Edit User: ${user?.email ?? ''}`}
            isOpen={isOpen}
            setIsOpen={setIsOpen}
        >
            <CardSection title="Details">
                <p className={styles.modalHint}>
                    Role changes take up to ~20 minutes to reach the user's
                    outstanding access tokens. Passwords change via the separate
                    password modal.
                </p>
                <CardAutoGrid>
                    <LabeledTextInput
                        label="Email"
                        type="email"
                        value={data.email}
                        isRequired={true}
                        isFrozen={false}
                        isChanged={'email' in patch}
                        onChange={(value) => handleChange('email', value)}
                        validityMessage={dataValidity.email}
                    />
                    <LabeledBooleanInput
                        label="Reader?"
                        value={data.reader}
                        isFrozen={false}
                        isChanged={'reader' in patch}
                        onChange={(value) => handleChange('reader', value)}
                    />
                    <LabeledBooleanInput
                        label="Editor?"
                        value={data.editor}
                        isFrozen={false}
                        isChanged={'editor' in patch}
                        onChange={(value) => handleChange('editor', value)}
                    />
                    <LabeledBooleanInput
                        label="Admin?"
                        value={data.admin}
                        isFrozen={false}
                        isChanged={'admin' in patch}
                        onChange={(value) => handleChange('admin', value)}
                        inputTitle="Admin implies every other role"
                    />
                </CardAutoGrid>
            </CardSection>

            <CardActionFooter>
                <SpinnerButton
                    isPending={patchIsPending}
                    disabled={
                        Object.keys(patch).length === 0
                        || Object.values(dataValidity).some(v => v != null)
                        || submitError != null
                    }
                    text="Save Changes"
                    ariaLabel="Save user changes"
                    onClick={handleSubmit}
                />
            </CardActionFooter>

            { submitError &&
                <CardErrorSection errorMessage={submitError.message} errorMessageDetails={submitError.details} />
            }
        </CardModal>
    );
}

export function DeleteUserModal({ isOpen, setIsOpen, user, closePopoutCallback }) {

    const {
        mutateAsync: deleteMutate // NOTE, mutateAsync to return a promise, which throws on error -> handled by ConfirmationModal
    } = useDeleteUserMutation();

    const deleteOnConfirm = useCallback(async () => {
        return deleteMutate(
            { formData: { id: user.id } },
            {
                onSuccess: () => {
                    if (closePopoutCallback) closePopoutCallback();
                }
            }
        );
    }, [ deleteMutate, closePopoutCallback, user ]);

    return (
        <ConfirmationModal
            isOpen={isOpen}
            setIsOpen={setIsOpen}
            title="Delete User"
            content={<>
                <div style={{ width: '30rem', textAlign: 'center' }}>
                    Are you sure you want to delete the user <strong>{user?.email ?? 'unknown'}</strong>?
                </div>
                <div style={{ width: '30rem', textAlign: 'center', marginTop: '1rem' }}>
                    Their sessions and API keys are deleted with them. This action
                    cannot be undone (and the server refuses self-deletion).
                </div>
            </>}
            confirmText="Delete User"
            confirmButtonClassName={styles.dangerConfirmButton}
            onConfirm={deleteOnConfirm}
        />
    );
}

export function ChangePasswordModal({ isOpen, setIsOpen, user }) {

    const auth = useAuth();
    const roles = useAuthRoles();
    const isSelf = auth.userId != null && auth.userId === user?.id;
    // With sudo-mode admin rights the server treats this as an administrative
    // reset (no current password needed); otherwise the target must be
    // yourself and current_password is verified
    const isAdminReset = !!roles.admin;

    const defaultData = () => ({
        current_password: null,
        password: null,
        confirm_password: null,
        revoke_sessions: true
    });

    const [ data, setData ] = useState(defaultData);
    const [ submitError, setSubmitError ] = useState(null);

    const reset = useCallback(() => {
        setData(defaultData());
        setSubmitError(null);
    }, []);

    useEffect(() => {
        if (isOpen) reset();
    }, [isOpen, reset]);

    const handleChange = (field, value) => {
        setData(prevData => ({ ...prevData, [field]: value }));
        setSubmitError(null);
    };

    const dataValidity = {
        current_password: (!isAdminReset && !data.current_password) ? 'Current password is required.' : null,
        password: (data.password?.length ?? 0) < 8 ? 'Password must be at least 8 characters.' : null,
        confirm_password: data.confirm_password !== data.password ? 'Passwords do not match.' : null,
    };

    const {
        mutate: postMutate,
        isPending: postIsPending
    } = usePostUserPasswordMutation();

    const handleSubmit = useCallback(() => {
        postMutate(
            {
                formData: {
                    id: user.id,
                    password: data.password,
                    ...(isAdminReset ? {} : { current_password: data.current_password }),
                    revoke_sessions: data.revoke_sessions
                }
            },
            {
                onSuccess: () => setIsOpen(false),
                onError: (err) => setSubmitError({
                    message: err.message,
                    details: err.details?.message
                })
            }
        );
    }, [user, data, isAdminReset, postMutate, setIsOpen]);

    return (
        <CardModal
            title={`Change Password: ${user?.email ?? ''}`}
            isOpen={isOpen}
            setIsOpen={setIsOpen}
        >
            <CardSection title="Details">
                { (isSelf && data.revoke_sessions) &&
                    <p className={styles.modalWarning}>
                        Revoking sessions logs you out everywhere — including here.
                    </p>
                }
                <p className={styles.modalHint}>
                    API keys deliberately survive password changes: revoke them
                    separately if they may be compromised.
                </p>
                <CardAutoGrid>
                    { !isAdminReset &&
                        <LabeledTextInput
                            label="Current Password"
                            type="password"
                            value={data.current_password}
                            isRequired={true}
                            isFrozen={false}
                            nullPlaceholder="Enter current password"
                            onChange={(value) => handleChange('current_password', value)}
                            validityMessage={dataValidity.current_password}
                        />
                    }
                    <LabeledTextInput
                        label="New Password"
                        type="password"
                        value={data.password}
                        isRequired={true}
                        isFrozen={false}
                        nullPlaceholder="Min 8 characters"
                        onChange={(value) => handleChange('password', value)}
                        validityMessage={dataValidity.password}
                    />
                    <LabeledTextInput
                        label="Confirm New Password"
                        type="password"
                        value={data.confirm_password}
                        isRequired={true}
                        isFrozen={false}
                        nullPlaceholder="Repeat new password"
                        onChange={(value) => handleChange('confirm_password', value)}
                        validityMessage={dataValidity.confirm_password}
                    />
                    <LabeledBooleanInput
                        label="Revoke all sessions?"
                        value={data.revoke_sessions}
                        isFrozen={false}
                        onChange={(value) => handleChange('revoke_sessions', value)}
                        inputTitle="Log the user out of every device (recommended after a compromise)"
                    />
                </CardAutoGrid>
            </CardSection>

            <CardActionFooter>
                <SpinnerButton
                    isPending={postIsPending}
                    disabled={Object.values(dataValidity).some(v => v != null) || submitError != null}
                    text="Change Password"
                    ariaLabel="Change password"
                    onClick={handleSubmit}
                />
            </CardActionFooter>

            { submitError &&
                <CardErrorSection errorMessage={submitError.message} errorMessageDetails={submitError.details} />
            }
        </CardModal>
    );
}

export function DeleteSessionModal({ isOpen, setIsOpen, session }) {

    const {
        mutateAsync: deleteMutate // NOTE, mutateAsync to return a promise, which throws on error -> handled by ConfirmationModal
    } = useDeleteUserSessionMutation();

    const deleteOnConfirm = useCallback(async () => {
        return deleteMutate({ formData: { user_id: session.user_id, session_id: session.id } });
    }, [ deleteMutate, session ]);

    return (
        <ConfirmationModal
            isOpen={isOpen}
            setIsOpen={setIsOpen}
            title="Revoke Session"
            content={<>
                <div style={{ width: '30rem', textAlign: 'center' }}>
                    Are you sure you want to revoke session <strong>#{session?.id ?? '?'}</strong> (last
                    used {session?.last_used_at ? new Date(session.last_used_at).toLocaleString() : 'never'})?
                </div>
                <div style={{ width: '30rem', textAlign: 'center', marginTop: '1rem' }}>
                    That device can no longer refresh, but its current access token
                    stays valid for up to ~20 minutes.
                </div>
            </>}
            confirmText="Revoke Session"
            confirmButtonClassName={styles.dangerConfirmButton}
            onConfirm={deleteOnConfirm}
        />
    );
}

export function CreateApiKeyModal({ isOpen, setIsOpen, userId }) {

    const defaultData = () => ({
        name: null,
        reader: true,
        editor: false,
        ttl_days: null
    });

    const [ data, setData ] = useState(defaultData);
    const [ mintedKey, setMintedKey ] = useState(null);
    const [ submitError, setSubmitError ] = useState(null);
    const { copied, copy } = useCopyToClipboard();

    const reset = useCallback(() => {
        setData(defaultData());
        setMintedKey(null);
        setSubmitError(null);
    }, []);

    useEffect(() => {
        if (isOpen) reset();
    }, [isOpen, reset]);

    const handleChange = (field, value) => {
        setData(prevData => ({ ...prevData, [field]: value }));
        setSubmitError(null);
    };

    const dataValidity = {
        name: !data.name?.trim() ? 'Name is required.' : null,
        ttl_days: (data.ttl_days != null && data.ttl_days <= 0) ? 'Expiry must be a positive number of days (or empty for never).' : null,
    };

    const {
        mutate: postMutate,
        isPending: postIsPending
    } = usePostUserApiKeyMutation();

    const handleSubmit = useCallback(() => {
        postMutate(
            {
                formData: {
                    id: userId,
                    name: data.name,
                    reader: data.reader,
                    editor: data.editor,
                    ...(data.ttl_days != null ? { ttl_days: data.ttl_days } : {})
                }
            },
            {
                onSuccess: (result) => setMintedKey(result.data),
                onError: (err) => setSubmitError({
                    message: err.message,
                    details: err.details?.message
                })
            }
        );
    }, [userId, data, postMutate]);

    return (
        <CardModal
            title="Mint a new API Key"
            isOpen={isOpen}
            setIsOpen={setIsOpen}
        >
            { !mintedKey && <>
                <CardSection title="Details">
                    <p className={styles.modalHint}>
                        The key's reader/editor flags cap what its tokens may do
                        (always intersected with the owner's roles; admin is never
                        minted from an API key).
                    </p>
                    <CardAutoGrid>
                        <LabeledTextInput
                            label="Name"
                            value={data.name}
                            isRequired={true}
                            isFrozen={false}
                            nullPlaceholder="e.g. statement importer"
                            onChange={(value) => handleChange('name', value)}
                            validityMessage={dataValidity.name}
                        />
                        <LabeledBooleanInput
                            label="Reader?"
                            value={data.reader}
                            isFrozen={false}
                            onChange={(value) => handleChange('reader', value)}
                        />
                        <LabeledBooleanInput
                            label="Editor?"
                            value={data.editor}
                            isFrozen={false}
                            onChange={(value) => handleChange('editor', value)}
                        />
                        <LabeledNumberInput
                            label="Expires in (days)"
                            value={data.ttl_days}
                            isFrozen={false}
                            min={1}
                            step={1}
                            nullPlaceholder="(never expires)"
                            onChange={(value) => handleChange('ttl_days', value)}
                            allowNull={true}
                            validityMessage={dataValidity.ttl_days}
                        />
                    </CardAutoGrid>
                </CardSection>

                <CardActionFooter>
                    <SpinnerButton
                        isPending={postIsPending}
                        disabled={Object.values(dataValidity).some(v => v != null) || submitError != null}
                        text="Mint API Key"
                        ariaLabel="Mint API key"
                        onClick={handleSubmit}
                    />
                </CardActionFooter>
            </>}

            { mintedKey && <>
                <CardSection title="Your new API key">
                    <p className={styles.modalWarning}>
                        This secret is shown ONCE and never again — store it now.
                    </p>
                    <div className={styles.secretContainer}>
                        <code className={styles.secretValue}>{mintedKey.api_key}</code>
                        <TightIconButton
                            icon="fa-copy"
                            ariaLabel="Copy API key"
                            title="Copy to clipboard"
                            onClick={() => copy(mintedKey.api_key)}
                        />
                        <CopiedToast visible={copied} />
                    </div>
                    <p className={styles.modalHint}>
                        Exchange it at POST /api/auth/api-token for short-lived
                        access tokens.
                    </p>
                </CardSection>

                <CardActionFooter>
                    <SpinnerButton
                        isPending={false}
                        text="Done"
                        ariaLabel="Close"
                        onClick={() => setIsOpen(false)}
                    />
                </CardActionFooter>
            </>}

            { submitError &&
                <CardErrorSection errorMessage={submitError.message} errorMessageDetails={submitError.details} />
            }
        </CardModal>
    );
}

export function DeleteApiKeyModal({ isOpen, setIsOpen, apiKey }) {

    const {
        mutateAsync: deleteMutate // NOTE, mutateAsync to return a promise, which throws on error -> handled by ConfirmationModal
    } = useDeleteUserApiKeyMutation();

    const deleteOnConfirm = useCallback(async () => {
        return deleteMutate({ formData: { user_id: apiKey.user_id, api_key_id: apiKey.id } });
    }, [ deleteMutate, apiKey ]);

    return (
        <ConfirmationModal
            isOpen={isOpen}
            setIsOpen={setIsOpen}
            title="Revoke API Key"
            content={<>
                <div style={{ width: '30rem', textAlign: 'center' }}>
                    Are you sure you want to revoke the API key <strong>{apiKey?.name ?? 'unknown'}</strong>?
                </div>
                <div style={{ width: '30rem', textAlign: 'center', marginTop: '1rem' }}>
                    Its secret can no longer be exchanged for access tokens (already
                    minted tokens stay valid for up to ~20 minutes). This cannot be
                    undone.
                </div>
            </>}
            confirmText="Revoke API Key"
            confirmButtonClassName={styles.dangerConfirmButton}
            onConfirm={deleteOnConfirm}
        />
    );
}
