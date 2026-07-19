const {
    Collection,
    Controller: _Controller,
    HTTPCodeError,
    parse_body_fields,
    parse_strict_query_param,
    assert_found,
    translate_model_error,
    parse_list_params,
    openapi_list_parameters,
    data_invalidations_response
} = require("./lib/asseverate.js");
const {
    to_int,
    to_positive_int,
    to_ydate,
    string_to_boolean,
    string_to_array,
    parse_and_filter_array,
    only_string,
    only_non_empty_string,
    only_boolean,
    only_id,
    only_number,
    only_ydate,
    nullable
} = require("./lib/parsers.js");
const { QK, invalidate, remove, money_moved } = require("./lib/query_keys.mjs");
const { FUND_COLORS } = require("../lib/fund_colors.mjs");

const Fund = require("../models/Fund.js");

// only_*-style body parser (undefined on failure) for the palette-slug color
const only_fund_color = (value) => FUND_COLORS.includes(value) ? value : undefined;

// Shared between POST (with required flags) and PATCH (all optional)
const FUND_BODY_FIELDS = {
    name: [ "name", only_non_empty_string, "non-empty string" ],
    tracked: [ "tracked", only_boolean, "boolean" ],
    monthly: [ "monthly", only_boolean, "boolean" ],
    pool: [ "pool", only_boolean, "boolean" ],
    parent_id: [ "parent_id", nullable(only_id), "positive integer or null" ],
    start_date: [ "start_date", nullable(only_ydate), "YYYY-MM-DD string or null" ],
    start_balance: [ "start_balance", nullable(only_number), "number or null" ],
    color: [ "color", nullable(only_fund_color), "palette color slug or null" ],
    // PATCH-only: funds are never created already-deprecated
    deprecated: [ "deprecated", nullable(only_ydate), "YYYY-MM-DD string or null" ],
};

// Shared POST/PATCH body properties; the PATCH-only `deprecated` field is
// added where the PATCH schema is declared
const FundBodyProperties = {
    name: { type: 'string' },
    tracked: { type: 'boolean' },
    monthly: { type: 'boolean', description: "Resets into its nearest pool ancestor at end of month; requires tracked and a parent with a pool ancestor" },
    pool: { type: 'boolean', description: "Source/sink of money for its descendants; requires tracked, excludes monthly" },
    parent_id: { type: 'integer', nullable: true },
    start_date: { type: 'string', format: 'date', nullable: true, description: "Required (non-null) when tracked" },
    start_balance: { type: 'number', nullable: true, description: "Forward balance entering start_date; required (non-null) when tracked" },
    color: { type: 'string', nullable: true, enum: [ ...FUND_COLORS, null ], description: "Palette color slug (see lib/fund_colors.mjs)" }
};

// Shared between the per-fund and bulk balance routes
const FundBalanceSchema = {
    type: 'object',
    properties: {
        fund_id: { type: 'integer', minimum: 1 },
        on: { type: 'string', format: 'date', nullable: true, description: "The date the balance was calculated on; null means the current balance" },
        balance: { type: 'number', description: "Currency as a float dollar amount" }
    },
    required: [ 'fund_id', 'on', 'balance' ]
};

// Hierarchy/pool edits can repoint allocation sources in unfinalized months
// (Fund._rederive_allocation_sources), which moves money between funds --
// deliberately over-invalidate
const hierarchy_changed = () => [
    invalidate(QK.allocations),
    ...money_moved(),
];

class Controller extends _Controller {

    static FundIDParam = {
        name: 'fund_id',
        in: 'path',
        description: 'The ID of the fund',
        required: true,
        schema: { type: 'integer' }
    }

    get_fund(req) {
        const fund_id = to_int(req.params.fund_id);
        if ( !fund_id ) throw new HTTPCodeError(404, "Not found");
        return assert_found(Fund.for_id(this.db, fund_id), `fund ${fund_id}`);
    }
}

