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
    string_to_boolean,
    string_to_enum,
    only_string,
    only_non_empty_string,
    only_boolean,
    only_number,
    only_ydate,
    nullable
} = require("./lib/parsers.js");
const { QK, invalidate, remove, money_moved } = require("./lib/query_keys.mjs");

const BankStatementItem = require("../models/BankStatementItem.js");
const TransactionGroup = require("../models/TransactionGroup.js");

class Controller extends _Controller {

    static StatementIDParam = {
        name: 'statement_id',
        in: 'path',
        description: 'The ID of the bank statement item',
        required: true,
        schema: { type: 'integer' }
    }

    get_statement(req) {
        const statement_id = to_int(req.params.statement_id);
        if ( !statement_id ) throw new HTTPCodeError(404, "Not found");
        return assert_found(BankStatementItem.for_id(this.db, statement_id), `bank statement item ${statement_id}`);
    }
}

module.exports = class StatementsCollection extends Collection {
    static prefix = "/api/statements";

    static openapi_Tags = ["Bank Statements"];

    static controllers = [

        class GetStatements extends Controller {
            static path = "/statements";

            static method = "GET";

            static openapi_Summary = "List Bank Statement Items";

            static openapi_Description = "Get a list of imported bank statement items. Every item is in exactly one of three states: pending (not ignored, not reconciled), ignored, or reconciled (linked to a transaction group). Filter with the raw ignored/has_group flags or the `state` shorthand.";

            static query_key = ["statements"];

            static openapi_Parameters = [
                {
                    name: 'source',
                    in: 'query',
                    description: 'Filter by the bank the item was imported from',
                    required: false,
                    schema: { type: 'string' }
                },
                {
                    name: 'since',
                    in: 'query',
                    description: 'Filter to items dated on or after this date',
                    required: false,
                    schema: { type: 'string', format: 'date' }
                },
                {
                    name: 'until',
                    in: 'query',
                    description: 'Filter to items dated on or before this date',
                    required: false,
                    schema: { type: 'string', format: 'date' }
                },
                {
                    name: 'state',
                    in: 'query',
                    description: 'Shorthand for the derived state: pending (ignored=false, has_group=false), ignored (ignored=true), or reconciled (has_group=true). The raw ignored/has_group parameters override it when both are given.',
                    required: false,
                    schema: { type: 'string', enum: [ 'pending', 'ignored', 'reconciled' ] }
                },
                {
                    name: 'ignored',
                    in: 'query',
                    description: 'Filter by ignored flag',
                    required: false,
                    schema: { type: 'boolean' }
                },
                {
                    name: 'has_group',
                    in: 'query',
                    description: 'Filter by whether the item is reconciled to a transaction group',
                    required: false,
                    schema: { type: 'boolean' }
                },
                {
                    name: 'group_id',
                    in: 'query',
                    description: 'Filter to items reconciled to this transaction group',
                    required: false,
                    schema: { type: 'integer' }
                },
                ...openapi_list_parameters([ 'id', 'date' ])
            ]

            async parse_request(req) {
                const filter = parse_list_params(req.query, [ "id", "date" ]);

                switch ( string_to_enum(req.query?.state, [ "pending", "ignored", "reconciled" ]) ) {
                    case "pending":
                        filter.ignored = false;
                        filter.has_group = false;
                        break;
                    case "ignored":
                        filter.ignored = true;
                        break;
                    case "reconciled":
                        filter.has_group = true;
                        break;
                }

                filter.source = only_non_empty_string(req.query?.source);
                filter.since = to_ydate(req.query?.since);
                filter.until = to_ydate(req.query?.until);
                filter.ignored = string_to_boolean(req.query?.ignored, filter.ignored);
                filter.has_group = string_to_boolean(req.query?.has_group, filter.has_group);
                filter.group_id = to_int(req.query?.group_id);

                return filter;
            }

            async respond(filter, { res }) {
                res.setHeader("X-Total-Count", BankStatementItem.count(this.db, filter));
                return BankStatementItem.from_db(this.db, filter).map((s) => s.to_api());
            }

            static openapi_ResponseHeaders = {
                "X-Total-Count": {
                    description: "The total number of items matching the filter (ignoring limit and offset)",
                    schema: { type: "integer" }
                }
            }

            static openapi_ResponseSchema = {
                type: 'array',
                items: {
                    "$ref": '#/components/schemas/BankStatementItemSchema'
                }
            }
        },

        class GetStatement extends Controller {
            static path = "/statement/:statement_id";

            static method = "GET";

            static openapi_Summary = "Get Bank Statement Item";

            static openapi_Description = "Get a single bank statement item by ID.";

            static query_key = [ "statement", "statement_id" ];

            static openapi_Parameters = [
                this.StatementIDParam
            ]

            async parse_request(req) {
                return this.get_statement(req);
            }

            async respond(item) {
                return item.to_api();
            }

            static openapi_ResponseSchema = {
                "$ref": '#/components/schemas/BankStatementItemSchema'
            }

            static openapi_ErrorResponses = [
                { code: 404, description: "Not found", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } }
            ]
        },

        class PostStatementsImport extends Controller {
            static path = "/statements/import";

            static method = "POST";

            static editor = true;

            static openapi_Summary = "Import Bank Statement Items";

            static openapi_Description = "Idempotent bulk import (the statement re-sync path): items are deduped on (source, key), and existing rows are SKIPPED, never updated -- their ignored/reconciled state survives re-syncs. Returns the created items and the skipped (source, key) pairs.";

            static openapi_RequestBodySchema = {
                type: 'object',
                properties: {
                    items: {
                        type: 'array',
                        minItems: 1,
                        items: {
                            type: 'object',
                            properties: {
                                source: { type: 'string', description: "Which bank this line came from" },
                                key: { type: 'string', description: "Bank-scoped dedupe key; (source, key) is unique" },
                                amount: { type: 'number', description: "Signed currency as a float dollar amount: negative = money leaving the bank account. May not be zero." },
                                date: { type: 'string', format: 'date' },
                                note: { type: 'string', nullable: true }
                            },
                            required: [ 'source', 'key', 'amount', 'date' ]
                        }
                    }
                },
                required: [ 'items' ]
            }

            async parse_request(req) {
                const raw = req.body?.items;
                if ( !Array.isArray(raw) || raw.length < 1 ) {
                    throw new HTTPCodeError(400, "Bad parameter: items (expected non-empty array)");
                }

                const items = raw.map((item, i) => {
                    try {
                        return parse_body_fields(item, [
                            [ "source", only_non_empty_string, "non-empty string", { required: true } ],
                            [ "key", only_non_empty_string, "non-empty string", { required: true } ],
                            [ "amount", only_number, "number", { required: true } ],
                            [ "date", only_ydate, "YYYY-MM-DD string", { required: true } ],
                            [ "note", nullable(only_string), "string or null" ],
                        ]);
                    } catch (err) {
                        if ( err instanceof HTTPCodeError ) throw new HTTPCodeError(400, `items[${i}]: ${err.message}`);
                        throw err;
                    }
                });

                return { items };
            }

            async respond({ items }) {
                let result;
                try {
                    result = BankStatementItem.import_many(this.db, items);
                } catch (err) {
                    translate_model_error(err);
                }

                const invalidation_actions = [
                    invalidate(QK.statements),
                ];

                this.broadcast_invalidations(invalidation_actions);

                return {
                    data: {
                        created: result.created.map((s) => s.to_api()),
                        skipped: result.skipped,
                    },
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({
                type: 'object',
                properties: {
                    created: {
                        type: 'array',
                        items: { "$ref": '#/components/schemas/BankStatementItemSchema' }
                    },
                    skipped: {
                        description: "The (source, key) pairs that already existed and were left untouched",
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                source: { type: 'string' },
                                key: { type: 'string' }
                            },
                            required: [ 'source', 'key' ]
                        }
                    }
                },
                required: [ 'created', 'skipped' ]
            });

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } }
            ]
        },

        class PatchStatement extends Controller {
            static path = "/statement/:statement_id";

            static method = "PATCH";

            static editor = true;

            static openapi_Summary = "Update Bank Statement Item";

            static openapi_Description = "Update an item's ignored flag and/or note -- the only mutable fields (the bank facts source/key/amount/date are immutable; delete and re-import instead). A reconciled item cannot be ignored (409). Use ignored to hide items, NOT deletion.";

            static openapi_Parameters = [
                this.StatementIDParam
            ]

            static openapi_RequestBodySchema = {
                type: 'object',
                properties: {
                    ignored: { type: 'boolean' },
                    note: { type: 'string', nullable: true }
                }
            }

            async parse_request(req) {
                const patch = parse_body_fields(req.body, [
                    [ "ignored", only_boolean, "boolean" ],
                    [ "note", nullable(only_string), "string or null" ],
                ]);

                return { item: this.get_statement(req), patch };
            }

            async respond({ item, patch }) {
                let new_item;
                try {
                    new_item = item.update(this.db, patch);
                } catch (err) {
                    translate_model_error(err);
                }

                const invalidation_actions = [
                    invalidate(QK.statements),
                    invalidate(QK.statement(item.id)),
                ];

                this.broadcast_invalidations(invalidation_actions, { statement_id: item.id });

                return {
                    data: new_item.to_api(),
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({ "$ref": '#/components/schemas/BankStatementItemSchema' });

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } },
                { code: 404, description: "Not found", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } },
                { code: 409, description: "Conflict (ignoring a reconciled item)", schema: { "$ref": '#/components/schemas/ConflictResponseSchema' } }
            ]
        },

        class DeleteStatement extends Controller {
            static path = "/statement/:statement_id";

            static method = "DELETE";

            static editor = true;

            static openapi_Summary = "Delete Bank Statement Item";

            static openapi_Description = "Delete a bank statement item -- and, with with_group (the DEFAULT), the transaction group reconciling it (a transfer peer item is released back to pending, not deleted). WARNING: deletion is for undoing bad imports, NOT for hiding items (use ignored). The item's dedupe row is destroyed, so the next re-sync re-imports it as pending -- reconciling it again would double-count. Groups in finalized months cannot be destroyed (409).";

            static openapi_Parameters = [
                this.StatementIDParam,
                {
                    name: 'with_group',
                    in: 'query',
                    description: 'Also delete the reconciling transaction group and its transactions (default true)',
                    required: false,
                    schema: { type: 'boolean' }
                }
            ]

            async parse_request(req) {
                return {
                    item: this.get_statement(req),
                    with_group: string_to_boolean(req.query?.with_group, true),
                };
            }

            async respond({ item, with_group }) {
                try {
                    TransactionGroup.delete_statement_item(this.db, item, { with_group });
                } catch (err) {
                    translate_model_error(err);
                }

                const invalidation_actions = [
                    invalidate(QK.statements),
                    remove(QK.statement(item.id)),
                ];
                if ( with_group && item.group_id != null ) {
                    invalidation_actions.push(
                        ...money_moved(),
                        remove(QK.transaction_group(item.group_id)),
                    );
                }

                this.broadcast_invalidations(invalidation_actions, { statement_id: item.id });

                return {
                    data: null,
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({ "$ref": '#/components/schemas/NullSchema' });

            static openapi_ErrorResponses = [
                { code: 404, description: "Not found", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } },
                { code: 409, description: "Conflict (group in a finalized month)", schema: { "$ref": '#/components/schemas/ConflictResponseSchema' } }
            ]
        }

    ]
}
