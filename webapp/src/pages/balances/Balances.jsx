import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import dayjs from 'dayjs';

import {
    useGetFundsQuery,
    useGetFundBalancesQuery,
    useProvisionalFrontier,
} from '../../hooks/Queries.jsx';
import { IconButton } from '../../components/Buttons.jsx';
import { DateInput } from '../../components/Inputs.jsx';
import { FundLabel } from '../../components/Badges.jsx';
import { FundTypeIcon } from '../../components/SpecialIcons.jsx';
import { ProvisionalBanner, ProvisionalValue } from '../../components/Provisional.jsx';
import Spinner from '../../components/Spinner.jsx';
import { formatDollars, buildFundTree } from '../../components/domain.js';
import { fundColorVar } from '../../hooks/fundColors.js';
import { parseOnParam, fundRowsOf, sumBalances } from './utils.jsx';
import styles from './Balances.module.css';

export default function Page() {
    const [ searchParams, setSearchParams ] = useSearchParams();

    const today = dayjs().format('YYYY-MM-DD');

    // `?on=` is a permalink to the whole view -- the page IS "every balance on
    // one date" -- so unlike the allocations strip (where the param is only an
    // initial scroll target) it is live state, read and written back on every
    // change. Today is the default, and a default never goes in the URL.
    const on = parseOnParam(searchParams.get('on')) ?? today;
    const isToday = on === today;

    const setOn = useCallback((next) => {
        setSearchParams(prev => {
            const params = new URLSearchParams(prev);
            if ( !next || next === today ) params.delete('on');
            else params.set('on', next);
            return params;
        // Stepping through dates is browsing, not navigation: replace so Back
        // leaves the page instead of unwinding every date the user tried.
        }, { replace: true });
    }, [setSearchParams, today]);

    const fundsQ = useGetFundsQuery();
    const balancesQ = useGetFundBalancesQuery({ on });
    const { som: firstUnfinalizedSom, isPending: frontierPending } = useProvisionalFrontier();

    // buildFundTree applies all three row filters in one pass: TRACKED only,
    // started by `on` (a fund that did not exist yet has no balance to show,
    // and the endpoint omits it anyway), and not deprecated before `on` -- a
    // fund deprecated ON `on` still shows, since that is its last active day.
    const rows = useMemo(
        () => fundRowsOf(buildFundTree(fundsQ.data ?? [], on, on)),
        [fundsQ.data, on]
    );

    const balancesById = useMemo(
        () => new Map((balancesQ.data ?? []).map(b => [ b.fund_id, b.balance ])),
        [balancesQ.data]
    );

    // Every row's own balance -- which is also the total across the ledger,
    // since each fund sits in exactly one root's subtree.
    const total = useMemo(
        () => sumBalances(rows.map(r => r.fund.id), balancesById),
        [rows, balancesById]
    );

    // Read off the response, never derived here: `provisional` is a property of
    // the LEDGER and the requested date rather than of any one fund, so the
    // server sends the same flag on every row.
    const isProvisional = (balancesQ.data ?? []).some(b => b.provisional);

    // The frontier query is part of the gate so the page never renders a
    // provisional figure it cannot yet name a month for.
    const isPending = fundsQ.isPending || balancesQ.isPending || frontierPending;
    const queryError = fundsQ.error ?? balancesQ.error;

    const money = (value) => {
        if ( value == null ) return '';
        const text = formatDollars(value);
        return isProvisional
            ? <ProvisionalValue som={firstUnfinalizedSom}>{text}</ProvisionalValue>
            : text;
    };

    const onLabel = dayjs(on).format('MMM D, YYYY');

    return (
        <div className={styles.page}>
            <div className={styles.topBar}>
                <div className={styles.topBarSide}>
                    <h1 className={styles.pageTitle}>Balances</h1>
                </div>
                <div className={styles.dateControl}>
                    <span className={styles.dateLabel}>on</span>
                    <DateInput
                        value={on}
                        onChange={setOn}
                        isFrozen={false}
                        isRequired
                        displayFormat="MMM D, YYYY"
                        inputTitle="Show every fund's balance on this date"
                    />
                    <IconButton
                        text="Today"
                        icon="fa-arrows-rotate"
                        ariaLabel="Reset to today's balances"
                        title="Reset to today's balances"
                        onClick={() => setOn(today)}
                        disabled={isToday}
                    />
                </div>
                <div className={`${styles.topBarSide} ${styles.topBarRight}`}>
                    <span>Includes every transaction through this date</span>
                </div>
            </div>

            { isProvisional &&
                <ProvisionalBanner som={firstUnfinalizedSom} className={styles.provisionalBanner} />
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
                : <div className={styles.tableScroll}>
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th className={styles.fundTh}>Fund</th>
                                <th className={styles.moneyTh}>Balance</th>
                                <th
                                    className={styles.moneyTh}
                                    title="The fund's balance plus every one of its descendants'"
                                >
                                    With descendants
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr className={styles.totalsRow}>
                                <td className={styles.totalsLabel}>Total</td>
                                <td className={`${styles.moneyCell} ${styles.totalsCell} tabular-nums`}>
                                    {money(total)}
                                </td>
                                <td className={`${styles.moneyCell} ${styles.totalsCell}`} />
                            </tr>
                            { rows.length === 0 &&
                                <tr>
                                    <td className={styles.emptyState} colSpan={3}>
                                        No tracked funds had started by {onLabel}
                                    </td>
                                </tr>
                            }
                            { rows.map(({ fund, depth, subtreeIds, hasChildren }) => {
                                // The fund's tint carries across the whole row, money
                                // columns included: the color IS the row's identity, and
                                // stopping it at the name would read as two tables.
                                const tint = { backgroundColor: fundColorVar(fund.color, 'main') };
                                return (
                                    <tr key={fund.id} className={styles.bodyRow}>
                                        <td
                                            className={`${styles.fundCell}`
                                                + (fund.status.pool ? ` ${styles.poolCell}` : '')}
                                            style={{ ...tint, paddingLeft: `${0.5 + depth * 1.1}rem` }}
                                        >
                                            <FundLabel fund={fund} />
                                            { fund.status.pool &&
                                                <FundTypeIcon
                                                    status={fund.status}
                                                    marginLeft="0.4rem"
                                                    title="Pool — its descendants' allocations are drawn from here"
                                                />
                                            }
                                        </td>
                                        <td className={`${styles.moneyCell} tabular-nums`} style={tint}>
                                            {money(balancesById.get(fund.id) ?? null)}
                                        </td>
                                        <td
                                            className={`${styles.moneyCell} ${styles.rollupCell} tabular-nums`}
                                            style={tint}
                                        >
                                            { hasChildren && money(sumBalances(subtreeIds, balancesById)) }
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            }
        </div>
    );
}
