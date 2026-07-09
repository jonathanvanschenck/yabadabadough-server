import { useCallback } from 'react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';

import { useAuthedFetchJSON, useAuthedFetchAllJSON, parseURL, APIError, useAuthRoles } from '../contexts/AuthContext.jsx';
import { QK } from './queryKeys.js';

/**
 * All server communication is localized in this one file: pages and
 * components never call fetch/useQuery/useMutation directly.
 *
 * Query keys come from the shared server registry (see ./queryKeys.js) --
 * NEVER inline key literals. List hooks append their (snake_case) filter
 * object to the registry's list key ([ ...QK.funds, searchObj ]), which the
 * server's prefix invalidation of the bare list key still catches.
 *
 * Cache invalidation is server-driven, twice over:
 *  - every write response carries `{ data, invalidations }`, applied to the
 *    queryClient immediately by the shared mutation wrapper below, and
 *  - the server broadcasts the same actions to every connected client over
 *    socket.io (see SocketIOContext), which is what keeps OTHER clients (and
 *    this one, redundantly) fresh.
 * So mutation hooks never hand-roll invalidateQueries calls.
 */

function purgeUndefinedValues(obj) {
    return Object.fromEntries(Object.entries(obj).filter(([_, v]) => v !== undefined));
}

function standardizeIdStr(id) {
    if ( !id ) return null;
    const intId = parseInt(id, 10);
    return isNaN(intId) ? null : intId.toString();
}

/**
 * Apply a write response's `invalidations` array (the server's
 * `{ type: "invalidate"|"remove", key, exact? }` action shape) to the
 * tanstack-query cache.
 */
function useApplyInvalidations() {
    const queryClient = useQueryClient();
    return useCallback((invalidations = []) => {
        for ( const { type, key, exact } of invalidations ?? [] ) {
            switch ( type ) {
                case "invalidate":
                    queryClient.invalidateQueries({ queryKey: key, exact });
                    break;
                case "remove":
                    queryClient.removeQueries({ queryKey: key, exact });
                    break;
                default:
                    // Unknown action types are ignored (forward compatibility)
                    break;
            }
        }
    }, [ queryClient ]);
}


export function useVersionQuery(options = {}) {
    const fetchJSON = useAuthedFetchJSON();
    return useQuery({
        queryKey: QK.versions,
        queryFn: () => fetchJSON('/api/utils/versions', { method: 'GET' }),
        ...options,
    });
}

/**
 * QUERY BASED QUERIES: (use[...]Query)
 *
 * All of these hooks return the same object as from useQuery, but set the
 * queryKey and queryFn internally, so as to standardize the usage of these
 * queries across the app. Hook params are camelCase and are converted to the
 * API's snake_case at this boundary. `options` is spread into useQuery last,
 * so callers can override anything.
 */

// ---------------------------------------------------------------------------
// Funds
// ---------------------------------------------------------------------------

export function useGetFundsQuery(
    {
        batchSize = 500,
        ids,
        name,
        nameLike,
        startedSince,
        startedUntil,
        tracked,
        monthly,
        pool,
        root,
        descendantOf,
        orderBy,
        orderDirection
    }={},
    options={}
) {
    const fetchAll = useAuthedFetchAllJSON();

    const searchObj = purgeUndefinedValues({
        ids: Array.isArray(ids) ? ids.join(",") : ids,
        name: name,
        name_like: nameLike,
        started_since: startedSince,
        started_until: startedUntil,
        tracked: tracked,
        monthly: monthly,
        pool: pool,
        root: root,
        descendant_of: descendantOf,
        order_by: orderBy,
        order_direction: orderDirection,
    });

    return useQuery({
        queryKey: [ ...QK.funds, searchObj ], // NOTE doesn't include batchSize, since it doesn't affect *what* is fetched only *how*
        queryFn: async () => {
            const url = parseURL({
                path: "/api/funds/funds",
                search: searchObj
            });
            return await fetchAll(url, { method: 'GET', batchSize: batchSize });
        },
        ...options
    });
}

export function useGetFundQuery(
    id,
    {
        enabled = true,
        ...options
    }={}
) {
    const fetch = useAuthedFetchJSON();

    const idStr = standardizeIdStr(id);

    return useQuery({
        queryKey: QK.fund(idStr ?? "?"),
        queryFn: async () => {
            const url = '/api/funds/fund/' + encodeURIComponent(idStr);
            return await fetch(url, { method: 'GET' });
        },
        enabled: enabled && !!idStr,
        ...options
    });
}

/**
 * A fund's calculated balance: the current one, or -- with `on` (YYYY-MM-DD)
 * -- the balance on that date. Every transaction write invalidates the
 * ["fund-balance"] prefix, so these refetch on any money movement.
 */
export function useGetFundBalanceQuery(
    id,
    { on }={},
    {
        enabled = true,
        ...options
    }={}
) {
    const fetch = useAuthedFetchJSON();

    const idStr = standardizeIdStr(id);
    const searchObj = purgeUndefinedValues({ on });

    return useQuery({
        queryKey: [ ...QK.fund_balance(idStr ?? "?"), searchObj ],
        queryFn: async () => {
            const url = parseURL({
                path: '/api/funds/fund/' + encodeURIComponent(idStr) + '/balance',
                search: searchObj
            });
            return await fetch(url, { method: 'GET' });
        },
        enabled: enabled && !!idStr,
        ...options
    });
}

