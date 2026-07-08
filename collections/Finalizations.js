const {
    Collection,
    Controller: _Controller,
    HTTPCodeError,
    parse_body_fields,
    assert_found,
    translate_model_error,
    parse_list_params,
    openapi_list_parameters,
    data_invalidations_response
} = require("./lib/asseverate.js");
const {
    to_int,
    to_ydate,
    only_boolean,
    only_ydate,
} = require("./lib/parsers.js");
const { QK, invalidate, remove, money_moved } = require("./lib/query_keys.js");

const MonthFinalization = require("../models/MonthFinalization.js");
const FundFinalization = require("../models/FundFinalization.js");

// Finalizing/unfinalizing repoints every tracked fund's cache, inserts or
// removes the eom_cleanup transaction groups, and moves the mutability
// boundary for allocations -- nearly everything shifts
const finalization_changed = () => [
    invalidate(QK.month_finalizations),
    invalidate(QK.fund_finalizations),
    invalidate(QK.funds),
    invalidate(["fund"]),
    invalidate(QK.allocations),
    ...money_moved(),
];

class Controller extends _Controller {

    static MonthFinalizationIDParam = {
        name: 'month_finalization_id',
        in: 'path',
        description: 'The ID of the month finalization',
        required: true,
        schema: { type: 'integer' }
    }

    get_month_finalization(req) {
        const id = to_int(req.params.month_finalization_id);
        if ( !id ) throw new HTTPCodeError(404, "Not found");
        return assert_found(MonthFinalization.for_id(this.db, id), `month finalization ${id}`);
    }
}

