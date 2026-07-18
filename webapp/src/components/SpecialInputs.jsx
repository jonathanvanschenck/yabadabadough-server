import { useCallback } from 'react';
import { useGetFundsQuery, useGetUsersQuery, useGetMonthFinalizationsQuery, useGetStatementSourcesQuery } from '../hooks/Queries.jsx';
import { buildFundOptionTree } from './domain.js';
import { LabeledSearchableSelector, LabeledSelector, LabeledTextInput } from './Inputs.jsx';
import { FundTypeBadge, FinalizedBadge } from './Badges.jsx';
import { FundColorDot } from './SpecialIcons.jsx';
import { FUND_COLORS, fundColorVar } from '../hooks/fundColors.js';
import styles from './SpecialInputs.module.css';

/** Flatten a buildFundOptionTree result depth-first into
 *  `{ fund, path }` options, `path` the ancestor names outermost-first. */
function flattenWithPaths(roots) {
    const out = [];
    const walk = (node, path) => {
        out.push({ fund: node.fund, path });
        node.children.forEach(child => walk(child, [ ...path, node.fund.name ]));
    };
    roots.forEach(root => walk(root, []));
    return out;
}

/**
 * Fund picker. The filter props (tracked/monthly/pool/root/descendantOf) are
 * forwarded to the funds list query, so callers can restrict the choices to
 * what the server will actually accept (e.g. tracked={true} for allocation
 * targets, pool={true} for pool picks). `excludeIds` additionally drops
 * specific funds client-side (e.g. a fund itself when picking its parent).
 *
 * Options are ordered by the fund hierarchy (depth-first, siblings by name)
 * with a faint ancestor-path prefix on each nested fund -- hierarchy is
 * computed over the FILTERED list, so a fund whose ancestors are filtered
 * out simply roots its own subtree.
 *
 * Passing `onCreateNew` (a `(searchTerm) => void` callback) surfaces a
 * "Create new fund" row at the top of the dropdown; it's off unless the caller
 * opts in (the caller owns the create-fund modal and the follow-up selection).
 */
export function FundSearchableSelector({
    value,
    originalFund,
    label = "Fund",
    onChange,
    onCreateNew,
    createNewLabel = "Create new fund",
    tracked,
    monthly,
    pool,
    root,
    descendantOf,
    excludeIds,
    batchSize,
    ...rest
}) {

    const {
        data: allFunds, /* destructure for stable identity, though this is probably unnecessary, since many other things in this component don't have a stable identity */
        isPending: fundsIsPending,
        isError: fundsIsError,
        error: fundsError
    } = useGetFundsQuery({ tracked, monthly, pool, root, descendantOf, batchSize });

    const _onChange = useCallback((selectedValue) => {
        if ( !onChange ) return;
        onChange(selectedValue ? parseInt(selectedValue) : null);
    }, [onChange]);

    const excludeIdStrs = (excludeIds ?? []).map(id => id.toString());
    // Options come in fund-tree order (depth-first, siblings by name -- the
    // same ordering as the transactions/allocations grids), each labeled with
    // its ancestor path so hierarchy survives the search filter hiding
    // parents. The tree is built BEFORE excluding so an excluded fund still
    // appears in its children's paths.
    const options = allFunds
        ? flattenWithPaths(buildFundOptionTree(allFunds))
            .filter(({ fund }) => !excludeIdStrs.includes(fund.id.toString()))
        : null;

    const fundKeys = options ? options.map(({ fund }) => fund.id.toString()) : [];
    const fundDisplayNames = options
        ? options.map(({ fund, path }) => (
            <span className={styles.fundOption}>
                { path.length > 0 &&
                    <span className={styles.fundOptionPath}>{path.join(' ▸ ')} ▸</span>
                }
                <FundTypeBadge status={fund.status} label={fund.name} color={fund.color} />
            </span>
        ))
        : [];
    // The display names are JSX; searching needs plain text. Ancestor names
    // are included so searching a parent surfaces its whole subtree.
    const fundSearchTexts = options ? options.map(({ fund, path }) => [ ...path, fund.name ].join(' ')) : [];
    const _currentFund = allFunds && value
        ? (allFunds.find(f => f.id.toString() === value.toString()) || originalFund || null)
        : (originalFund || null);

    return (
        <LabeledSearchableSelector
            label={label}
            value={value ? value.toString() : ''}
            valueDisplayName={_currentFund ? <FundTypeBadge status={_currentFund.status} label={_currentFund.name} color={_currentFund.color} /> : null}
            optionKeys={fundKeys}
            optionDisplayNames={fundDisplayNames}
            optionSearchTexts={fundSearchTexts}
            onChange={_onChange}
            onCreateNew={onCreateNew}
            createNewLabel={createNewLabel}
            isPending={fundsIsPending}
            isError={fundsIsError}
            error={fundsError}
            placeholder="Select a fund ..."
            searchPlaceholder="Search fund names ..."
            {...rest}
        />
    );
}

/**
 * Fund color picker: a swatch grid over the shared palette registry (the
 * slugs the API accepts; colors resolve via the --fund-<slug> CSS variables).
 * `value`/`onChange` speak SLUGS (or null = no color chosen, which renders the
 * neutral default; offered as the leading "Default" swatch when allowNull).
 */
