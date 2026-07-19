
import { useParams, useNavigate, NavLink } from 'react-router';
import { useState, useEffect, useMemo, useCallback, useRef, forwardRef } from 'react';
import dayjs from 'dayjs';

import { useUrlFragment } from '../../hooks/URLFragment.jsx';
import {
    useGetFundQuery,
    useGetFundsQuery,
    useGetFundBalanceQuery,
    useGetFundFinalizationsQuery,
    useGetLatestMonthFinalizationQuery,
    usePatchFundMutation,
    useDeprecateFundMutation,
    useDeleteFundMutation,
    useProvisionalFrontier,
} from '../../hooks/Queries.jsx';
import Spinner from '../../components/Spinner.jsx';
import { LabeledNumberInput, LabeledTextInput, LabeledDateInput, LabeledBooleanInput } from '../../components/Inputs.jsx';
import { FundSearchableSelector, LabeledFundColorPicker } from '../../components/SpecialInputs.jsx';
import { Card, CardActionHeader, CardSection, CardAutoGrid, CardActionFooter, CollapsibleCardSection, CardErrorSection } from '../../components/Card.jsx';
import { ConfirmationModal, CardModal } from '../../components/Modal.jsx';
import { BackLink, AnchorLink } from '../../components/Links.jsx';
import SearchableTable from '../../components/SearchableTable.jsx';
import { IconButton, SpinnerButton } from '../../components/Buttons.jsx';
import { FundTypeBadge, FundLabel } from '../../components/Badges.jsx';
import { fundTypeOf, formatDollars, monthLabel, fundIdsContainingMonthly } from '../../components/domain.js';
import { Banner } from '../../components/Banner.jsx';
import { ProvisionalBanner, ProvisionalValue } from '../../components/Provisional.jsx';
import styles from './Fund.module.css';


function DeleteFund({ fundIdStr }) {

    const [ isModalOpen, setIsModalOpen ] = useState(false);

    const navigate = useNavigate();

    const {
        mutateAsync: deleteMutate, // NOTE, mutateAsync to return a promise, which throws on error -> handled by ConfirmationModal
    } = useDeleteFundMutation();

    const deleteOnConfirm = useCallback(async () => {
        return deleteMutate(
            {
                formData: {
                    id: parseInt(fundIdStr)
                }
            },
            {
                onSuccess: () => navigate("/funds")
            }
        );
    }, [ deleteMutate, fundIdStr, navigate ]);

    return (
        <>
            <IconButton
                text="Delete"
                icon="fa-trash"
                onClick={() => setIsModalOpen(true)}
                buttonClassName={styles.deleteButton}
            />
            <ConfirmationModal
                isOpen={isModalOpen}
                setIsOpen={setIsModalOpen}
                title="Confirm Delete Fund"
                message="Are you sure you want to delete this fund? Funds with finalized history or transactions cannot be deleted."
                onConfirm={deleteOnConfirm}
                confirmText="Delete"
                confirmButtonClassName={styles.deleteButton}
            />
        </>
    );
}

