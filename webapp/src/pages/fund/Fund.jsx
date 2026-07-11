
import { useParams, useNavigate, NavLink } from 'react-router';
import { useState, useEffect, useMemo, useCallback, useRef, forwardRef } from 'react';
import dayjs from 'dayjs';

import { useUrlFragment } from '../../hooks/URLFragment.jsx';
import {
    useGetFundQuery,
    useGetFundsQuery,
    useGetFundBalanceQuery,
    usePatchFundMutation,
    useDeleteFundMutation
} from '../../hooks/Queries.jsx';
import Spinner from '../../components/Spinner.jsx';
import { LabeledNumberInput, LabeledTextInput, LabeledDateInput, LabeledBooleanInput } from '../../components/Inputs.jsx';
import { FundSearchableSelector, LabeledFundColorPicker } from '../../components/SpecialInputs.jsx';
import { Card, CardActionHeader, CardSection, CardAutoGrid, CollapsibleCardSection, CardErrorSection } from '../../components/Card.jsx';
import { ConfirmationModal } from '../../components/Modal.jsx';
import { BackLink, AnchorLink } from '../../components/Links.jsx';
import SearchableTable from '../../components/SearchableTable.jsx';
import { IconButton } from '../../components/Buttons.jsx';
import { FundTypeBadge, FundLabel } from '../../components/Badges.jsx';
import { fundTypeOf, formatDollars } from '../../components/domain.js';
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

const EMPTY_FORM = {
    name: null,
    parent_id: null,
    tracked: false,
    start_date: null,
    start_balance: null,
    monthly: false,
    pool: false,
    color: null
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
        color: fundDetail.color
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
                        isFrozen={!isEditing}
                        isChanged={formData.parent_id !== originalData.parent_id}
                        excludeIds={[parseInt(fundIdStr)]}
                        allowNull={true}
                    />

                    <LabeledBooleanInput
                        label="Tracked"
                        value={formData.tracked}
                        onChange={(value) => handleInputChange('tracked', value)}
                        isFrozen={!isEditing}
                        isChanged={formData.tracked !== originalData.tracked}
                        inputTitle="Tracked funds hold real money and calculate balances"
                    />

                    <LabeledBooleanInput
                        label="Pool"
                        value={formData.pool}
                        onChange={(value) => handleInputChange('pool', value)}
                        isFrozen={!isEditing}
                        isChanged={formData.pool !== originalData.pool}
                        inputTitle="Pools are the source/sink of money for their descendants"
                    />

                    <LabeledBooleanInput
                        label="Monthly"
                        value={formData.monthly}
                        onChange={(value) => handleInputChange('monthly', value)}
                        isFrozen={!isEditing}
                        isChanged={formData.monthly !== originalData.monthly}
                        inputTitle="Monthly funds reset into their nearest pool ancestor at end of month"
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
                            isFrozen={!isEditing}
                            isChanged={formData.start_date !== originalData.start_date}
                            inputTitle="Immutable once any month has been finalized"
                        />
                        <LabeledNumberInput
                            label="Start balance ($)"
                            value={formData.start_balance}
                            onChange={(value) => handleInputChange('start_balance', value)}
                            isFrozen={!isEditing}
                            isChanged={formData.start_balance !== originalData.start_balance}
                            inputTitle="The balance entering the start date; immutable once any month has been finalized"
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
                            value={balanceIsPending ? "..." : formatDollars(balanceData?.balance)}
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