export function LabeledFundColorPicker({
    label = "Color",
    value,
    onChange,
    isFrozen = true,
    isChanged = false,
    allowNull = true,
}) {
    return (
        <div className={styles.labelContainer}>
            <label className={styles.label}>{label}</label>
            { isFrozen ? (
                <div className={styles.colorFrozen}>
                    <FundColorDot color={value} size="1rem" marginRight="0.5rem" />
                    { value
                        ? value.replace(/-/g, " ")
                        : <span className={styles.placeholder}>(default)</span>
                    }
                </div>
            ) : (
                <div className={`${styles.colorGrid} ${isChanged ? styles.changed : ''}`}>
                    { allowNull && (
                        <button
                            type="button"
                            title="Default"
                            aria-label="Default"
                            className={`${styles.colorSwatch} ${value == null ? styles.colorSwatchSelected : ''}`}
                            style={{ backgroundColor: fundColorVar(null) }}
                            onClick={() => onChange(null)}
                        />
                    )}
                    { FUND_COLORS.map((slug) => (
                        <button
                            key={slug}
                            type="button"
                            title={slug.replace(/-/g, " ")}
                            aria-label={slug.replace(/-/g, " ")}
                            className={`${styles.colorSwatch} ${slug === value ? styles.colorSwatchSelected : ''}`}
                            style={{ backgroundColor: fundColorVar(slug) }}
                            onClick={() => onChange(slug)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * Bank statement source picker: suggests the sources already in use (a
 * consistent name per bank account is what makes (source, key) dedupe work)
 * while still allowing a brand-new label via the "Use new source" row, which
 * adopts the typed search text. `value`/`onChange` speak the source STRING
 * (or null).
 */
export function StatementSourceSelector({ value, label = "Source", onChange, ...rest }) {

    const {
        data: sources,
        isPending: sourcesIsPending,
        isError: sourcesIsError,
        error: sourcesError
    } = useGetStatementSourcesQuery();

    return (
        <LabeledSearchableSelector
            label={label}
            value={value ?? ''}
            optionKeys={sources ?? []}
            optionDisplayNames={sources ?? []}
            onChange={(selectedValue) => onChange(selectedValue || null)}
            onCreateNew={(searchTerm) => onChange(searchTerm.trim() || null)}
            createNewLabel="Use new source"
            isPending={sourcesIsPending}
            isError={sourcesIsError}
            error={sourcesError}
            placeholder="Select a source ..."
            searchPlaceholder="Search sources, or type a new one ..."
            {...rest}
        />
    );
}

/**
 * User picker. Only usable with active sudo-mode admin rights: the backing
 * users list is an admin-only endpoint (the query stays disabled -- and this
 * selector stays pending -- without them).
 */
export function UserSearchableSelector({ value, originalUser, label = "User", onChange, batchSize, ...rest }) {

    const {
        data: users,
        isPending: usersIsPending,
        isError: usersIsError,
        error: usersError
    } = useGetUsersQuery({ orderBy: 'email', batchSize });

    const _onChange = useCallback((selectedValue) => {
        if ( !onChange ) return;
        onChange(selectedValue ? parseInt(selectedValue) : null);
    }, [onChange]);

    const userKeys = users ? users.map(u => u.id.toString()) : [];
    const userDisplayNames = users ? users.map(u => u.email) : [];
    const _currentUser = users && value
        ? (users.find(u => u.id.toString() === value.toString()) || originalUser || null)
        : (originalUser || null);

    return (
        <LabeledSearchableSelector
            label={label}
            value={value ? value.toString() : ''}
            valueDisplayName={_currentUser?.email ?? null}
            optionKeys={userKeys}
            optionDisplayNames={userDisplayNames}
            onChange={_onChange}
            isPending={usersIsPending}
            isError={usersIsError}
            error={usersError}
            placeholder="Select a user ..."
            searchPlaceholder="Search emails ..."
            {...rest}
        />
    );
}

/**
 * Month picker built on the native month input. The exposed `value` is the
 * FIRST of the month as YYYY-MM-DD (the shape the allocation/finalization
 * APIs want -- they accept any date within the month), or null.
 */
export function LabeledMonthInput({ value, onChange, label = "Month", ...rest }) {

    const _onChange = useCallback((inputValue) => {
        if ( !onChange ) return;
        onChange(inputValue ? `${inputValue}-01` : null);
    }, [onChange]);

    return (
        <LabeledTextInput
            label={label}
            type="month"
            value={value ? value.slice(0, 7) : null}
            onChange={_onChange}
            {...rest}
        />
    );
}

/**
 * Picker over the FINALIZED months (for the unfinalize workflow and
 * finalization history views). Options are the month finalization ids;
 * onChange receives the id as a number.
 */
export function MonthFinalizationSelector({ value, label = "Finalized month", onChange, ...rest }) {

    const {
        data: monthFinalizations,
        isPending: monthsIsPending,
        isError: monthsIsError,
        error: monthsError
    } = useGetMonthFinalizationsQuery({ orderBy: 'som_date', orderDirection: 'desc' });

    const _onChange = useCallback((selectedValue) => {
        if ( !onChange ) return;
        onChange(selectedValue ? parseInt(selectedValue) : null);
    }, [onChange]);

    const monthKeys = monthFinalizations ? monthFinalizations.map(m => m.id.toString()) : [];
    const monthDisplayNames = monthFinalizations
        ? monthFinalizations.map(m => <FinalizedBadge value={true} label={m.som_date.slice(0, 7)} />)
        : [];

    return (
        <LabeledSelector
            label={label}
            value={value ? value.toString() : ''}
            optionKeys={monthKeys}
            optionDisplayNames={monthDisplayNames}
            onChange={_onChange}
            isPending={monthsIsPending}
            isError={monthsIsError}
            error={monthsError}
            placeholder="Select a month ..."
            {...rest}
        />
    );
}