function DeprecateFund({ fundIdStr, fundDetail }) {

    const [ isModalOpen, setIsModalOpen ] = useState(false);
    const [ date, setDate ] = useState(null);
    const [ transferToId, setTransferToId ] = useState(null);
    const [ submitError, setSubmitError ] = useState(null);

    const reset = () => {
        setDate(dayjs().format('YYYY-MM-DD'));
        setTransferToId(null);
        setSubmitError(null);
    };

    // The remaining balance ON the chosen date decides whether a close-out
    // transfer (and its destination fund) is needed at all
    const {
        data: balanceData,
        isPending: balanceIsPending,
    } = useGetFundBalanceQuery(
        fundIdStr,
        { on: date ?? undefined },
        { enabled: isModalOpen && date != null }
    );
    const balance = (date != null && !balanceIsPending) ? balanceData?.balance : null;
    const needsTransfer = balance != null && balance !== 0;

    // Deprecation demands a ZERO balance on the date, so a provisional figure
    // matters more here than anywhere else: a pending end-of-month cleanup can
    // turn today's clean zero into a remainder, and the server will refuse the
    // whole close-out at that point
    const { som: firstUnfinalizedSom } = useProvisionalFrontier();
    const balanceIsProvisional = balance != null && !!balanceData?.provisional;

    const {
        mutate,
        isPending: deprecateIsPending
    } = useDeprecateFundMutation();

    // The earliest legal deprecation date: on/after the fund's start_date and
    // outside every finalized month (months finalize contiguously, so "after
    // the latest finalization" covers them all)
    const latestFinalizationQ = useGetLatestMonthFinalizationQuery();
    const minDate = [ latestFinalizationQ.data?.sonm_date, fundDetail?.start_date ]
        .filter(d => d != null)
        .sort()
        .pop() ?? null;

    // Client-side mirrors of the server's checks (the server is the real
    // authority -- these just make the modal self-explanatory)
    const dataValidity = useMemo(() => ({
        date: (date == null) ? 'A last active day is required.'
            : (minDate != null && date < minDate)
                ? `The last active day must be on or after ${dayjs(minDate).format('MMM D, YYYY')} (after the fund started and outside finalized months).`
            : null,
        transfer_to: (needsTransfer && transferToId == null)
            ? 'The remaining balance needs a destination fund.' : null,
    }), [date, minDate, needsTransfer, transferToId]);

    const handleSubmit = useCallback(() => {
        mutate(
            {
                formData: {
                    id: parseInt(fundIdStr),
                    date,
                    transfer_to_fund_id: transferToId
                }
            },
            {
                onSuccess: () => setIsModalOpen(false),
                onError: (err) => setSubmitError({
                    message: err.message,
                    details: err.details?.message
                })
            }
        );
    }, [mutate, fundIdStr, date, transferToId, setIsModalOpen, setSubmitError]);

    return (
        <>
            <IconButton
                text="Deprecate"
                icon="fa-box-archive"
                onClick={() => {
                    setIsModalOpen(true);
                    reset();
                }}
            />
            <CardModal
                title={`Deprecate ${fundDetail?.name ?? 'fund'}`}
                isOpen={isModalOpen}
                setIsOpen={setIsModalOpen}
                size="md"
            >
                <p className={styles.deprecateNote}>
                    Deprecating closes this fund out as of its <strong>last active
                    day</strong>, in one atomic step:
                </p>
                <ul className={styles.deprecateList}>
                    <li>Any remaining balance on that day is transferred into the destination fund below (dated that day).</li>
                    <li>Any of this fund's allocations in later months are removed.</li>
                    <li>The fund is then <strong>frozen</strong>: no transaction of any kind may involve it, and it is hidden from months after the date (and from the funds list by default).</li>
                </ul>
                <p className={styles.deprecateNote}>
                    It requires: every sub-fund already deprecated, no other
                    transactions after the date, and the date's month not yet
                    finalized. To undo, clear the fund's Deprecated field.
                </p>

                <CardSection title="Close out">
                    <CardAutoGrid>
                        <LabeledDateInput
                            label="Last active day"
                            isFrozen={false}
                            isRequired={true}
                            value={date}
                            onChange={(value) => { setDate(value || null); setSubmitError(null); }}
                            min={minDate ?? undefined}
                            validityMessage={dataValidity.date}
                        />
                        <LabeledTextInput
                            label="Remaining balance on that day"
                            value={date == null ? "—"
                                : balanceIsPending ? "..."
                                : balanceIsProvisional
                                    ? <ProvisionalValue som={firstUnfinalizedSom}>{formatDollars(balance)}</ProvisionalValue>
                                    : formatDollars(balance)}
                            isFrozen={true}
                        />
                        <FundSearchableSelector
                            label="Transfer remainder to"
                            isFrozen={!needsTransfer}
                            value={transferToId}
                            onChange={(value) => { setTransferToId(value); setSubmitError(null); }}
                            excludeIds={[parseInt(fundIdStr)]}
                            allowNull={true}
                            validityMessage={dataValidity.transfer_to}
                        />
                    </CardAutoGrid>
                    { balanceIsProvisional &&
                        <Banner variant="warn" dense icon="fa-triangle-exclamation">
                            {monthLabel(firstUnfinalizedSom)} isn&apos;t finalized, so this
                            balance isn&apos;t settled: finalizing it first may leave a
                            different remainder here. Deprecating requires the fund to be
                            empty on the chosen day, so it is worth finalizing back to that
                            month before closing this fund out.
                        </Banner>
                    }
                </CardSection>

                <CardActionFooter>
                    <SpinnerButton
                        isPending={deprecateIsPending}
                        disabled={Object.values(dataValidity).some(v => v != null) || submitError != null}
                        text="Deprecate"
                        ariaLabel="Deprecate fund"
                        onClick={handleSubmit}
                    />
                </CardActionFooter>

                { submitError &&
                    <CardErrorSection errorMessage={submitError.message} errorMessageDetails={submitError.details} />
                }
            </CardModal>
        </>
    );
}

