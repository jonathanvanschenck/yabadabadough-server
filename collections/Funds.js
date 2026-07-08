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
const { QK, invalidate, remove, money_moved } = require("./lib/query_keys.js");

const Fund = require("../models/Fund.js");

// Shared between POST (with required flags) and PATCH (all optional)
const FUND_BODY_FIELDS = {
    name: [ "name", only_non_empty_string, "non-empty string" ],
    tracked: [ "tracked", only_boolean, "boolean" ],
    monthly: [ "monthly", only_boolean, "boolean" ],
    pool: [ "pool", only_boolean, "boolean" ],
    parent_id: [ "parent_id", nullable(only_id), "positive integer or null" ],
    start_date: [ "start_date", nullable(only_ydate), "YYYY-MM-DD string or null" ],
    start_balance: [ "start_balance", nullable(only_number), "number or null" ],
    color: [ "color", nullable(only_non_empty_string), "non-empty string or null" ],
};

const FundBodyProperties = {
    name: { type: 'string' },
    tracked: { type: 'boolean' },
    monthly: { type: 'boolean', description: "Resets into its nearest pool ancestor at end of month; requires tracked and a parent with a pool ancestor" },
    pool: { type: 'boolean', description: "Source/sink of money for its descendants; requires tracked, excludes monthly" },
    parent_id: { type: 'integer', nullable: true },
    start_date: { type: 'string', format: 'date', nullable: true, description: "Required (non-null) when tracked" },
    start_balance: { type: 'number', nullable: true, description: "Forward balance entering start_date; required (non-null) when tracked" },
    color: { type: 'string', nullable: true }
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

            static openapi_ResponseSchema = {
                type: 'object',
                properties: {
                    fund_id: { type: 'integer', minimum: 1 },
                    on: { type: 'string', format: 'date', nullable: true, description: "The date the balance was calculated on; null means the current balance" },
                    balance: { type: 'number', description: "Currency as a float dollar amount" }
                },
                required: [ 'fund_id', 'on', 'balance' ]
            }

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } },
                { code: 404, description: "Not found", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } }
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

            static openapi_Description = "Update an existing fund. Only the fields included in the request body will be updated. History-affecting fields (start_date, start_balance, tracked, monthly, pool, and the parent of a fund that is or contains a monthly fund) are immutable while any finalizations exist for the fund (409). Hierarchy changes repoint allocation sources in unfinalized months.";

            static openapi_Parameters = [
                this.FundIDParam
            ]

            static openapi_RequestBodySchema = {
                type: 'object',
                properties: FundBodyProperties
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
