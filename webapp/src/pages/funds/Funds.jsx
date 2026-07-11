
import { useCallback, useState, useMemo } from 'react';
import { NavLink, useNavigate } from 'react-router';

import { usePostFundMutation, useGetFundsQuery } from '../../hooks/Queries.jsx';
import SearchableTable from '../../components/SearchableTable.jsx';
import { CardModal } from '../../components/Modal.jsx';
import { CardSection, CardAutoGrid, CardActionFooter, CardErrorSection } from '../../components/Card.jsx';
import { LabeledTextInput, LabeledDateInput, LabeledNumberInput, LabeledBooleanInput } from '../../components/Inputs.jsx';
import { FundSearchableSelector, LabeledFundColorPicker } from '../../components/SpecialInputs.jsx';
import { SpinnerButton, IconButton } from '../../components/Buttons.jsx';
import { FundTypeBadge, FundLabel } from '../../components/Badges.jsx';
import { fundTypeOf, formatDollars } from '../../components/domain.js';
import styles from './Funds.module.css';

const FUND_TYPE_SORT_ORDER = { pool: 0, tracked: 1, monthly: 2, untracked: 3 };

function FundsTable({ showAll }) {
    const [searchTerm, setSearchTerm] = useState('');
    const [sortKey, setSortKey] = useState('name');
    const [direction, setDirection] = useState('asc');

    const navigate = useNavigate();

    // Handle sorting - client-side only
    const handleSort = useCallback((key) => {
        if (sortKey === key) {
            setDirection(direction === 'asc' ? 'desc' : 'asc');
        } else {
            setSortKey(key);
            setDirection('asc');
        }
    }, [sortKey, direction]);

    const {
        isPending: isQueryPending,
        isError,
        data,
        error
    } = useGetFundsQuery(showAll ? {} : { tracked: true });

    // Memoized processed data for filtering and sorting. Flatten the nested
    // API fields (start/cache/status) into sortable scalars first.
    const processedData = useMemo(() => {
        if (!data) return [];

        let flattened = data.map(fund => ({
            ...fund,
            type: fundTypeOf(fund.status),
            start_date: fund.start?.date ?? null,
            cache_balance: fund.cache?.forward_balance ?? null,
        }));

        // Filter by search term (name)
        if (searchTerm.trim()) {
            const searchLower = searchTerm.toLowerCase();
            flattened = flattened.filter(fund =>
                fund.name?.toLowerCase().includes(searchLower)
            );
        }

        // Sort data
        return flattened.sort((a, b) => {
            let aVal = a[sortKey];
            let bVal = b[sortKey];

            // Fund types sort in hierarchy order, not alphabetically
            if (sortKey === 'type') {
                aVal = FUND_TYPE_SORT_ORDER[aVal];
                bVal = FUND_TYPE_SORT_ORDER[bVal];
            }

            // Handle null/undefined values
            if (aVal == null) aVal = '';
            if (bVal == null) bVal = '';

            // Convert to strings for comparison if needed
            if (typeof aVal === 'string') aVal = aVal.toLowerCase();
            if (typeof bVal === 'string') bVal = bVal.toLowerCase();

            let comparison = 0;
            if (aVal < bVal) comparison = -1;
            if (aVal > bVal) comparison = 1;

            return direction === 'asc' ? comparison : -comparison;
        });
    }, [data, searchTerm, sortKey, direction]);

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
                </div>
            </div>
        );
    }

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
        },
        {
            header: 'Last Reconciled Balance',
            sortKey: 'cache_balance',
            sortable: true,
            render: (fund) => fund.cache
                ? `${formatDollars(fund.cache.forward_balance)} entering ${fund.cache.date}`
                : "—"
        }
    ];

    return (
        <div className={styles.container}>
            <SearchableTable
                className={styles.tableContainer}
                data={processedData}
                columns={columns}
                searchValue={searchTerm}
                onSearchChange={setSearchTerm}
                searchPlaceholder="Search funds by name..."
                sortKey={sortKey}
                sortDirection={direction}
                onSort={handleSort}
                isLoading={isQueryPending}
                onRowClick={(fund) => navigate(`/fund/${fund.id}`)}
                rowKey="id"
                maxSearchWidth="25rem"
            />
        </div>
    );
}

const EMPTY_FORM = {
    name: null,
    parent_id: null,
    tracked: true,
    start_date: null,
    start_balance: 0,
    monthly: false,
    pool: false,
    color: null
};