const EMPTY_FORM = {
    name: null,
    parent_id: null,
    tracked: false,
    start_date: null,
    start_balance: null,
    monthly: false,
    pool: false,
    color: null,
    deprecated: null
};

function formFromFund(fundDetail) {
    return {
        name: fundDetail.name,
        parent_id: fundDetail.parent_id,
        tracked: fundDetail.status.tracked,
        start_date: fundDetail.start?.date ?? null,
        start_balance: fundDetail.start?.forward_balance ?? null,
        monthly: fundDetail.status.monthly,
        pool: fundDetail.status.pool,
        color: fundDetail.color,
        deprecated: fundDetail.deprecated ?? null
    };
}

const InfoCard = forwardRef(({ fundIdStr, fundDetail, anchor }, ref) => {

    const [isEditing, setIsEditing] = useState(false);
    const [formData, setFormData] = useState(EMPTY_FORM);
    const [originalData, setOriginalData] = useState(EMPTY_FORM);
    const [submitError, setSubmitError] = useState(null);

    // Update mutation
    const {
        mutate,
        isPending: updateIsPending
    } = usePatchFundMutation();

    // History-affecting fields are immutable once ANY finalization exists for
    // the fund (the server's `assert_unfinalized`). Freeze them up front so the
    // user sees WHY instead of hitting a 400 on save. `parent_id` is only
    // history for funds that are or contain a monthly fund (the server's
    // narrower guard), so it locks separately.
    const isTracked = !!fundDetail?.status?.tracked;
    const fundFinalizationsQ = useGetFundFinalizationsQuery(
        { fundId: fundDetail?.id },
        { enabled: fundDetail != null && isTracked }
    );
    const historyLocked = (fundFinalizationsQ.data?.length ?? 0) > 0;

    const allFundsQ = useGetFundsQuery();
    const monthlyContainingIds = useMemo(
        () => fundIdsContainingMonthly(allFundsQ.data ?? []),
        [allFundsQ.data]
    );
    const parentLocked = historyLocked
        && fundDetail != null
        && (fundDetail.status?.monthly || monthlyContainingIds.has(fundDetail.id));

    const lockedTitle = "Locked: this fund has finalized months. Unfinalize back to the fund's start before changing its history.";

    // Initialize form data when fund details are loaded
    useEffect(() => {
        if (fundDetail) {
            const data = formFromFund(fundDetail);
            setFormData(data);
            setOriginalData(data);
        }
    }, [fundDetail]);

    // Helper functions
    const getChangedFields = useCallback(() => {
        const changes = {};
        for (const key of Object.keys(formData)) {
            if (formData[key] !== originalData[key]) {
                changes[key] = formData[key];
            }
        }
        return changes;
    }, [formData, originalData]);

    const hasChanges = () => {
        return Object.keys(getChangedFields()).length > 0;
    };

    const handleInputChange = (field, value) => {
        setFormData(prev => ({ ...prev, [field]: value }));
        setSubmitError(null); // Clear error when user makes changes
    };

    const handleSave = useCallback(() => {
        const changes = getChangedFields();
        if (Object.keys(changes).length > 0) {
            mutate(
                { formData: { id: parseInt(fundIdStr), ...changes } },
                {
                    onSuccess: () => {
                        setIsEditing(false);
                        setSubmitError(null);
                    },
                    onError: (error) => {
                        setSubmitError({
                            message: error.message,
                            details: error.details?.message ? error.details.message : null
                        });
                    }
                }
            );
        } else {
            setIsEditing(false);
        }
    }, [getChangedFields, mutate, fundIdStr, setIsEditing, setSubmitError]);

    const handleCancel = () => {
        setFormData(originalData);
        setIsEditing(false);
        setSubmitError(null);
    };

    return (
        <Card ref={ref}>
            <CardActionHeader
                title={<AnchorLink fragment={anchor} linkText="Fund Information" />}
            >
                {!isEditing ? (<>
                    <DeleteFund fundIdStr={fundIdStr} />
                    { isTracked && fundDetail?.deprecated == null &&
                        <DeprecateFund fundIdStr={fundIdStr} fundDetail={fundDetail} />
                    }
                    <IconButton
                        text="Edit"
                        icon="fa-pen-to-square"
                        onClick={() => setIsEditing(true)}
                    />
                </>) : (<>
                    <IconButton
                        text="Save"
                        icon="fa-floppy-disk"
                        onClick={handleSave}
                        disabled={!hasChanges()}
                        pendingText="Saving..."
                        isPending={updateIsPending}
                        buttonClassName={hasChanges() ? styles.buttonHasChanges : ''}
                    />
                    <IconButton
                        text="Cancel"
                        icon="fa-ban"
                        onClick={handleCancel}
                        disabled={updateIsPending}
                    />
                </>)}
            </CardActionHeader>

            { submitError && (
                <CardErrorSection errorMessage={submitError.message} errorMessageDetails={submitError.details} />
            )}

            { isEditing && historyLocked && (
                <p className={styles.historyLockedNote}>
                    This fund has finalized months, so its history-affecting fields
                    (start point, tracked/pool/monthly{parentLocked ? ', parent' : ''}) are
                    locked. Unfinalize back to the fund's start to change them.
                </p>
            )}

            <CardSection title="Details">
                <CardAutoGrid>
                    <LabeledNumberInput
                        label="ID"
                        value={fundDetail?.id}
                        isFrozen={true}
                    />

                    <LabeledTextInput
                        label="Name"
                        value={formData.name}
                        onChange={(value) => handleInputChange('name', value)}
                        isFrozen={!isEditing}
                        isChanged={formData.name !== originalData.name}
                    />

                    <FundSearchableSelector
                        label="Parent fund"
                        value={formData.parent_id}
                        onChange={(value) => handleInputChange('parent_id', value)}
                        isFrozen={!isEditing || parentLocked}
                        isChanged={formData.parent_id !== originalData.parent_id}
                        excludeIds={[parseInt(fundIdStr)]}
                        allowNull={true}
                    />

                    <LabeledBooleanInput
                        label="Tracked"
                        value={formData.tracked}
                        onChange={(value) => handleInputChange('tracked', value)}
                        isFrozen={!isEditing || historyLocked}
                        isChanged={formData.tracked !== originalData.tracked}
                        inputTitle={historyLocked ? lockedTitle : "Tracked funds hold real money and calculate balances"}
                    />

                    <LabeledBooleanInput
                        label="Pool"
                        value={formData.pool}
                        onChange={(value) => handleInputChange('pool', value)}
                        isFrozen={!isEditing || historyLocked}
                        isChanged={formData.pool !== originalData.pool}
                        inputTitle={historyLocked ? lockedTitle : "Pools are the source/sink of money for their descendants"}
                    />

                    <LabeledBooleanInput
                        label="Monthly"
                        value={formData.monthly}
                        onChange={(value) => handleInputChange('monthly', value)}
                        isFrozen={!isEditing || historyLocked}
                        isChanged={formData.monthly !== originalData.monthly}
                        inputTitle={historyLocked ? lockedTitle : "Monthly funds reset into their nearest pool ancestor at end of month"}
                    />
                </CardAutoGrid>
            </CardSection>

            { (formData.tracked || fundDetail?.status?.tracked) &&
                <CardSection title="Tracking">
                    <CardAutoGrid>
                        <LabeledDateInput
                            label="Start date"
                            value={formData.start_date}
                            onChange={(value) => handleInputChange('start_date', value || null)}
                            isFrozen={!isEditing || historyLocked}
                            isChanged={formData.start_date !== originalData.start_date}
                            inputTitle={historyLocked ? lockedTitle : "Immutable once any month has been finalized"}
                        />
                        <LabeledNumberInput
                            label="Start balance ($)"
                            value={formData.start_balance}
                            onChange={(value) => handleInputChange('start_balance', value)}
                            isFrozen={!isEditing || historyLocked}
                            isChanged={formData.start_balance !== originalData.start_balance}
                            inputTitle={historyLocked ? lockedTitle : "The balance entering the start date; immutable once any month has been finalized"}
                        />
                        <LabeledDateInput
                            label="Deprecated (last active day)"
                            value={formData.deprecated}
                            onChange={(value) => handleInputChange('deprecated', value || null)}
                            isFrozen={!isEditing}
                            isChanged={formData.deprecated !== originalData.deprecated}
                            allowNull={true}
                            nullPlaceholder="Active"
                            inputTitle={"Deprecating requires a zero balance on this date, no transactions after it, and all sub-funds deprecated first. A deprecated fund is frozen -- no transaction may involve it -- and hidden from months after this date. Clear to re-activate."}
                        />
                    </CardAutoGrid>
                </CardSection>
            }

            <CardSection title="Color">
                <LabeledFundColorPicker
                    label=""
                    value={formData.color}
                    onChange={(value) => handleInputChange('color', value)}
                    isFrozen={!isEditing}
                    isChanged={formData.color !== originalData.color}
                />
            </CardSection>

            <CardSection title="Timestamps">
                <CardAutoGrid>
                    <LabeledTextInput
                        label="Created"
                        value={fundDetail?.created_at ? dayjs(fundDetail.created_at).format("YYYY-MM-DD HH:mm:ss") : "N/A"}
                        isFrozen={true}
                    />
                </CardAutoGrid>
            </CardSection>
        </Card>
    );
});