module.exports = class FundsCollection extends Collection {
    static prefix = "/api/funds";

    static openapi_Tags = ["Funds"];

    static controllers = [

        class GetFunds extends Controller {
            static path = "/funds";

            static method = "GET";

            static openapi_Summary = "List Funds";

            static openapi_Description = "Get a list of funds. You can filter and sort the results using query parameters.";

            static query_key = ["funds"];

            static openapi_Parameters = [
                {
                    name: 'id',
                    in: 'query',
                    description: 'Filter by fund ID',
                    required: false,
                    schema: { type: 'integer' }
                },
                {
                    name: 'ids',
                    in: 'query',
                    description: 'Filter by a comma-separated list of fund IDs',
                    required: false,
                    schema: { type: 'string', example: '1,2,3' }
                },
                {
                    name: 'name',
                    in: 'query',
                    description: 'Filter by exact fund name',
                    required: false,
                    schema: { type: 'string' }
                },
                {
                    name: 'name_like',
                    in: 'query',
                    description: 'Filter by fund name using a case-insensitive substring match',
                    required: false,
                    schema: { type: 'string' }
                },
                {
                    name: 'started_since',
                    in: 'query',
                    description: 'Filter to funds with start_date on or after this date',
                    required: false,
                    schema: { type: 'string', format: 'date' }
                },
                {
                    name: 'started_until',
                    in: 'query',
                    description: 'Filter to funds with start_date on or before this date',
                    required: false,
                    schema: { type: 'string', format: 'date' }
                },
                {
                    name: 'tracked',
                    in: 'query',
                    description: 'Filter by tracked status',
                    required: false,
                    schema: { type: 'boolean' }
                },
                {
                    name: 'monthly',
                    in: 'query',
                    description: 'Filter by monthly status',
                    required: false,
                    schema: { type: 'boolean' }
                },
                {
                    name: 'pool',
                    in: 'query',
                    description: 'Filter by pool status',
                    required: false,
                    schema: { type: 'boolean' }
                },
                {
                    name: 'root',
                    in: 'query',
                    description: 'Filter to root funds (no parent) or non-root funds',
                    required: false,
                    schema: { type: 'boolean' }
                },
                {
                    name: 'descendant_of',
                    in: 'query',
                    description: 'Filter to the subtree rooted at this fund ID (self-inclusive: the fund itself plus all of its descendants). An unknown ID matches nothing; a malformed value is a 400. Composes with the other filters.',
                    required: false,
                    schema: { type: 'integer' }
                },
                {
                    name: 'deprecated',
                    in: 'query',
                    description: 'Filter by deprecation status (true: only deprecated funds, false: only active funds)',
                    required: false,
                    schema: { type: 'boolean' }
                },
                {
                    name: 'active_as_of',
                    in: 'query',
                    description: 'Filter to funds NOT deprecated before this date (active funds always pass; a fund deprecated on-or-after the date was still active on it)',
                    required: false,
                    schema: { type: 'string', format: 'date' }
                },
                ...openapi_list_parameters([ 'id' ])
            ]

            async parse_request(req) {
                const filter = parse_list_params(req.query, [ "id" ]);

                filter.id = to_int(req.query?.id);
                const ids = string_to_array(req.query?.ids);
                if ( ids !== undefined ) filter.ids = parse_and_filter_array(ids, to_int);
                filter.name = only_non_empty_string(req.query?.name);
                filter.name_like = only_string(req.query?.name_like);
                filter.started_since = to_ydate(req.query?.started_since);
                filter.started_until = to_ydate(req.query?.started_until);
                filter.tracked = string_to_boolean(req.query?.tracked);
                filter.monthly = string_to_boolean(req.query?.monthly);
                filter.pool = string_to_boolean(req.query?.pool);
                filter.root = string_to_boolean(req.query?.root);
                filter.deprecated = string_to_boolean(req.query?.deprecated);
                filter.active_as_of = to_ydate(req.query?.active_as_of);

                // Strict: a lenient fallback would silently return ALL funds
                // instead of the subtree
                filter.descendant_of = parse_strict_query_param(req.query, "descendant_of", to_positive_int, "positive integer");

                return filter;
            }

            async respond(filter, { res }) {
                res.setHeader("X-Total-Count", Fund.count(this.db, filter));
                return Fund.from_db(this.db, filter).map((f) => f.to_api());
            }

            static openapi_ResponseHeaders = {
                "X-Total-Count": {
                    description: "The total number of funds matching the filter (ignoring limit and offset)",
                    schema: { type: "integer" }
                }
            }

            static openapi_ResponseSchema = {
                type: 'array',
                items: {
                    "$ref": '#/components/schemas/FundSchema'
                }
            }

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } }
            ]
        },

        class GetFund extends Controller {
            static path = "/fund/:fund_id";

            static method = "GET";

            static openapi_Summary = "Get Fund";

            static openapi_Description = "Get a single fund by ID.";

            static query_key = [ "fund", "fund_id" ];

            static openapi_Parameters = [
                this.FundIDParam
            ]

            async parse_request(req) {
                return this.get_fund(req);
            }

            async respond(fund) {
                return fund.to_api();
            }

            static openapi_ResponseSchema = {
                "$ref": '#/components/schemas/FundSchema'
            }

            static openapi_ErrorResponses = [
                { code: 404, description: "Not found", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } }
            ]
        },

        class GetFundBalance extends Controller {
            static path = "/fund/:fund_id/balance";

            static method = "GET";

            static openapi_Summary = "Get Fund Balance";

            static openapi_Description = "Calculate the fund's balance: the current balance (every transaction to date), or -- with `on` -- the balance on that date (every transaction up to AND on it). Computed from the fund's latest cache point at-or-before the date, so it is cheap regardless of history depth. Untracked funds always report 0.";

            static query_key = [ "fund-balance", "fund_id" ];

            static openapi_Parameters = [
                this.FundIDParam,
                {
                    name: 'on',
                    in: 'query',
                    description: 'The date to calculate the balance on (default: today, i.e. all transactions). May not predate the fund\'s start_date.',
                    required: false,
                    schema: { type: 'string', format: 'date' }
                }
            ]

            async parse_request(req) {
                const fund = this.get_fund(req);

                // Strict: a lenient fallback would silently return the WRONG
                // balance (the current one instead of the requested date's)
                const on = parse_strict_query_param(req.query, "on", only_ydate, "YYYY-MM-DD string") ?? null;

                return { fund, on };
            }

            async respond({ fund, on }) {
                let balance;
                try {
                    balance = on ? fund.calculate_balance_on(this.db, on) : fund.calculate_balance(this.db);
                } catch (err) {
                    translate_model_error(err);
                }

                return {
                    fund_id: fund.id,
                    on: on ? on.toJSON() : null,
                    balance,
                };
            }

            static openapi_ResponseSchema = FundBalanceSchema;

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } },
                { code: 404, description: "Not found", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } }
            ]
        },

        class GetFundBalances extends Controller {
            static path = "/balances";

            static method = "GET";

            static openapi_Summary = "List Fund Balances";

            static openapi_Description = "Calculate every tracked fund's balance in one response -- the bulk companion to the per-fund balance route (one round trip instead of N). Same semantics per fund: the current balance, or -- with `on` -- the balance on that date (every transaction up to AND on it). Funds whose start_date is after `on` are omitted (they had no balance yet); untracked funds are never included. Not paginated.";

            static query_key = [ "fund-balance", "all" ];

            static openapi_Parameters = [
                {
                    name: 'on',
                    in: 'query',
                    description: 'The date to calculate the balances on (default: today, i.e. all transactions). Funds starting after this date are omitted from the response.',
                    required: false,
                    schema: { type: 'string', format: 'date' }
                }
            ]

            async parse_request(req) {
                // Strict: a lenient fallback would silently return the WRONG
                // balances (the current ones instead of the requested date's)
                const on = parse_strict_query_param(req.query, "on", only_ydate, "YYYY-MM-DD string") ?? null;

                return { on };
            }

            async respond({ on }, { res }) {
                const funds = Fund.from_db(this.db, { tracked: true, limit: null });

                // A fund that had not started by `on` has no balance to
                // report (the per-fund route 400s) -- omit it rather than
                // failing the whole response
                const balances = funds
                    .filter((fund) => !on || fund.start_date.toJSON() <= on.toJSON())
                    .map((fund) => ({
                        fund_id: fund.id,
                        on: on ? on.toJSON() : null,
                        balance: on ? fund.calculate_balance_on(this.db, on) : fund.calculate_balance(this.db),
                    }));

                res.setHeader("X-Total-Count", balances.length);
                return balances;
            }

            static openapi_ResponseHeaders = {
                "X-Total-Count": {
                    description: "The number of balances returned (the endpoint is not paginated, so this always equals the array length)",
                    schema: { type: "integer" }
                }
            }

            static openapi_ResponseSchema = {
                type: 'array',
                items: FundBalanceSchema
            }

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } }
            ]
        },

        class PostFunds extends Controller {
            static path = "/funds";

            static method = "POST";

            static editor = true;

            static openapi_Summary = "Create Fund";

            static openapi_Description = "Create a new fund. Tracked funds require start_date and start_balance; monthly funds require tracked, a parent, and a pool ancestor; pool funds require tracked and may not be monthly. A tracked fund starting in (or before) already-finalized months is backfilled with fund finalizations automatically.";

            static openapi_RequestBodySchema = {
                type: 'object',
                properties: FundBodyProperties,
                required: [ 'name', 'tracked' ]
            }

            async parse_request(req) {
                return parse_body_fields(req.body, [
                    [ ...FUND_BODY_FIELDS.name, { required: true } ],
                    [ ...FUND_BODY_FIELDS.tracked, { required: true } ],
                    FUND_BODY_FIELDS.monthly,
                    FUND_BODY_FIELDS.pool,
                    FUND_BODY_FIELDS.parent_id,
                    FUND_BODY_FIELDS.start_date,
                    FUND_BODY_FIELDS.start_balance,
                    FUND_BODY_FIELDS.color,
                ]);
            }

            async respond(data) {
                let fund;
                try {
                    fund = Fund.create(this.db, data);
                } catch (err) {
                    translate_model_error(err);
                }

                const invalidation_actions = [
                    invalidate(QK.funds),
                    // Creation may backfill finalizations for already-finalized months
                    invalidate(QK.fund_finalizations),
                ];

                this.broadcast_invalidations(invalidation_actions);

                return {
                    data: fund.to_api(),
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({ "$ref": '#/components/schemas/FundSchema' });

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } },
                { code: 409, description: "Conflict", schema: { "$ref": '#/components/schemas/ConflictResponseSchema' } }
            ]
        },

        class PatchFund extends Controller {
            static path = "/fund/:fund_id";

            static method = "PATCH";

            static editor = true;

            static openapi_Summary = "Update Fund";

            static openapi_Description = "Update an existing fund. Only the fields included in the request body will be updated. History-affecting fields (start_date, start_balance, tracked, monthly, pool, and the parent of a fund that is or contains a monthly fund) are immutable while any finalizations exist for the fund (409). Hierarchy changes repoint allocation sources in unfinalized months. Setting `deprecated` (the fund's LAST ACTIVE day) requires: a tracked fund, a zero balance on that date, no transactions after it, and every tracked descendant already deprecated at-or-before it; once set, the fund is frozen (no transaction of any kind may involve it) until `deprecated` is cleared -- which in turn is refused once any later month has been finalized (unfinalize back first). To deprecate, prefer the dedicated POST `/fund/:fund_id/deprecate` route: it atomically drains the remaining balance and removes future allocations before setting the field, whereas this route requires the fund to already satisfy every invariant (zero balance, no later allocations).";

            static openapi_Parameters = [
                this.FundIDParam
            ]

            static openapi_RequestBodySchema = {
                type: 'object',
                properties: {
                    ...FundBodyProperties,
                    deprecated: { type: 'string', format: 'date', nullable: true, description: "The fund's LAST ACTIVE day; null re-activates the fund. See the route description for the invariants. Prefer the dedicated POST `/fund/:fund_id/deprecate` route, which atomically drains the remaining balance into a fund of your choice (and removes future allocations) before setting this field." }
                }
            }

            async parse_request(req) {
                const patch = parse_body_fields(req.body, [
                    FUND_BODY_FIELDS.name,
                    FUND_BODY_FIELDS.tracked,
                    FUND_BODY_FIELDS.monthly,
                    FUND_BODY_FIELDS.pool,
                    FUND_BODY_FIELDS.parent_id,
                    FUND_BODY_FIELDS.start_date,
                    FUND_BODY_FIELDS.start_balance,
                    FUND_BODY_FIELDS.color,
                    FUND_BODY_FIELDS.deprecated,
                ]);

                return { fund: this.get_fund(req), patch };
            }

            async respond({ fund, patch }) {
                let new_fund;
                try {
                    new_fund = fund.update(this.db, patch);
                } catch (err) {
                    translate_model_error(err);
                }

                const invalidation_actions = [
                    invalidate(QK.funds),
                    invalidate(QK.fund(fund.id)),
                    ...hierarchy_changed(),
                ];

                this.broadcast_invalidations(invalidation_actions, { fund_id: fund.id });

                return {
                    data: new_fund.to_api(),
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({ "$ref": '#/components/schemas/FundSchema' });

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } },
                { code: 404, description: "Not found", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } },
                { code: 409, description: "Conflict", schema: { "$ref": '#/components/schemas/ConflictResponseSchema' } }
            ]
        },

        class PostDeprecateFund extends Controller {
            static path = "/fund/:fund_id/deprecate";

            static method = "POST";

            static editor = true;

            static openapi_Summary = "Deprecate Fund";

            static openapi_Description = "Close out a fund as of `date` (its LAST ACTIVE day), atomically: any of the fund's allocations dated after `date` are removed, its remaining balance on `date` is transferred into `transfer_to_fund_id` via a closing transaction group dated `date` (required only when that balance is nonzero -- a negative balance transfers the other way; omitted or ignored when the fund is already at zero), and the fund's `deprecated` field is set. Every deprecation invariant applies (409 on failure): the date's month must not be finalized, no non-allocation transactions after the date, tracked descendants deprecated first, and monthly funds need every prior month finalized. Once deprecated the fund is frozen -- see PATCH `/fund/:fund_id` for un-deprecation.";

            static openapi_Parameters = [
                this.FundIDParam
            ]

            static openapi_RequestBodySchema = {
                type: 'object',
                properties: {
                    date: { type: 'string', format: 'date', description: "The fund's last active day" },
                    transfer_to_fund_id: { type: 'integer', nullable: true, description: "Fund receiving the remaining balance; required when that balance is nonzero" }
                },
                required: [ 'date' ]
            }

            async parse_request(req) {
                const body = parse_body_fields(req.body, [
                    [ "date", only_ydate, "YYYY-MM-DD string", { required: true } ],
                    [ "transfer_to_fund_id", nullable(only_id), "positive integer or null" ],
                ]);

                return { fund: this.get_fund(req), body };
            }

            async respond({ fund, body }) {
                let result;
                try {
                    result = fund.deprecate(this.db, {
                        date: body.date,
                        transfer_to_fund_id: body.transfer_to_fund_id ?? null,
                    });
                } catch (err) {
                    translate_model_error(err);
                }

                const invalidation_actions = [
                    invalidate(QK.funds),
                    invalidate(QK.fund(fund.id)),
                    // The closing transfer and/or removed future allocations
                    invalidate(QK.allocations),
                    ...money_moved(),
                ];

                this.broadcast_invalidations(invalidation_actions, { fund_id: fund.id });

                return {
                    data: {
                        fund: result.fund.to_api(),
                        transfer_group: result.transfer_group ? result.transfer_group.to_api() : null,
                        removed_allocation_months: result.removed_allocations.map(a => a.month.toJSON()),
                    },
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({
                type: 'object',
                properties: {
                    fund: { "$ref": '#/components/schemas/FundSchema' },
                    transfer_group: {
                        oneOf: [
                            { "$ref": '#/components/schemas/TransactionGroupSchema' },
                            { "$ref": '#/components/schemas/NullSchema' }
                        ],
                        description: "The closing transfer group, or null when the fund was already at zero"
                    },
                    removed_allocation_months: {
                        type: 'array',
                        items: { type: 'string', format: 'date' },
                        description: "First-of-month dates whose allocations for this fund were removed"
                    }
                },
                required: [ 'fund', 'transfer_group', 'removed_allocation_months' ]
            });

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } },
                { code: 404, description: "Not found", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } },
                { code: 409, description: "Conflict", schema: { "$ref": '#/components/schemas/ConflictResponseSchema' } }
            ]
        },

        class DeleteFund extends Controller {
            static path = "/fund/:fund_id";

            static method = "DELETE";

            static editor = true;

            static openapi_Summary = "Delete Fund";

            static openapi_Description = "Delete a fund. Fails while any finalizations exist for the fund (409) -- deleting a finalized fund would destroy cached history (unfinalize back to the fund's start first).";

            static openapi_Parameters = [
                this.FundIDParam
            ]

            async parse_request(req) {
                return this.get_fund(req);
            }

            async respond(fund) {
                try {
                    fund.delete(this.db);
                } catch (err) {
                    translate_model_error(err);
                }

                const invalidation_actions = [
                    invalidate(QK.funds),
                    remove(QK.fund(fund.id)),
                    ...hierarchy_changed(),
                ];

                this.broadcast_invalidations(invalidation_actions, { fund_id: fund.id });

                return {
                    data: null,
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({ "$ref": '#/components/schemas/NullSchema' });

            static openapi_ErrorResponses = [
                { code: 404, description: "Not found", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } },
                { code: 409, description: "Conflict", schema: { "$ref": '#/components/schemas/ConflictResponseSchema' } }
            ]
        }

    ]
}