module.exports = class FinalizationsCollection extends Collection {
    static prefix = "/api/finalizations";

    static openapi_Tags = ["Finalizations"];

    static controllers = [

        class GetMonthFinalizations extends Controller {
            static path = "/month-finalizations";

            static method = "GET";

            static openapi_Summary = "List Month Finalizations";

            static openapi_Description = "Get the finalized months (newest first by default). Months finalize contiguously, so this is always a gap-free run ending at the latest finalized month.";

            static query_key = ["month-finalizations"];

            static openapi_Parameters = [
                {
                    name: 'since',
                    in: 'query',
                    description: 'Filter to months with som_date on or after this date',
                    required: false,
                    schema: { type: 'string', format: 'date' }
                },
                {
                    name: 'until',
                    in: 'query',
                    description: 'Filter to months with som_date on or before this date',
                    required: false,
                    schema: { type: 'string', format: 'date' }
                },
                ...openapi_list_parameters([ 'id', 'som_date' ])
            ]

            async parse_request(req) {
                const filter = parse_list_params(req.query, [ "id", "som_date" ]);

                filter.since = to_ydate(req.query?.since);
                filter.until = to_ydate(req.query?.until);

                return filter;
            }

            async respond(filter, { res }) {
                res.setHeader("X-Total-Count", MonthFinalization.count(this.db, filter));
                return MonthFinalization.from_db(this.db, filter).map((m) => m.to_api());
            }

            static openapi_ResponseHeaders = {
                "X-Total-Count": {
                    description: "The total number of month finalizations matching the filter (ignoring limit and offset)",
                    schema: { type: "integer" }
                }
            }

            static openapi_ResponseSchema = {
                type: 'array',
                items: {
                    "$ref": '#/components/schemas/MonthFinalizationSchema'
                }
            }
        },

        class GetLatestMonthFinalization extends Controller {
            static path = "/month-finalizations/latest";

            static method = "GET";

            static openapi_Summary = "Get Latest Month Finalization";

            static openapi_Description = "Get the most recent finalized month, or null when nothing has been finalized yet (a normal state, not an error). The next month to finalize -- and the only one that may be unfinalized -- follows from it.";

            static query_key = [ "month-finalizations", "latest" ];

            async respond() {
                const latest = MonthFinalization.latest(this.db);
                return latest ? latest.to_api() : null;
            }

            static openapi_ResponseSchema = {
                oneOf: [
                    { "$ref": '#/components/schemas/MonthFinalizationSchema' },
                    { "$ref": '#/components/schemas/NullSchema' }
                ]
            }
        },

        class GetMonthFinalization extends Controller {
            static path = "/month-finalization/:month_finalization_id";

            static method = "GET";

            static openapi_Summary = "Get Month Finalization";

            static openapi_Description = "Get a single month finalization by ID.";

            static query_key = [ "month-finalization", "month_finalization_id" ];

            static openapi_Parameters = [
                this.MonthFinalizationIDParam
            ]

            async parse_request(req) {
                return this.get_month_finalization(req);
            }

            async respond(month) {
                return month.to_api();
            }

            static openapi_ResponseSchema = {
                "$ref": '#/components/schemas/MonthFinalizationSchema'
            }

            static openapi_ErrorResponses = [
                { code: 404, description: "Not found", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } }
            ]
        },

        class PostMonthFinalizations extends Controller {
            static path = "/month-finalizations";

            static method = "POST";

            static editor = true;

            static openapi_Summary = "Finalize Month";

            static openapi_Description = "Finalize the month containing `month`: record every tracked fund's end-of-month balances and zero every monthly fund back into its nearest pool ancestor (one eom_cleanup transaction group). Months finalize contiguously, oldest first -- with `recursive`, intervening months are finalized automatically. Once finalized, no transaction groups may be added in (or before) the month. Finalizing the current/future month is deliberately allowed (unfinalize to undo).";

            static openapi_RequestBodySchema = {
                type: 'object',
                properties: {
                    month: { type: 'string', format: 'date', description: "Any date within the month to finalize" },
                    recursive: { type: 'boolean', description: "Auto-finalize intervening months (default false)" }
                },
                required: [ 'month' ]
            }

            async parse_request(req) {
                return parse_body_fields(req.body, [
                    [ "month", only_ydate, "YYYY-MM-DD string", { required: true } ],
                    [ "recursive", only_boolean, "boolean" ],
                ]);
            }

            async respond(data) {
                let month;
                try {
                    month = MonthFinalization.create(this.db, data);
                } catch (err) {
                    translate_model_error(err);
                }

                const invalidation_actions = finalization_changed();

                this.broadcast_invalidations(invalidation_actions, { month_finalization_id: month.id });

                return {
                    data: month.to_api(),
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({ "$ref": '#/components/schemas/MonthFinalizationSchema' });

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } },
                { code: 409, description: "Conflict (already finalized; previous month unfinalized without recursive; no tracked funds)", schema: { "$ref": '#/components/schemas/ConflictResponseSchema' } }
            ]
        },

        class DeleteMonthFinalization extends Controller {
            static path = "/month-finalization/:month_finalization_id";

            static method = "DELETE";

            static editor = true;

            static openapi_Summary = "Unfinalize Month";

            static openapi_Description = "Reverse a month's finalization: remove its fund finalizations and eom_cleanup transactions and repoint funds at their previous cache points. Strictly LIFO -- only the LATEST finalized month may be unfinalized (409 otherwise).";

            static openapi_Parameters = [
                this.MonthFinalizationIDParam
            ]

            async parse_request(req) {
                return this.get_month_finalization(req);
            }

            async respond(month) {
                try {
                    month.unfinalize(this.db);
                } catch (err) {
                    translate_model_error(err);
                }

                const invalidation_actions = [
                    ...finalization_changed(),
                    remove(QK.month_finalization(month.id)),
                ];

                this.broadcast_invalidations(invalidation_actions, { month_finalization_id: month.id });

                return {
                    data: null,
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({ "$ref": '#/components/schemas/NullSchema' });

            static openapi_ErrorResponses = [
                { code: 404, description: "Not found", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } },
                { code: 409, description: "Conflict (not the latest finalized month)", schema: { "$ref": '#/components/schemas/ConflictResponseSchema' } }
            ]
        },

        class GetFundFinalizations extends Controller {
            static path = "/fund-finalizations";

            static method = "GET";

            static openapi_Summary = "List Fund Finalizations";

            static openapi_Description = "Get per-fund finalization history (newest first by default). Filter by fund_id for one fund's history: eom_balance is the month's pre-cleanup surplus/loss snapshot, sonm the reconciliation cache point entering the next month.";

            static query_key = ["fund-finalizations"];

            static openapi_Parameters = [
                {
                    name: 'fund_id',
                    in: 'query',
                    description: 'Filter to one fund\'s history',
                    required: false,
                    schema: { type: 'integer' }
                },
                {
                    name: 'month_id',
                    in: 'query',
                    description: 'Filter to one month finalization',
                    required: false,
                    schema: { type: 'integer' }
                },
                {
                    name: 'since',
                    in: 'query',
                    description: 'Filter to finalizations with sonm_date on or after this date',
                    required: false,
                    schema: { type: 'string', format: 'date' }
                },
                {
                    name: 'until',
                    in: 'query',
                    description: 'Filter to finalizations with sonm_date on or before this date',
                    required: false,
                    schema: { type: 'string', format: 'date' }
                },
                ...openapi_list_parameters([ 'id', 'sonm_date' ])
            ]

            async parse_request(req) {
                const filter = parse_list_params(req.query, [ "id", "sonm_date" ]);

                filter.fund_id = to_int(req.query?.fund_id);
                filter.month_id = to_int(req.query?.month_id);
                filter.since = to_ydate(req.query?.since);
                filter.until = to_ydate(req.query?.until);

                return filter;
            }

            async respond(filter, { res }) {
                res.setHeader("X-Total-Count", FundFinalization.count(this.db, filter));
                return FundFinalization.from_db(this.db, filter).map((f) => f.to_api());
            }

            static openapi_ResponseHeaders = {
                "X-Total-Count": {
                    description: "The total number of fund finalizations matching the filter (ignoring limit and offset)",
                    schema: { type: "integer" }
                }
            }

            static openapi_ResponseSchema = {
                type: 'array',
                items: {
                    "$ref": '#/components/schemas/FundFinalizationSchema'
                }
            }
        },

        class GetFundFinalization extends Controller {
            static path = "/fund-finalization/:fund_finalization_id";

            static method = "GET";

            static openapi_Summary = "Get Fund Finalization";

            static openapi_Description = "Get a single fund finalization by ID.";

            static query_key = [ "fund-finalization", "fund_finalization_id" ];

            static openapi_Parameters = [
                {
                    name: 'fund_finalization_id',
                    in: 'path',
                    description: 'The ID of the fund finalization',
                    required: true,
                    schema: { type: 'integer' }
                }
            ]

            async parse_request(req) {
                const id = to_int(req.params.fund_finalization_id);
                if ( !id ) throw new HTTPCodeError(404, "Not found");
                return assert_found(FundFinalization.for_id(this.db, id), `fund finalization ${id}`);
            }

            async respond(finalization) {
                return finalization.to_api();
            }

            static openapi_ResponseSchema = {
                "$ref": '#/components/schemas/FundFinalizationSchema'
            }

            static openapi_ErrorResponses = [
                { code: 404, description: "Not found", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } }
            ]
        }

    ]
}