const BalancesCard = forwardRef(({ fundId, fundDetail, anchor }, ref) => {

    const isTracked = !!fundDetail?.status?.tracked;

    const {
        data: balanceData,
        isPending: balanceIsPending,
        isError: balanceIsError,
        error: balanceError
    } = useGetFundBalanceQuery(fundId, {}, { enabled: isTracked });

    // Only the CURRENT balance can be provisional here: "last reconciled" is a
    // finalization cache point and "tracking started" is a stored constant --
    // both are settled by construction
    const { som: firstUnfinalizedSom } = useProvisionalFrontier();
    const isProvisional = !!balanceData?.provisional;

    const currentBalance = balanceIsPending
        ? "..."
        : isProvisional
            ? <ProvisionalValue som={firstUnfinalizedSom}>{formatDollars(balanceData?.balance)}</ProvisionalValue>
            : formatDollars(balanceData?.balance);

    return (
        <Card ref={ref} style={{ marginTop: '2rem' }}>
            <CardSection title={<AnchorLink fragment={anchor} linkText="Balances" />}>
                { !isTracked ? (
                    <p className={styles.mutedNote}>This fund is untracked: it holds no money of its own.</p>
                ) : balanceIsError ? (
                    <CardErrorSection errorMessage={balanceError.message} errorMessageDetails={balanceError.details?.message} />
                ) : (
                    <CardAutoGrid>
                        <LabeledTextInput
                            label="Current balance"
                            value={currentBalance}
                            isFrozen={true}
                        />
                        <LabeledTextInput
                            label="Last reconciled"
                            value={fundDetail.cache
                                ? `${formatDollars(fundDetail.cache.forward_balance)} entering ${fundDetail.cache.date}`
                                : "—"}
                            isFrozen={true}
                        />
                        <LabeledTextInput
                            label="Tracking started"
                            value={fundDetail.start
                                ? `${formatDollars(fundDetail.start.forward_balance)} entering ${fundDetail.start.date}`
                                : "—"}
                            isFrozen={true}
                        />
                    </CardAutoGrid>
                )}
                { isProvisional &&
                    <ProvisionalBanner som={firstUnfinalizedSom} className={styles.provisionalBanner} />
                }
            </CardSection>
        </Card>
    );
});