function CreateNew() {

    const [ isModalOpen, setIsModalOpen ] = useState(false);
    const [ data, setData ] = useState(EMPTY_FORM);
    const [ submitError, setSubmitError ] = useState(null);

    const reset = () => {
        setData(EMPTY_FORM);
        setSubmitError(null);
    };

    const handleChange = (field, value) => {
        setData(prevData => ({ ...prevData, [field]: value }));
        setSubmitError(null);
    };

    // Client-side mirrors of the model's consistency rules (the server is
    // the real authority -- these just make the modal self-explanatory)
    const dataValidity = useMemo(() => ({
        name: (data.name == null) ? 'Name is required.'
            : (data.name.trim().length === 0) ? 'Name cannot be empty.'
            : null,
        start_date: (data.tracked && !data.start_date)
            ? 'Tracked funds need a start date.' : null,
        start_balance: (data.tracked && data.start_balance == null)
            ? 'Tracked funds need a start balance.' : null,
        monthly: (data.monthly && !data.parent_id)
            ? 'Monthly funds need a parent (with a pool ancestor).'
            : (data.monthly && !data.tracked) ? 'Monthly funds must be tracked.'
            : (data.monthly && data.pool) ? 'A fund cannot be both pool and monthly.'
            : null,
        pool: (data.pool && !data.tracked) ? 'Pools must be tracked.' : null,
    }), [data]);

    const {
        mutate,
        isPending: postIsPending
    } = usePostFundMutation();

    const handleSubmit = useCallback(() => {
        mutate(
            {
                formData: {
                    name: data.name,
                    parent_id: data.parent_id,
                    tracked: data.tracked,
                    start_date: data.tracked ? data.start_date : null,
                    start_balance: data.tracked ? data.start_balance : null,
                    monthly: data.monthly,
                    pool: data.pool,
                    color: data.color
                }
            },
            {
                onSuccess: () => {
                    setIsModalOpen(false);
                },
                onError: (err) => {
                    setSubmitError({
                        message: err.message,
                        details: err.details?.message
                    });
                }
            }
        );
    }, [data, mutate, setIsModalOpen, setSubmitError]);

    return (
        <>
            <IconButton
                text="Create Fund"
                icon="fa-square-plus"
                buttonClassName={styles.modalOpenButton}
                onClick={() => {
                    setIsModalOpen(true);
                    reset();
                }}
            />
            <CardModal
                title="Create a new Fund"
                isOpen={isModalOpen}
                setIsOpen={setIsModalOpen}
                cardClassName={styles.createModalCard}
            >
                <CardSection title="Details">
                    <CardAutoGrid>
                        <LabeledTextInput
                            label="Name"
                            isFrozen={false}
                            isRequired={true}
                            value={data.name}
                            nullPlaceholder="Enter fund name"
                            emptyStringPlaceholder="Fund name cannot be empty"
                            onChange={(value) => handleChange('name', value)}
                            allowNull={false}
                            validityMessage={dataValidity.name}
                        />
                        <FundSearchableSelector
                            label="Parent fund"
                            isFrozen={false}
                            value={data.parent_id}
                            onChange={(value) => handleChange('parent_id', value)}
                            allowNull={true}
                        />
                        <LabeledBooleanInput
                            label="Tracked"
                            isFrozen={false}
                            value={data.tracked}
                            onChange={(value) => handleChange('tracked', value)}
                            inputTitle="Tracked funds hold real money and calculate balances"
                        />
                        <LabeledBooleanInput
                            label="Pool"
                            isFrozen={false}
                            value={data.pool}
                            onChange={(value) => handleChange('pool', value)}
                            validityMessage={dataValidity.pool}
                            inputTitle="Pools are the source/sink of money for their descendants"
                        />
                        <LabeledBooleanInput
                            label="Monthly"
                            isFrozen={false}
                            value={data.monthly}
                            onChange={(value) => handleChange('monthly', value)}
                            validityMessage={dataValidity.monthly}
                            inputTitle="Monthly funds reset into their nearest pool ancestor at end of month"
                        />
                    </CardAutoGrid>
                </CardSection>

                { data.tracked &&
                    <CardSection title="Tracking">
                        <CardAutoGrid>
                            <LabeledDateInput
                                label="Start date"
                                isFrozen={false}
                                isRequired={true}
                                value={data.start_date}
                                onChange={(value) => handleChange('start_date', value || null)}
                                validityMessage={dataValidity.start_date}
                            />
                            <LabeledNumberInput
                                label="Start balance ($)"
                                isFrozen={false}
                                isRequired={true}
                                value={data.start_balance}
                                onChange={(value) => handleChange('start_balance', value)}
                                validityMessage={dataValidity.start_balance}
                                inputTitle="The balance entering the start date"
                            />
                        </CardAutoGrid>
                    </CardSection>
                }

                <CardSection title="Color">
                    <LabeledFundColorPicker
                        label=""
                        isFrozen={false}
                        value={data.color}
                        onChange={(value) => handleChange('color', value)}
                    />
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
        </>
    );
}


export default function Page() {
    const [ showAll, setShowAll ] = useState(false);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', height: '100%', 'padding': '0 1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                <h1>Funds</h1>
                <IconButton
                    text={showAll ? "Showing all funds" : "Showing tracked funds"}
                    icon={showAll ? "fa-eye" : "fa-chart-line"}
                    onClick={() => setShowAll(v => !v)}
                    buttonClassName={styles.showAllToggle}
                />
                <CreateNew />
            </div>
            <FundsTable showAll={showAll} />
        </div>
    );
}
