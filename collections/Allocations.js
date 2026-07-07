const {
    Collection,
    Controller: _Controller,
    HTTPCodeError,
    parse_body_fields,
    translate_model_error,
    data_invalidations_response
} = require("./lib/asseverate.js");
const {
    to_int,
    to_ydate,
    to_positive_int,
    to_non_negative_int,
    only_direction,
    string_to_enum,
    only_id,
    only_positive_number,
    only_ydate,
} = require("./lib/parsers.js");
const { QK, invalidate, money_moved } = require("./lib/query_keys.js");

const { ConflictError } = require("../lib/db.js");
const Allocation = require("../models/Allocation.js");

// Every allocation write edits the month's allocation transaction group
// in place, so the transaction surfaces and balances all move together
const allocations_changed = () => [
    invalidate(QK.allocations),
    ...money_moved(),
];

const MonthParamDescription = "Any date within the target month (YYYY-MM-DD)";

class Controller extends _Controller {}

module.exports = class AllocationsCollection extends Collection {
    static prefix = "/api/allocations";

    static openapi_Tags = ["Allocations"];

    static controllers = [

        class GetAllocations extends Controller {
            static path = "/allocations";

            static method = "GET";

            static openapi_Summary = "List Allocations";

            static openapi_Description = "Get allocations in one of two modes (exactly one required): `month` returns every allocation for that month; `fund_id` returns the fund's allocation history (optionally bounded by since/until, newest first). Allocations have no id of their own -- (fund_id, month) identifies one.";

            static query_key = ["allocations"];

            static openapi_Parameters = [
                {
                    name: 'month',
                    in: 'query',
                    description: `Month mode: ${MonthParamDescription}`,
                    required: false,
                    schema: { type: 'string', format: 'date' }
                },
                {
                    name: 'fund_id',
                    in: 'query',
                    description: 'Fund mode: the fund whose allocation history to return',
                    required: false,
                    schema: { type: 'integer' }
                },
                {
                    name: 'since',
                    in: 'query',
                    description: 'Fund mode only: allocations dated on or after this date',
                    required: false,
                    schema: { type: 'string', format: 'date' }
                },
                {
                    name: 'until',
                    in: 'query',
                    description: 'Fund mode only: allocations dated on or before this date',
                    required: false,
                    schema: { type: 'string', format: 'date' }
                },
                {
                    name: 'order_direction',
                    in: 'query',
                    description: 'Fund mode only: direction to order by date (default desc)',
                    required: false,
                    schema: { type: 'string', enum: [ 'asc', 'desc' ] }
                },
                {
                    name: 'limit',
                    in: 'query',
                    description: 'Fund mode only: limit the number of results (default 1000)',
                    required: false,
                    schema: { type: 'integer', minimum: 1 }
                },
                {
                    name: 'offset',
                    in: 'query',
                    description: 'Fund mode only: number of results to skip (default 0)',
                    required: false,
                    schema: { type: 'integer', minimum: 0 }
                }
            ]

            async parse_request(req) {
                const month = to_ydate(req.query?.month);
                const fund_id = to_int(req.query?.fund_id);

                if ( ( month === undefined ) === ( fund_id === undefined ) ) {
                    throw new HTTPCodeError(400, "Bad parameters: provide exactly one of month or fund_id");
                }

                if ( month !== undefined ) return { month };

                return {
                    fund_id,
                    opts: {
                        since: to_ydate(req.query?.since),
                        until: to_ydate(req.query?.until),
                        order_direction: only_direction(req.query?.order_direction),
                        limit: to_positive_int(req.query?.limit) ?? 1000,
                        offset: to_non_negative_int(req.query?.offset) ?? 0,
                    }
                };
            }

            async respond({ month, fund_id, opts }) {
                const allocations = month !== undefined
                    ? Allocation.for_month(this.db, month)
                    : Allocation.for_fund(this.db, fund_id, opts);
                return allocations.map((a) => a.to_api());
            }

            static openapi_ResponseSchema = {
                type: 'array',
                items: {
                    "$ref": '#/components/schemas/AllocationSchema'
                }
            }

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } }
            ]
        },

        class PutAllocations extends Controller {
            static path = "/allocations";

            static method = "PUT";

            static editor = true;

            static openapi_Summary = "Set Allocation";

            static openapi_Description = "Create-or-replace the fund's allocation for the month (upsert): a transfer of `amount` from the fund's nearest pool ancestor, dated the first of the month. The fund must be tracked, started by the first of the month, and have a started pool ancestor. Finalized months are immutable (409).";

            static openapi_RequestBodySchema = {
                type: 'object',
                properties: {
                    month: { type: 'string', format: 'date', description: MonthParamDescription },
                    fund_id: { type: 'integer', minimum: 1 },
                    amount: { type: 'number', exclusiveMinimum: 0, description: "Currency as a float dollar amount; strictly positive (remove the allocation instead of zeroing it)" }
                },
                required: [ 'month', 'fund_id', 'amount' ]
            }

            async parse_request(req) {
                return parse_body_fields(req.body, [
                    [ "month", only_ydate, "YYYY-MM-DD string", { required: true } ],
                    [ "fund_id", only_id, "positive integer", { required: true } ],
                    [ "amount", only_positive_number, "positive number", { required: true } ],
                ]);
            }

            async respond(data) {
                let allocation;
                try {
                    allocation = Allocation.set(this.db, data);
                } catch (err) {
                    translate_model_error(err);
                }

                const invalidation_actions = allocations_changed();

                this.broadcast_invalidations(invalidation_actions, { fund_id: data.fund_id });

                return {
                    data: allocation.to_api(),
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({ "$ref": '#/components/schemas/AllocationSchema' });

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter (including unknown fund)", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } },
                { code: 409, description: "Conflict (finalized month; untracked/unstarted fund; no started pool ancestor)", schema: { "$ref": '#/components/schemas/ConflictResponseSchema' } }
            ]
        },

        class DeleteAllocations extends Controller {
            static path = "/allocations";

            static method = "DELETE";

            static editor = true;

            static openapi_Summary = "Remove Allocation";

            static openapi_Description = "Remove the fund's allocation for the month (deleting the month's allocation group when it empties). Finalized months are immutable (409).";

            static openapi_Parameters = [
                {
                    name: 'month',
                    in: 'query',
                    description: MonthParamDescription,
                    required: true,
                    schema: { type: 'string', format: 'date' }
                },
                {
                    name: 'fund_id',
                    in: 'query',
                    description: 'The fund whose allocation to remove',
                    required: true,
                    schema: { type: 'integer' }
                }
            ]

            async parse_request(req) {
                const month = to_ydate(req.query?.month);
                const fund_id = to_int(req.query?.fund_id);

                if ( month === undefined || fund_id === undefined ) {
                    throw new HTTPCodeError(400, "Bad parameters: month and fund_id are required");
                }

                return { month, fund_id };
            }

            async respond({ month, fund_id }) {
                try {
                    Allocation.remove(this.db, { month, fund_id });
                } catch (err) {
                    // "Nothing there to remove" is a 404, not a state conflict
                    if ( err instanceof ConflictError && /No allocation exists/.test(err.message) ) {
                        throw new HTTPCodeError(404, err.message);
                    }
                    translate_model_error(err);
                }

                const invalidation_actions = allocations_changed();

                this.broadcast_invalidations(invalidation_actions, { fund_id });

                return {
                    data: null,
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({ "$ref": '#/components/schemas/NullSchema' });

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } },
                { code: 404, description: "No allocation exists for the fund in the month", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } },
                { code: 409, description: "Conflict (finalized month)", schema: { "$ref": '#/components/schemas/ConflictResponseSchema' } }
            ]
        },

        class PostAllocationsCopy extends Controller {
            static path = "/allocations/copy";

            static method = "POST";

            static editor = true;

            static openapi_Summary = "Copy Month Allocations";

            static openapi_Description = "Copy every allocation in `from`'s month into `to`'s month, atomically (the \"same budget as last month\" workflow). `on_conflict` controls funds that already have an allocation in the target month: error (default, 409 listing the funds), merge (keep the target's), or overwrite (take the source's amounts). Sources are re-derived against the current hierarchy, never copied. Returns the target month's resulting allocations.";

            static openapi_RequestBodySchema = {
                type: 'object',
                properties: {
                    from: { type: 'string', format: 'date', description: `Source month: ${MonthParamDescription}` },
                    to: { type: 'string', format: 'date', description: `Target month: ${MonthParamDescription}` },
                    on_conflict: { type: 'string', enum: [ 'error', 'merge', 'overwrite' ], description: "Default error" }
                },
                required: [ 'from', 'to' ]
            }

            async parse_request(req) {
                return parse_body_fields(req.body, [
                    [ "from", only_ydate, "YYYY-MM-DD string", { required: true } ],
                    [ "to", only_ydate, "YYYY-MM-DD string", { required: true } ],
                    [ "on_conflict", (v) => string_to_enum(v, [ "error", "merge", "overwrite" ]), "one of error, merge, overwrite" ],
                ]);
            }

            async respond(data) {
                let allocations;
                try {
                    allocations = Allocation.copy_month(this.db, data);
                } catch (err) {
                    translate_model_error(err);
                }

                const invalidation_actions = allocations_changed();

                this.broadcast_invalidations(invalidation_actions);

                return {
                    data: allocations.map((a) => a.to_api()),
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({
                type: 'array',
                description: "The target month's allocations after the copy",
                items: { "$ref": '#/components/schemas/AllocationSchema' }
            });

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter (including copying a month onto itself)", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } },
                { code: 409, description: "Conflict (finalized target month; on_conflict=error collisions)", schema: { "$ref": '#/components/schemas/ConflictResponseSchema' } }
            ]
        }

    ]
}