const SubFundsTable = forwardRef(function SubFundsTable({ fundId, isPending, anchor, isCollapsed, setIsCollapsed, setFragment }, ref) {
    const [ searchTerm, setSearchTerm ] = useState('');
    const [ sortKey, setSortKey ] = useState('name');
    const [ direction, setDirection ] = useState('asc');

    const {
        isPending: isQueryPending,
        isError,
        data: rawData,
        error
    } = useGetFundsQuery({ descendantOf: fundId });

    // Handle sorting client-side
    const handleSort = (newSortKey) => {
        if (sortKey === newSortKey) {
            setDirection(direction === 'asc' ? 'desc' : 'asc');
        } else {
            setSortKey(newSortKey);
            setDirection('asc');
        }
    };

    // Filter and sort data client-side
    const processedData = useMemo(() => {
        if (!rawData) return [];

        let flattened = rawData.map(fund => ({
            ...fund,
            type: fundTypeOf(fund.status),
            start_date: fund.start?.date ?? null,
        }));

        if (searchTerm.trim()) {
            const searchLower = searchTerm.toLowerCase().trim();
            flattened = flattened.filter(fund =>
                fund.name.toLowerCase().includes(searchLower)
            );
        }

        return flattened.sort((a, b) => {
            let aValue = a[sortKey] ?? '';
            let bValue = b[sortKey] ?? '';

            if (typeof aValue === 'number' && typeof bValue === 'number') {
                return direction === 'asc' ? aValue - bValue : bValue - aValue;
            }
            aValue = String(aValue).toLowerCase();
            bValue = String(bValue).toLowerCase();
            return direction === 'asc'
                ? aValue.localeCompare(bValue)
                : bValue.localeCompare(aValue);
        });
    }, [rawData, searchTerm, sortKey, direction]);

    // Define table columns configuration
    const columns = [
        {
            header: 'Name',
            sortKey: 'name',
            sortable: true,
            render: (fund) => (
                <NavLink to={`/fund/${fund.id}`} onClick={(e) => e.stopPropagation()}>
                    <FundLabel fund={fund} />
                </NavLink>
            )
        },
        {
            header: 'Type',
            sortKey: 'type',
            sortable: true,
            render: (fund) => <FundTypeBadge status={fund.status} />
        },
        {
            header: 'Started',
            sortKey: 'start_date',
            sortable: true,
            render: (fund) => fund.start_date ?? "—"
        }
    ];

    return (
        <Card ref={ref} style={{ marginTop: '2rem' }}>
            <CollapsibleCardSection
                title={<AnchorLink fragment={anchor} linkText="Sub-funds" />}
                isCollapsed={isCollapsed}
                setIsCollapsed={setIsCollapsed}
                onCollapseToggle={(collapsed) => {
                    if (!collapsed) setFragment('subfunds');
                }}
            >
                { isError
                    ? <CardErrorSection errorMessage={error.message} errorMessageDetails={error.details?.message} />
                    : <SearchableTable
                        className={styles.subFundsTable}
                        data={processedData}
                        columns={columns}
                        searchValue={searchTerm}
                        onSearchChange={(value) => setSearchTerm(value)}
                        searchPlaceholder="Search sub-funds..."
                        sortKey={sortKey}
                        sortDirection={direction}
                        onSort={handleSort}
                        isLoading={isQueryPending}
                        isPending={isPending}
                        onRowClick={null}
                        rowKey="id"
                        maxSearchWidth="25rem"
                    />
                }
            </CollapsibleCardSection>
        </Card>
    );
});