/**
 * Every tracked fund's balance in one response (the bulk companion to the
 * per-fund balance hook). Funds that had not started by `on` are omitted.
 */
export function useGetFundBalancesQuery(
    { on }={},
    options={}
) {
    const fetch = useAuthedFetchJSON();

    const searchObj = purgeUndefinedValues({ on });

    return useQuery({
        queryKey: [ ...QK.fund_balances, "all", searchObj ],
        queryFn: async () => {
            const url = parseURL({
                path: "/api/funds/balances",
                search: searchObj
            });
            return await fetch(url, { method: 'GET' });
        },
        ...options
    });
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export function useGetTransactionGroupsQuery(
    {
        batchSize = 500,
        since,
        until,
        split,
        allocation,
        eomCleanup,
        hasStatements,
        descriptionLike,
        orderBy,
        orderDirection
    }={},
    options={}
) {
    const fetchAll = useAuthedFetchAllJSON();

    const searchObj = purgeUndefinedValues({
        since: since,
        until: until,
        split: split,
        allocation: allocation,
        eom_cleanup: eomCleanup,
        has_statements: hasStatements,
        description_like: descriptionLike,
        order_by: orderBy,
        order_direction: orderDirection,
    });

    return useQuery({
        queryKey: [ ...QK.transaction_groups, searchObj ], // NOTE doesn't include batchSize, since it doesn't affect *what* is fetched only *how*
        queryFn: async () => {
            const url = parseURL({
                path: "/api/transactions/transaction-groups",
                search: searchObj
            });
            return await fetchAll(url, { method: 'GET', batchSize: batchSize });
        },
        ...options
    });
}

export function useGetTransactionGroupQuery(
    id,
    {
        enabled = true,
        ...options
    }={}
) {
    const fetch = useAuthedFetchJSON();

    const idStr = standardizeIdStr(id);

    return useQuery({
        queryKey: QK.transaction_group(idStr ?? "?"),
        queryFn: async () => {
            const url = '/api/transactions/transaction-group/' + encodeURIComponent(idStr);
            return await fetch(url, { method: 'GET' });
        },
        enabled: enabled && !!idStr,
        ...options
    });
}

export function useGetTransactionsQuery(
    {
        batchSize = 500,
        sourceFundId,
        targetFundId,
        involvingFundId,
        groupId,
        since,
        until,
        allocation,
        descriptionLike,
        orderBy,
        orderDirection
    }={},
    options={}
) {
    const fetchAll = useAuthedFetchAllJSON();

    const searchObj = purgeUndefinedValues({
        source_fund_id: sourceFundId,
        target_fund_id: targetFundId,
        involving_fund_id: involvingFundId,
        group_id: groupId,
        since: since,
        until: until,
        allocation: allocation,
        description_like: descriptionLike,
        order_by: orderBy,
        order_direction: orderDirection,
    });

    return useQuery({
        queryKey: [ ...QK.transactions, searchObj ], // NOTE doesn't include batchSize, since it doesn't affect *what* is fetched only *how*
        queryFn: async () => {
            const url = parseURL({
                path: "/api/transactions/transactions",
                search: searchObj
            });
            return await fetchAll(url, { method: 'GET', batchSize: batchSize });
        },
        ...options
    });
}

export function useGetTransactionQuery(
    id,
    {
        enabled = true,
        ...options
    }={}
) {
    const fetch = useAuthedFetchJSON();

    const idStr = standardizeIdStr(id);

    return useQuery({
        queryKey: QK.transaction(idStr ?? "?"),
        queryFn: async () => {
            const url = '/api/transactions/transaction/' + encodeURIComponent(idStr);
            return await fetch(url, { method: 'GET' });
        },
        enabled: enabled && !!idStr,
        ...options
    });
}

// ---------------------------------------------------------------------------
// Bank statements
// ---------------------------------------------------------------------------

export function useGetStatementsQuery(
    {
        batchSize = 500,
        source,
        since,
        until,
        state, // "pending" | "ignored" | "reconciled" (shorthand for the raw flags)
        ignored,
        hasGroup,
        groupId,
        orderBy,
        orderDirection
    }={},
    options={}
) {
    const fetchAll = useAuthedFetchAllJSON();

    const searchObj = purgeUndefinedValues({
        source: source,
        since: since,
        until: until,
        state: state,
        ignored: ignored,
        has_group: hasGroup,
        group_id: groupId,
        order_by: orderBy,
        order_direction: orderDirection,
    });

    return useQuery({
        queryKey: [ ...QK.statements, searchObj ], // NOTE doesn't include batchSize, since it doesn't affect *what* is fetched only *how*
        queryFn: async () => {
            const url = parseURL({
                path: "/api/statements/statements",
                search: searchObj
            });
            return await fetchAll(url, { method: 'GET', batchSize: batchSize });
        },
        ...options
    });
}

export function useGetStatementQuery(
    id,
    {
        enabled = true,
        ...options
    }={}
) {
    const fetch = useAuthedFetchJSON();

    const idStr = standardizeIdStr(id);

    return useQuery({
        queryKey: QK.statement(idStr ?? "?"),
        queryFn: async () => {
            const url = '/api/statements/statement/' + encodeURIComponent(idStr);
            return await fetch(url, { method: 'GET' });
        },
        enabled: enabled && !!idStr,
        ...options
    });
}

// ---------------------------------------------------------------------------
// Allocations
// ---------------------------------------------------------------------------

/**
 * Allocations, in the endpoint's two modes (exactly one of month/fundId):
 * `month` (any YYYY-MM-DD within it) returns every allocation for that
 * month; `fundId` returns the fund's allocation history (optionally bounded
 * by since/until, newest first). The query is disabled unless exactly one
 * mode is selected.
 */
export function useGetAllocationsQuery(
    {
        month,
        fundId,
        since,
        until,
        orderDirection
    }={},
    {
        enabled = true,
        ...options
    }={}
) {
    const fetch = useAuthedFetchJSON();

    const fundIdStr = standardizeIdStr(fundId);
    const searchObj = purgeUndefinedValues({
        month: month,
        fund_id: fundIdStr ?? undefined,
        since: since,
        until: until,
        order_direction: orderDirection,
    });

    return useQuery({
        queryKey: [ ...QK.allocations, searchObj ],
        queryFn: async () => {
            const url = parseURL({
                path: "/api/allocations/allocations",
                search: searchObj
            });
            return await fetch(url, { method: 'GET' });
        },
        enabled: enabled && (!!month !== !!fundIdStr),
        ...options
    });
}

// ---------------------------------------------------------------------------
// Finalizations
// ---------------------------------------------------------------------------

export function useGetMonthFinalizationsQuery(
    {
        batchSize = 500,
        since,
        until,
        orderBy,
        orderDirection
    }={},
    options={}
) {
    const fetchAll = useAuthedFetchAllJSON();

    const searchObj = purgeUndefinedValues({
        since: since,
        until: until,
        order_by: orderBy,
        order_direction: orderDirection,
    });

    return useQuery({
        queryKey: [ ...QK.month_finalizations, searchObj ], // NOTE doesn't include batchSize, since it doesn't affect *what* is fetched only *how*
        queryFn: async () => {
            const url = parseURL({
                path: "/api/finalizations/month-finalizations",
                search: searchObj
            });
            return await fetchAll(url, { method: 'GET', batchSize: batchSize });
        },
        ...options
    });
}

/**
 * The most recent finalized month, or null when nothing has been finalized
 * yet (a normal state, not an error).
 */
export function useGetLatestMonthFinalizationQuery(options={}) {
    const fetch = useAuthedFetchJSON();

    return useQuery({
        queryKey: [ ...QK.month_finalizations, "latest" ],
        queryFn: async () => {
            return await fetch("/api/finalizations/month-finalizations/latest", { method: 'GET' });
        },
        ...options
    });
}

export function useGetMonthFinalizationQuery(
    id,
    {
        enabled = true,
        ...options
    }={}
) {
    const fetch = useAuthedFetchJSON();

    const idStr = standardizeIdStr(id);

    return useQuery({
        queryKey: QK.month_finalization(idStr ?? "?"),
        queryFn: async () => {
            const url = '/api/finalizations/month-finalization/' + encodeURIComponent(idStr);
            return await fetch(url, { method: 'GET' });
        },
        enabled: enabled && !!idStr,
        ...options
    });
}

export function useGetFundFinalizationsQuery(
    {
        batchSize = 500,
        fundId,
        monthId,
        since,
        until,
        orderBy,
        orderDirection
    }={},
    options={}
) {
    const fetchAll = useAuthedFetchAllJSON();

    const searchObj = purgeUndefinedValues({
        fund_id: fundId,
        month_id: monthId,
        since: since,
        until: until,
        order_by: orderBy,
        order_direction: orderDirection,
    });

    return useQuery({
        queryKey: [ ...QK.fund_finalizations, searchObj ], // NOTE doesn't include batchSize, since it doesn't affect *what* is fetched only *how*
        queryFn: async () => {
            const url = parseURL({
                path: "/api/finalizations/fund-finalizations",
                search: searchObj
            });
            return await fetchAll(url, { method: 'GET', batchSize: batchSize });
        },
        ...options
    });
}

export function useGetFundFinalizationQuery(
    id,
    {
        enabled = true,
        ...options
    }={}
) {
    const fetch = useAuthedFetchJSON();

    const idStr = standardizeIdStr(id);

    return useQuery({
        queryKey: QK.fund_finalization(idStr ?? "?"),
        queryFn: async () => {
            const url = '/api/finalizations/fund-finalization/' + encodeURIComponent(idStr);
            return await fetch(url, { method: 'GET' });
        },
        enabled: enabled && !!idStr,
        ...options
    });
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * List users -- ADMIN ONLY: the endpoint requires the admin role plus the
 * X-Sudo-Mode header, so the query only runs while sudo mode is active
 * (roles.admin); otherwise it stays disabled instead of 403ing.
 */
export function useGetUsersQuery(
    {
        batchSize = 500,
        admin,
        reader,
        editor,
        orderBy,
        orderDirection
    }={},
    {
        enabled = true,
        ...options
    }={}
) {
    const fetchAll = useAuthedFetchAllJSON();
    const roles = useAuthRoles();

    const searchObj = purgeUndefinedValues({
        admin: admin,
        reader: reader,
        editor: editor,
        order_by: orderBy,
        order_direction: orderDirection,
    });

    return useQuery({
        queryKey: [ ...QK.users, searchObj ], // NOTE doesn't include batchSize, since it doesn't affect *what* is fetched only *how*
        queryFn: async () => {
            const url = parseURL({
                path: "/api/users/users",
                search: searchObj
            });
            return await fetchAll(url, { method: 'GET', batchSize: batchSize });
        },
        enabled: enabled && !!roles.admin,
        ...options
    });
}

/**
 * Get a user FRESH from the database (the access token's roles may be up to
 * ~20m stale). Self-or-admin: your own id (from useAuth().userId) needs no
 * role; anyone else's requires active sudo mode and reads as 404 without it.
 */
export function useGetUserQuery(
    id,
    {
        enabled = true,
        ...options
    }={}
) {
    const fetch = useAuthedFetchJSON();

    const idStr = standardizeIdStr(id);

    return useQuery({
        queryKey: QK.user(idStr ?? "?"),
        queryFn: async () => {
            const url = '/api/users/user/' + encodeURIComponent(idStr);
            return await fetch(url, { method: 'GET' });
        },
        enabled: enabled && !!idStr,
        ...options
    });
}

/**
 * A user's login sessions (self-or-admin, like useGetUserQuery).
 */
export function useGetUserSessionsQuery(
    userId,
    {
        batchSize = 500,
        active,
        orderBy,
        orderDirection
    }={},
    {
        enabled = true,
        ...options
    }={}
) {
    const fetchAll = useAuthedFetchAllJSON();

    const idStr = standardizeIdStr(userId);
    const searchObj = purgeUndefinedValues({
        active: active,
        order_by: orderBy,
        order_direction: orderDirection,
    });

    return useQuery({
        queryKey: [ ...QK.user_sessions(idStr ?? "?"), searchObj ], // NOTE doesn't include batchSize, since it doesn't affect *what* is fetched only *how*
        queryFn: async () => {
            const url = parseURL({
                path: '/api/users/user/' + encodeURIComponent(idStr) + '/sessions',
                search: searchObj
            });
            return await fetchAll(url, { method: 'GET', batchSize: batchSize });
        },
        enabled: enabled && !!idStr,
        ...options
    });
}

/**
 * A user's API keys (self-or-admin, like useGetUserQuery). Expired keys stay
 * listed unless filtered with `active`; secrets are never re-shown.
 */
export function useGetUserApiKeysQuery(
    userId,
    {
        batchSize = 500,
        active,
        orderBy,
        orderDirection
    }={},
    {
        enabled = true,
        ...options
    }={}
) {
    const fetchAll = useAuthedFetchAllJSON();

    const idStr = standardizeIdStr(userId);
    const searchObj = purgeUndefinedValues({
        active: active,
        order_by: orderBy,
        order_direction: orderDirection,
    });

    return useQuery({
        queryKey: [ ...QK.user_api_keys(idStr ?? "?"), searchObj ], // NOTE doesn't include batchSize, since it doesn't affect *what* is fetched only *how*
        queryFn: async () => {
            const url = parseURL({
                path: '/api/users/user/' + encodeURIComponent(idStr) + '/api-keys',
                search: searchObj
            });
            return await fetchAll(url, { method: 'GET', batchSize: batchSize });
        },
        enabled: enabled && !!idStr,
        ...options
    });
}


/**
 * MUTATION BASED QUERIES: (use[...]Mutation)
 *
 * All of these hooks return the same mutation object as from useMutation.
 * Callers invoke `mutate(mutateData, { onSuccess, onError })` (or
 * `mutateAsync` when a promise is needed, e.g. for a confirmation modal that
 * handles errors itself).
 *
 * The `formData` convention: `mutateData` MUST contain a `formData` key
 * holding the payload, with snake_case keys matching the API. Only formData
 * is used by the mutation internals; any other keys pass through untouched
 * to caller callbacks -- though prefer capturing values via closure in the
 * calling handler over stuffing them into mutateData.
 *
 * Every write endpoint responds `{ data, invalidations }`; the shared
 * wrapper below applies those invalidations to the query cache in onSuccess,
 * BEFORE caller callbacks run (per the useMutation docs, mutate()-level
 * callbacks fire after hook-level ones). The server also broadcasts the same
 * actions over socket.io, so no mutation hook hand-rolls invalidation.
 *
 * Client-side role guards mirror the server's gates so obviously-doomed
 * requests fail fast and uniformly: editor for data writes, active sudo mode
 * (roles.admin) for user management. Self-or-admin user routes (password,
 * own sessions/api-keys) deliberately have NO local guard -- any authed user
 * may act on themselves.
 */


function throwLocal403EditorError() {
    const err = new APIError(403);
    err.add_details({ message: "User lacks 'editor' role required to perform this action" });
    throw err;
}

function throwLocal403AdminError() {
    const err = new APIError(403);
    err.add_details({ message: "User management requires admin rights with sudo mode active" });
    throw err;
}

/**
 * The shared mutation wrapper: useMutation plus the apply-the-response's-
 * invalidations onSuccess handler described above.
 *
 * WARNING (for mutationFns): remember to pass any variables needed in the
 * mutationFn via the mutate() call to prevent stale closures.
 */
function useInvalidatingMutation(mutationFn) {
    const applyInvalidations = useApplyInvalidations();
    return useMutation({
        mutationFn,
        onSuccess: (result) => applyInvalidations(result?.invalidations),
    });
}

// ---------------------------------------------------------------------------
// Funds
// ---------------------------------------------------------------------------

/**
 * Create a new Fund
 *
 * @typedef {object} PostFundMutationData
 * @property {object} formData - The payload (snake_case, matching the API)
 * @property {string} formData.name
 * @property {boolean} formData.tracked
 * @property {boolean} [formData.monthly] - Requires tracked, a parent, and a pool ancestor
 * @property {boolean} [formData.pool] - Requires tracked; excludes monthly
 * @property {number|null} [formData.parent_id]
 * @property {string|null} [formData.start_date] - YYYY-MM-DD; required (non-null) when tracked
 * @property {number|null} [formData.start_balance] - Float dollars; required (non-null) when tracked
 * @property {string|null} [formData.color]
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function usePostFundMutation() {
    const fetch = useAuthedFetchJSON();
    const roles = useAuthRoles();
    return useInvalidatingMutation(async ({ formData }) => {
        if ( !roles.editor ) throwLocal403EditorError();
        return await fetch("/api/funds/funds", {
            method: 'POST',
            body: formData
        });
    });
}

/**
 * Patch a Fund (only the included fields are updated; history-affecting
 * fields 409 while finalizations exist)
 *
 * @typedef {object} PatchFundMutationData
 * @property {object} formData - The payload (snake_case, matching the API)
 * @property {number} formData.id - The fund ID
 * @property {string} [formData.name]
 * @property {boolean} [formData.tracked]
 * @property {boolean} [formData.monthly]
 * @property {boolean} [formData.pool]
 * @property {number|null} [formData.parent_id]
 * @property {string|null} [formData.start_date]
 * @property {number|null} [formData.start_balance]
 * @property {string|null} [formData.color]
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function usePatchFundMutation() {
    const fetch = useAuthedFetchJSON();
    const roles = useAuthRoles();
    return useInvalidatingMutation(async ({ formData }) => {
        if ( !roles.editor ) throwLocal403EditorError();
        const { id, ...body } = formData;
        return await fetch("/api/funds/fund/" + encodeURIComponent(id), {
            method: 'PATCH',
            body
        });
    });
}

/**
 * Delete a Fund (409 while any finalizations exist for it)
 *
 * @typedef {object} DeleteFundMutationData
 * @property {object} formData
 * @property {number} formData.id - The fund ID
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function useDeleteFundMutation() {
    const fetch = useAuthedFetchJSON();
    const roles = useAuthRoles();
    return useInvalidatingMutation(async ({ formData }) => {
        if ( !roles.editor ) throwLocal403EditorError();
        return await fetch("/api/funds/fund/" + encodeURIComponent(formData.id), {
            method: 'DELETE'
        });
    });
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * Create a Transaction Group (one transaction = an ordinary expense or
 * transfer, several = a split)
 *
 * @typedef {object} TransactionSpec
 * @property {number} source_fund_id
 * @property {number} target_fund_id
 * @property {number} amount - Float dollars; strictly positive
 * @property {string} description
 * @property {string|null} [note]
 *
 * @typedef {object} PostTransactionGroupMutationData
 * @property {object} formData - The payload (snake_case, matching the API)
 * @property {string} formData.date - YYYY-MM-DD
 * @property {string} formData.description
 * @property {string|null} [formData.note]
 * @property {TransactionSpec[]} formData.transactions - At least one
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function usePostTransactionGroupMutation() {
    const fetch = useAuthedFetchJSON();
    const roles = useAuthRoles();
    return useInvalidatingMutation(async ({ formData }) => {
        if ( !roles.editor ) throwLocal403EditorError();
        return await fetch("/api/transactions/transaction-groups", {
            method: 'POST',
            body: formData
        });
    });
}

/**
 * Create a Transaction Group reconciling pending bank statement items (one
 * id normally; both sides' ids for a transfer between imported accounts)
 *
 * @typedef {object} PostTransactionGroupFromStatementsMutationData
 * @property {object} formData - The payload (snake_case, matching the API)
 * @property {number[]} formData.statement_ids - The pending items to reconcile
 * @property {string|null} [formData.date] - Defaults to the latest item date
 * @property {string|null} [formData.description] - Defaults to the items' notes
 * @property {string|null} [formData.note]
 * @property {TransactionSpec[]} formData.transactions - At least one
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function usePostTransactionGroupFromStatementsMutation() {
    const fetch = useAuthedFetchJSON();
    const roles = useAuthRoles();
    return useInvalidatingMutation(async ({ formData }) => {
        if ( !roles.editor ) throwLocal403EditorError();
        return await fetch("/api/transactions/transaction-groups/from-statements", {
            method: 'POST',
            body: formData
        });
    });
}

/**
 * Patch a Transaction Group's scalar fields (description/note/date). The
 * group id is stable, so bank statement reconciliation survives -- prefer
 * this over delete-and-recreate. Allocation/eom_cleanup groups 409.
 *
 * @typedef {object} PatchTransactionGroupMutationData
 * @property {object} formData - The payload (snake_case, matching the API)
 * @property {number} formData.id - The transaction group ID
 * @property {string} [formData.description]
 * @property {string|null} [formData.note]
 * @property {string} [formData.date] - YYYY-MM-DD; cascades to every transaction in the group
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function usePatchTransactionGroupMutation() {
    const fetch = useAuthedFetchJSON();
    const roles = useAuthRoles();
    return useInvalidatingMutation(async ({ formData }) => {
        if ( !roles.editor ) throwLocal403EditorError();
        const { id, ...body } = formData;
        return await fetch("/api/transactions/transaction-group/" + encodeURIComponent(id), {
            method: 'PATCH',
            body
        });
    });
}

/**
 * Edit a Transaction Group's transactions in one atomic batch (add / update
 * in place / remove). The group must keep at least one transaction -- to
 * empty it, delete the group instead.
 *
 * @typedef {object} TransactionUpdateSpec
 * @property {number} id - A transaction belonging to this group
 * @property {number} [source_fund_id]
 * @property {number} [target_fund_id]
 * @property {number} [amount] - Float dollars; strictly positive
 * @property {string} [description]
 * @property {string|null} [note]
 *
 * @typedef {object} PatchTransactionGroupTransactionsMutationData
 * @property {object} formData - The payload (snake_case, matching the API)
 * @property {number} formData.id - The transaction group ID
 * @property {TransactionSpec[]} [formData.add] - New transactions (dated the group's date)
 * @property {TransactionUpdateSpec[]} [formData.update] - In-place edits
 * @property {number[]} [formData.remove] - Ids of transactions (in this group) to delete
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function usePatchTransactionGroupTransactionsMutation() {
    const fetch = useAuthedFetchJSON();
    const roles = useAuthRoles();
    return useInvalidatingMutation(async ({ formData }) => {
        if ( !roles.editor ) throwLocal403EditorError();
        const { id, ...body } = formData;
        return await fetch("/api/transactions/transaction-group/" + encodeURIComponent(id) + "/transactions", {
            method: 'PATCH',
            body
        });
    });
}

/**
 * Delete a Transaction Group and all of its transactions (the only way to
 * unlink reconciled bank statement items, which are released back to
 * pending). Finalized months and allocation groups 409.
 *
 * @typedef {object} DeleteTransactionGroupMutationData
 * @property {object} formData
 * @property {number} formData.id - The transaction group ID
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function useDeleteTransactionGroupMutation() {
    const fetch = useAuthedFetchJSON();
    const roles = useAuthRoles();
    return useInvalidatingMutation(async ({ formData }) => {
        if ( !roles.editor ) throwLocal403EditorError();
        return await fetch("/api/transactions/transaction-group/" + encodeURIComponent(formData.id), {
            method: 'DELETE'
        });
    });
}

/**
 * Patch a single Transaction in place (amount, funds, description, note).
 * `date` is a group-level fact: change it via usePatchTransactionGroupMutation.
 *
 * @typedef {object} PatchTransactionMutationData
 * @property {object} formData - The payload (snake_case, matching the API)
 * @property {number} formData.id - The transaction ID
 * @property {number} [formData.amount] - Float dollars; strictly positive
 * @property {number} [formData.source_fund_id]
 * @property {number} [formData.target_fund_id]
 * @property {string} [formData.description]
 * @property {string|null} [formData.note]
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function usePatchTransactionMutation() {
    const fetch = useAuthedFetchJSON();
    const roles = useAuthRoles();
    return useInvalidatingMutation(async ({ formData }) => {
        if ( !roles.editor ) throwLocal403EditorError();
        const { id, ...body } = formData;
        return await fetch("/api/transactions/transaction/" + encodeURIComponent(id), {
            method: 'PATCH',
            body
        });
    });
}

// ---------------------------------------------------------------------------
// Bank statements
// ---------------------------------------------------------------------------

/**
 * Import Bank Statement Items (idempotent bulk re-sync: existing (source,
 * key) rows are skipped, never updated)
 *
 * @typedef {object} StatementImportItem
 * @property {string} source - Which bank this line came from
 * @property {string} key - Bank-scoped dedupe key
 * @property {number} amount - Signed float dollars (negative = money leaving the account)
 * @property {string} date - YYYY-MM-DD
 * @property {string|null} [note]
 *
 * @typedef {object} PostImportStatementsMutationData
 * @property {object} formData
 * @property {StatementImportItem[]} formData.items - At least one
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function usePostImportStatementsMutation() {
    const fetch = useAuthedFetchJSON();
    const roles = useAuthRoles();
    return useInvalidatingMutation(async ({ formData }) => {
        if ( !roles.editor ) throwLocal403EditorError();
        return await fetch("/api/statements/statements/import", {
            method: 'POST',
            body: formData
        });
    });
}

/**
 * Patch a Bank Statement Item's ignored flag and/or note -- the only mutable
 * fields (bank facts are immutable). Use ignored to hide items, NOT deletion.
 *
 * @typedef {object} PatchStatementMutationData
 * @property {object} formData - The payload (snake_case, matching the API)
 * @property {number} formData.id - The bank statement item ID
 * @property {boolean} [formData.ignored]
 * @property {string|null} [formData.note]
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function usePatchStatementMutation() {
    const fetch = useAuthedFetchJSON();
    const roles = useAuthRoles();
    return useInvalidatingMutation(async ({ formData }) => {
        if ( !roles.editor ) throwLocal403EditorError();
        const { id, ...body } = formData;
        return await fetch("/api/statements/statement/" + encodeURIComponent(id), {
            method: 'PATCH',
            body
        });
    });
}

/**
 * Delete a Bank Statement Item -- and, with with_group (the DEFAULT), the
 * transaction group reconciling it. WARNING (by design, see the API docs):
 * deletion is for undoing bad imports, not hiding items; the item reappears
 * as pending on the next re-sync, so reconciling it again double-counts.
 *
 * @typedef {object} DeleteStatementMutationData
 * @property {object} formData
 * @property {number} formData.id - The bank statement item ID
 * @property {boolean} [formData.with_group] - Also delete the reconciling group (default true)
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function useDeleteStatementMutation() {
    const fetch = useAuthedFetchJSON();
    const roles = useAuthRoles();
    return useInvalidatingMutation(async ({ formData }) => {
        if ( !roles.editor ) throwLocal403EditorError();
        const url = parseURL({
            path: "/api/statements/statement/" + encodeURIComponent(formData.id),
            search: { with_group: formData.with_group }
        });
        return await fetch(url, { method: 'DELETE' });
    });
}

// ---------------------------------------------------------------------------
// Allocations
// ---------------------------------------------------------------------------

/**
 * Set (create-or-replace) a fund's allocation for a month: a transfer of
 * `amount` from the fund's nearest pool ancestor, dated the first of the
 * month. Finalized months 409.
 *
 * @typedef {object} PutAllocationMutationData
 * @property {object} formData - The payload (snake_case, matching the API)
 * @property {string} formData.month - Any YYYY-MM-DD within the target month
 * @property {number} formData.fund_id
 * @property {number} formData.amount - Float dollars; strictly positive (remove instead of zeroing)
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function usePutAllocationMutation() {
    const fetch = useAuthedFetchJSON();
    const roles = useAuthRoles();
    return useInvalidatingMutation(async ({ formData }) => {
        if ( !roles.editor ) throwLocal403EditorError();
        return await fetch("/api/allocations/allocations", {
            method: 'PUT',
            body: formData
        });
    });
}

/**
 * Remove a fund's allocation for a month. Finalized months 409; a missing
 * allocation is a 404.
 *
 * @typedef {object} DeleteAllocationMutationData
 * @property {object} formData
 * @property {string} formData.month - Any YYYY-MM-DD within the target month
 * @property {number} formData.fund_id
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function useDeleteAllocationMutation() {
    const fetch = useAuthedFetchJSON();
    const roles = useAuthRoles();
    return useInvalidatingMutation(async ({ formData }) => {
        if ( !roles.editor ) throwLocal403EditorError();
        const url = parseURL({
            path: "/api/allocations/allocations",
            search: { month: formData.month, fund_id: formData.fund_id }
        });
        return await fetch(url, { method: 'DELETE' });
    });
}

/**
 * Copy every allocation from one month into another (the "same budget as
 * last month" workflow), atomically.
 *
 * @typedef {object} PostCopyAllocationsMutationData
 * @property {object} formData - The payload (snake_case, matching the API)
 * @property {string} formData.from - Source month (any YYYY-MM-DD within it)
 * @property {string} formData.to - Target month (any YYYY-MM-DD within it)
 * @property {"error"|"merge"|"overwrite"} [formData.on_conflict] - Funds already allocated in the target (default error)
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function usePostCopyAllocationsMutation() {
    const fetch = useAuthedFetchJSON();
    const roles = useAuthRoles();
    return useInvalidatingMutation(async ({ formData }) => {
        if ( !roles.editor ) throwLocal403EditorError();
        return await fetch("/api/allocations/allocations/copy", {
            method: 'POST',
            body: formData
        });
    });
}

// ---------------------------------------------------------------------------
// Finalizations
// ---------------------------------------------------------------------------

/**
 * Finalize a month (recording end-of-month balances and zeroing monthly
 * funds back into their pools). Months finalize contiguously, oldest first
 * -- `recursive` auto-finalizes intervening months.
 *
 * @typedef {object} PostMonthFinalizationMutationData
 * @property {object} formData - The payload (snake_case, matching the API)
 * @property {string} formData.month - Any YYYY-MM-DD within the month to finalize
 * @property {boolean} [formData.recursive] - Auto-finalize intervening months (default false)
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function usePostMonthFinalizationMutation() {
    const fetch = useAuthedFetchJSON();
    const roles = useAuthRoles();
    return useInvalidatingMutation(async ({ formData }) => {
        if ( !roles.editor ) throwLocal403EditorError();
        return await fetch("/api/finalizations/month-finalizations", {
            method: 'POST',
            body: formData
        });
    });
}

/**
 * Unfinalize a month (strictly LIFO: only the LATEST finalized month, 409
 * otherwise).
 *
 * @typedef {object} DeleteMonthFinalizationMutationData
 * @property {object} formData
 * @property {number} formData.id - The month finalization ID
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function useDeleteMonthFinalizationMutation() {
    const fetch = useAuthedFetchJSON();
    const roles = useAuthRoles();
    return useInvalidatingMutation(async ({ formData }) => {
        if ( !roles.editor ) throwLocal403EditorError();
        return await fetch("/api/finalizations/month-finalization/" + encodeURIComponent(formData.id), {
            method: 'DELETE'
        });
    });
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * Create a new User (admin only; sudo mode must be active)
 *
 * @typedef {object} PostUserMutationData
 * @property {object} formData - The payload (snake_case, matching the API)
 * @property {string} formData.email
 * @property {string} formData.password - Min 8 chars
 * @property {boolean} [formData.admin]
 * @property {boolean} [formData.reader] - Granted by default
 * @property {boolean} [formData.editor]
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function usePostUserMutation() {
    const fetch = useAuthedFetchJSON();
    const roles = useAuthRoles();
    return useInvalidatingMutation(async ({ formData }) => {
        if ( !roles.admin ) throwLocal403AdminError();
        return await fetch("/api/users/users", {
            method: 'POST',
            body: formData
        });
    });
}

/**
 * Patch a User's email and/or explicitly-granted role flags (admin only;
 * sudo mode must be active). Passwords change via usePostUserPasswordMutation.
 *
 * @typedef {object} PatchUserMutationData
 * @property {object} formData - The payload (snake_case, matching the API)
 * @property {number} formData.id - The user ID
 * @property {string} [formData.email]
 * @property {boolean} [formData.admin]
 * @property {boolean} [formData.reader]
 * @property {boolean} [formData.editor]
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function usePatchUserMutation() {
    const fetch = useAuthedFetchJSON();
    const roles = useAuthRoles();
    return useInvalidatingMutation(async ({ formData }) => {
        if ( !roles.admin ) throwLocal403AdminError();
        const { id, ...body } = formData;
        return await fetch("/api/users/user/" + encodeURIComponent(id), {
            method: 'PATCH',
            body
        });
    });
}

/**
 * Delete a User (admin only; sudo mode must be active). Self-deletion is
 * refused by the server.
 *
 * @typedef {object} DeleteUserMutationData
 * @property {object} formData
 * @property {number} formData.id - The user ID
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function useDeleteUserMutation() {
    const fetch = useAuthedFetchJSON();
    const roles = useAuthRoles();
    return useInvalidatingMutation(async ({ formData }) => {
        if ( !roles.admin ) throwLocal403AdminError();
        return await fetch("/api/users/user/" + encodeURIComponent(formData.id), {
            method: 'DELETE'
        });
    });
}

/**
 * Set a User's password. Self-or-admin with split semantics: changing your
 * OWN password requires current_password (no local role guard); with sudo
 * mode active it is an administrative reset and current_password is not
 * required. By default every one of the TARGET's sessions is revoked --
 * changing your own password therefore logs this client out too.
 *
 * @typedef {object} PostUserPasswordMutationData
 * @property {object} formData - The payload (snake_case, matching the API)
 * @property {number} formData.id - The user ID
 * @property {string} formData.password - The new password (min 8 chars)
 * @property {string} [formData.current_password] - Required unless sudo-mode admin
 * @property {boolean} [formData.revoke_sessions] - Revoke every session (default true)
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function usePostUserPasswordMutation() {
    const fetch = useAuthedFetchJSON();
    return useInvalidatingMutation(async ({ formData }) => {
        const { id, ...body } = formData;
        return await fetch("/api/users/user/" + encodeURIComponent(id) + "/password", {
            method: 'POST',
            body
        });
    });
}

/**
 * Delete one of a User's Sessions (logging that device out). Self-or-admin:
 * no local role guard.
 *
 * @typedef {object} DeleteUserSessionMutationData
 * @property {object} formData
 * @property {number} formData.user_id
 * @property {number} formData.session_id
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function useDeleteUserSessionMutation() {
    const fetch = useAuthedFetchJSON();
    return useInvalidatingMutation(async ({ formData }) => {
        return await fetch(
            "/api/users/user/" + encodeURIComponent(formData.user_id)
                + "/session/" + encodeURIComponent(formData.session_id),
            { method: 'DELETE' }
        );
    });
}

/**
 * Mint a new API Key for a User. The response data's `api_key` field is the
 * ONLY time the plaintext secret is ever shown -- surface it to the user
 * immediately. Self-or-admin: no local role guard.
 *
 * @typedef {object} PostUserApiKeyMutationData
 * @property {object} formData - The payload (snake_case, matching the API)
 * @property {number} formData.id - The user ID to mint for
 * @property {string} formData.name - Human label ('statement importer', ...)
 * @property {boolean} [formData.reader] - Key-level reader scope (default true)
 * @property {boolean} [formData.editor] - Key-level editor scope (default false)
 * @property {number} [formData.ttl_days] - Days until expiry; omit for never
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function usePostUserApiKeyMutation() {
    const fetch = useAuthedFetchJSON();
    return useInvalidatingMutation(async ({ formData }) => {
        const { id, ...body } = formData;
        return await fetch("/api/users/user/" + encodeURIComponent(id) + "/api-keys", {
            method: 'POST',
            body
        });
    });
}

/**
 * Revoke one of a User's API Keys (its secret loses the right to exchange
 * for access tokens). Self-or-admin: no local role guard.
 *
 * @typedef {object} DeleteUserApiKeyMutationData
 * @property {object} formData
 * @property {number} formData.user_id
 * @property {number} formData.api_key_id
 *
 * @returns {import('@tanstack/react-query').UseMutationResult}
 */
export function useDeleteUserApiKeyMutation() {
    const fetch = useAuthedFetchJSON();
    return useInvalidatingMutation(async ({ formData }) => {
        return await fetch(
            "/api/users/user/" + encodeURIComponent(formData.user_id)
                + "/api-key/" + encodeURIComponent(formData.api_key_id),
            { method: 'DELETE' }
        );
    });
}