export default function FundPage() {
    const { fragment, fragmentRef, setFragment } = useUrlFragment();
    const { id: fundId } = useParams();

    // Create refs for each section
    const topRef = useRef(null);
    const infoCardRef = useRef(null);
    const balancesRef = useRef(null);
    const subFundsRef = useRef(null);

    // Externally managed collapse state for each card
    const [subFundsCollapsed, setSubFundsCollapsed] = useState(true);

    // Update collapse when page mounts, or the fundId changes
    useEffect(() => {
        setSubFundsCollapsed(fragmentRef.current !== 'subfunds');
    }, [fundId, fragmentRef/* <= stable */]);

    const {
        isPending,
        isError,
        data: fundDetail,
        error
    } = useGetFundQuery(fundId, { retry: 1 });

    // Scroll to the appropriate section when fragment changes and fund is loaded
    useEffect(() => {
        if (!isPending && !isError && fundDetail) {
            // Small delay to ensure the card has opened and rendered
            const timeoutId = setTimeout(() => {
                let targetRef = null;
                switch (fragment) {
                    case 'info':
                        targetRef = infoCardRef;
                        break;
                    case 'balances':
                        targetRef = balancesRef;
                        break;
                    case 'subfunds':
                        targetRef = subFundsRef;
                        break;
                    default:
                        targetRef = topRef;
                        break;
                }

                if (targetRef?.current) {
                    // Check if element is already fully visible
                    const rect = targetRef.current.getBoundingClientRect();
                    const viewportHeight = window.innerHeight;

                    // Element is fully visible if both top and bottom are in viewport
                    const isFullyVisible = rect.top >= 0 && rect.bottom <= viewportHeight;

                    if (!isFullyVisible) {
                        // Only scroll if not fully visible, using gentle positioning
                        targetRef.current.scrollIntoView({
                            behavior: 'smooth',
                            block: 'center'
                        });
                    }
                }
            }, 100); // Small delay to allow card animation to complete

            return () => clearTimeout(timeoutId);
        }
    }, [isPending, isError, fundDetail, fragment]);

    if (isPending) {
        return (
            <div className={styles.container}>
                <div className={styles.loadingContainer}>
                    <Spinner size="2rem" />
                    <span>Loading fund details...</span>
                </div>
            </div>
        );
    }

    if (isError) {
        return (
            <div className={styles.container}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '1rem', textAlign: 'center' }}>
                    <h2 style={{ color: 'var(--font-danger-color)', margin: 0 }}>Error</h2>
                    <p style={{ color: 'var(--font-primary-color)', margin: 0, fontSize: '1.1rem' }}>
                        { error.details?.message
                            ? `${error.message}: ${error.details.message}`
                            : error.message
                        }
                    </p>
                    <BackLink to="/funds" linkText="Back to Funds"/>
                </div>
            </div>
        );
    }


    return (
        <div className={styles.container} ref={topRef}>
            <div className={styles.header}>
                <h1>
                    <FundLabel fund={fundDetail} size="1.1rem" />
                </h1>
                <FundTypeBadge status={fundDetail?.status} />
                <BackLink to="/funds" linkText="All Funds"/>
            </div>

            <div className={styles.content}>
                <InfoCard
                    fundIdStr={fundId}
                    fundDetail={fundDetail}
                    ref={infoCardRef}
                    anchor="info"
                />

                <BalancesCard
                    ref={balancesRef}
                    fundId={fundId}
                    fundDetail={fundDetail}
                    anchor="balances"
                />

                <SubFundsTable
                    ref={subFundsRef}
                    fundId={fundId}
                    isPending={isPending}
                    isCollapsed={subFundsCollapsed}
                    setIsCollapsed={setSubFundsCollapsed}
                    setFragment={setFragment}
                    anchor="subfunds"
                />

            </div>
        </div>
    );
}
