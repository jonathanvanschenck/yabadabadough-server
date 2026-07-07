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
    only_string,
    only_non_empty_string,
    only_id,
    only_positive_number,
    only_ydate,
    nullable
} = require("./lib/parsers.js");
const { QK, invalidate, remove, money_moved } = require("./lib/query_keys.js");

const TransactionGroup = require("../models/TransactionGroup.js");
const Transaction = require("../models/Transaction.js");

/**
 * Validate a `transactions` array (group-creation bodies, and the line
 * editor's `add` array via `label`/`allow_empty`). USER transaction amounts
 * are strictly positive at this layer (the models permit zero only for
 * internal eom_cleanup transactions).
 */
function parse_transaction_specs(raw, { label = "transactions", allow_empty = false }={}) {
    if ( raw === undefined && allow_empty ) return [];
    if ( !Array.isArray(raw) || (!allow_empty && raw.length < 1) ) {
        throw new HTTPCodeError(400, `Bad parameter: ${label} (expected ${allow_empty ? "array" : "non-empty array"})`);
    }
    return raw.map((spec, i) => {
        try {
            return parse_body_fields(spec, [
                [ "source_fund_id", only_id, "positive integer", { required: true } ],
                [ "target_fund_id", only_id, "positive integer", { required: true } ],
                [ "amount", only_positive_number, "positive number", { required: true } ],
                [ "description", only_non_empty_string, "non-empty string", { required: true } ],
                [ "note", nullable(only_string), "string or null" ],
            ]);
        } catch (err) {
            if ( err instanceof HTTPCodeError ) throw new HTTPCodeError(400, `${label}[${i}]: ${err.message}`);
            throw err;
        }
    });
}

/**
 * Validate the line editor's `update` array: each element names an existing
 * transaction by id plus the in-place changes (same strict field rules as
 * creation, but everything optional).
 */
function parse_transaction_updates(raw) {
    if ( raw === undefined ) return [];
    if ( !Array.isArray(raw) ) {
        throw new HTTPCodeError(400, "Bad parameter: update (expected array)");
    }
    return raw.map((spec, i) => {
        try {
            return parse_body_fields(spec, [
                [ "id", only_id, "positive integer", { required: true } ],
                [ "amount", only_positive_number, "positive number" ],
                [ "source_fund_id", only_id, "positive integer" ],
                [ "target_fund_id", only_id, "positive integer" ],
                [ "description", only_non_empty_string, "non-empty string" ],
                [ "note", nullable(only_string), "string or null" ],
            ]);
        } catch (err) {
            if ( err instanceof HTTPCodeError ) throw new HTTPCodeError(400, `update[${i}]: ${err.message}`);
            throw err;
        }
    });
}

function parse_id_array(raw, label) {
    if ( raw === undefined ) return [];
    if ( !Array.isArray(raw) || raw.some((id) => only_id(id) === undefined) ) {
        throw new HTTPCodeError(400, `Bad parameter: ${label} (expected array of positive integers)`);
    }
    return raw;
}

const TransactionSpecSchema = {
    type: 'object',
    properties: {
        source_fund_id: { type: 'integer', minimum: 1 },
        target_fund_id: { type: 'integer', minimum: 1 },
        amount: { type: 'number', exclusiveMinimum: 0, description: "Currency as a float dollar amount; strictly positive" },
        description: { type: 'string' },
        note: { type: 'string', nullable: true }
    },
    required: [ 'source_fund_id', 'target_fund_id', 'amount', 'description' ]
};

const TransactionUpdateSpecSchema = {
    type: 'object',
    properties: {
        id: { type: 'integer', minimum: 1, description: "The id of a transaction belonging to this group" },
        source_fund_id: { type: 'integer', minimum: 1 },
        target_fund_id: { type: 'integer', minimum: 1 },
        amount: { type: 'number', exclusiveMinimum: 0, description: "Currency as a float dollar amount; strictly positive" },
        description: { type: 'string' },
        note: { type: 'string', nullable: true }
    },
    required: [ 'id' ]
};

class Controller extends _Controller {

    static GroupIDParam = {
        name: 'group_id',
        in: 'path',
        description: 'The ID of the transaction group',
        required: true,
        schema: { type: 'integer' }
    }

    static TransactionIDParam = {
        name: 'transaction_id',
        in: 'path',
        description: 'The ID of the transaction',
        required: true,
        schema: { type: 'integer' }
    }

    get_group(req) {
        const group_id = to_int(req.params.group_id);
        if ( !group_id ) throw new HTTPCodeError(404, "Not found");
        return assert_found(TransactionGroup.for_id(this.db, group_id), `transaction group ${group_id}`);
    }

    get_transaction(req) {
        const transaction_id = to_int(req.params.transaction_id);
        if ( !transaction_id ) throw new HTTPCodeError(404, "Not found");
        return assert_found(Transaction.for_id(this.db, transaction_id), `transaction ${transaction_id}`);
    }

    // The internal group kinds cannot be edited through this API (mirrors the
    // DELETE endpoint's allocation guard); the model refusals back this up
    assert_group_editable(group) {
        if ( group.allocation ) {
            throw new HTTPCodeError(409, "Allocation groups are managed via the allocations API");
        }
        if ( group.eom_cleanup ) {
            throw new HTTPCodeError(409, "EOM cleanup groups cannot be edited");
        }
    }

    assert_transaction_editable(transaction) {
        if ( transaction.allocation ) {
            throw new HTTPCodeError(409, "Allocation transactions are managed via the allocations API");
        }
        if ( transaction.eom_cleanup_id != null ) {
            throw new HTTPCodeError(409, "EOM cleanup transactions cannot be edited");
        }
    }
}

module.exports = class TransactionsCollection extends Collection {
    static prefix = "/api/transactions";

    static openapi_Tags = ["Transactions"];

    static controllers = [

        class GetTransactionGroups extends Controller {
            static path = "/transaction-groups";

            static method = "GET";

            static openapi_Summary = "List Transaction Groups";

            static openapi_Description = "Get a list of transaction groups (each hydrated with its transactions and any reconciled bank statement items). You can filter and sort the results using query parameters.";

            static query_key = ["transaction-groups"];

            static openapi_Parameters = [
                {
                    name: 'since',
                    in: 'query',
                    description: 'Filter to groups dated on or after this date',
                    required: false,
                    schema: { type: 'string', format: 'date' }
                },
                {
                    name: 'until',
                    in: 'query',
                    description: 'Filter to groups dated on or before this date',
                    required: false,
                    schema: { type: 'string', format: 'date' }
                },
                {
                    name: 'split',
                    in: 'query',
                    description: 'Filter by split status (more than one transaction)',
                    required: false,
                    schema: { type: 'boolean' }
                },
                {
                    name: 'allocation',
                    in: 'query',
                    description: 'Filter by allocation status (start-of-month allocation groups)',
                    required: false,
                    schema: { type: 'boolean' }
                },
                {
                    name: 'eom_cleanup',
                    in: 'query',
                    description: 'Filter by eom_cleanup status (end-of-month cleanup groups)',
                    required: false,
                    schema: { type: 'boolean' }
                },
                {
                    name: 'has_statements',
                    in: 'query',
                    description: 'Filter by whether any bank statement items are reconciled to the group',
                    required: false,
                    schema: { type: 'boolean' }
                },
                {
                    name: 'description_like',
                    in: 'query',
                    description: 'Filter by description using a case-insensitive substring match',
                    required: false,
                    schema: { type: 'string' }
                },
                ...openapi_list_parameters([ 'id', 'date' ])
            ]

            async parse_request(req) {
                const filter = parse_list_params(req.query, [ "id", "date" ]);

                filter.since = to_ydate(req.query?.since);
                filter.until = to_ydate(req.query?.until);
                filter.split = string_to_boolean(req.query?.split);
                filter.allocation = string_to_boolean(req.query?.allocation);
                filter.eom_cleanup = string_to_boolean(req.query?.eom_cleanup);
                filter.has_statements = string_to_boolean(req.query?.has_statements);
                filter.description_like = only_string(req.query?.description_like);

                return filter;
            }

            async respond(filter, { res }) {
                res.setHeader("X-Total-Count", TransactionGroup.count(this.db, filter));
                return TransactionGroup.from_db(this.db, filter).map((g) => g.to_api());
            }

            static openapi_ResponseHeaders = {
                "X-Total-Count": {
                    description: "The total number of groups matching the filter (ignoring limit and offset)",
                    schema: { type: "integer" }
                }
            }

            static openapi_ResponseSchema = {
                type: 'array',
                items: {
                    "$ref": '#/components/schemas/TransactionGroupSchema'
                }
            }
        },

        class GetTransactionGroup extends Controller {
            static path = "/transaction-group/:group_id";

            static method = "GET";

            static openapi_Summary = "Get Transaction Group";

            static openapi_Description = "Get a single transaction group by ID, hydrated with its transactions and any reconciled bank statement items.";

            static query_key = [ "transaction-group", "group_id" ];

            static openapi_Parameters = [
                this.GroupIDParam
            ]

            async parse_request(req) {
                return this.get_group(req);
            }

            async respond(group) {
                return group.to_api();
            }

            static openapi_ResponseSchema = {
                "$ref": '#/components/schemas/TransactionGroupSchema'
            }

            static openapi_ErrorResponses = [
                { code: 404, description: "Not found", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } }
            ]
        },

        class PostTransactionGroups extends Controller {
            static path = "/transaction-groups";

            static method = "POST";

            static editor = true;

            static openapi_Summary = "Create Transaction Group";

            static openapi_Description = "Create a transaction group holding one or more transactions (one = an ordinary expense/transfer, several = a split). Transactions may not be dated in a finalized month or before their funds' start dates. The internal allocation/eom_cleanup group kinds cannot be created here (use the allocations / finalizations APIs).";

            static openapi_RequestBodySchema = {
                type: 'object',
                properties: {
                    date: { type: 'string', format: 'date' },
                    description: { type: 'string' },
                    note: { type: 'string', nullable: true },
                    transactions: {
                        type: 'array',
                        minItems: 1,
                        items: TransactionSpecSchema
                    }
                },
                required: [ 'date', 'description', 'transactions' ]
            }

            async parse_request(req) {
                const data = parse_body_fields(req.body, [
                    [ "date", only_ydate, "YYYY-MM-DD string", { required: true } ],
                    [ "description", only_non_empty_string, "non-empty string", { required: true } ],
                    [ "note", nullable(only_string), "string or null" ],
                ]);

                data.transactions = parse_transaction_specs(req.body?.transactions);

                return data;
            }

            async respond(data) {
                let group;
                try {
                    group = TransactionGroup.create(this.db, data);
                } catch (err) {
                    translate_model_error(err);
                }

                const invalidation_actions = money_moved();

                this.broadcast_invalidations(invalidation_actions, { group_id: group.id });

                return {
                    data: group.to_api(),
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({ "$ref": '#/components/schemas/TransactionGroupSchema' });

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } },
                { code: 409, description: "Conflict (e.g. finalized month)", schema: { "$ref": '#/components/schemas/ConflictResponseSchema' } }
            ]
        },

        class PostTransactionGroupsFromStatements extends Controller {
            static path = "/transaction-groups/from-statements";

            static method = "POST";

            static editor = true;

            static openapi_Summary = "Create Transaction Group from Bank Statement Items (Reconcile)";

            static openapi_Description = "Create a transaction group reconciling one or more PENDING bank statement items (one id normally; both sides' ids for a transfer between two imported accounts). The group's date defaults to the LATEST item date and its description to the items' notes (falling back to their keys). Unlinking is only possible by deleting the group.";

            static openapi_RequestBodySchema = {
                type: 'object',
                properties: {
                    statement_ids: {
                        type: 'array',
                        minItems: 1,
                        items: { type: 'integer', minimum: 1 },
                        description: "The pending bank statement items to reconcile (not ignored, not already linked)"
                    },
                    date: { type: 'string', format: 'date', nullable: true, description: "Defaults to the latest item date" },
                    description: { type: 'string', nullable: true, description: "Defaults to the items' notes (fallback: keys)" },
                    note: { type: 'string', nullable: true },
                    transactions: {
                        type: 'array',
                        minItems: 1,
                        items: TransactionSpecSchema
                    }
                },
                required: [ 'statement_ids', 'transactions' ]
            }

            async parse_request(req) {
                const data = parse_body_fields(req.body, [
                    [ "date", nullable(only_ydate), "YYYY-MM-DD string or null" ],
                    [ "description", nullable(only_non_empty_string), "non-empty string or null" ],
                    [ "note", nullable(only_string), "string or null" ],
                ]);

                const raw_ids = req.body?.statement_ids;
                if ( !Array.isArray(raw_ids) || raw_ids.length < 1 || raw_ids.some((id) => only_id(id) === undefined) ) {
                    throw new HTTPCodeError(400, "Bad parameter: statement_ids (expected non-empty array of positive integers)");
                }
                data.statement_ids = raw_ids;

                data.transactions = parse_transaction_specs(req.body?.transactions);

                return data;
            }

            async respond(data) {
                let group;
                try {
                    group = TransactionGroup.create_from_statements(this.db, data);
                } catch (err) {
                    translate_model_error(err);
                }

                const invalidation_actions = [
                    ...money_moved(),
                    invalidate(QK.statements),
                ];

                this.broadcast_invalidations(invalidation_actions, { group_id: group.id });

                return {
                    data: group.to_api(),
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({ "$ref": '#/components/schemas/TransactionGroupSchema' });

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter (including unknown statement ids)", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } },
                { code: 409, description: "Conflict (finalized month; item ignored or already reconciled)", schema: { "$ref": '#/components/schemas/ConflictResponseSchema' } }
            ]
        },

        class DeleteTransactionGroup extends Controller {
            static path = "/transaction-group/:group_id";

            static method = "DELETE";

            static editor = true;

            static openapi_Summary = "Delete Transaction Group";

            static openapi_Description = "Delete a transaction group and all of its transactions (the only way to unlink reconciled bank statement items, which are released back to pending). Groups in finalized months cannot be deleted (409) -- this inherently protects eom_cleanup groups. Allocation groups are managed via the allocations API and cannot be deleted here (409). There is no update: delete and re-create instead.";

            static openapi_Parameters = [
                this.GroupIDParam
            ]

            async parse_request(req) {
                return this.get_group(req);
            }

            async respond(group) {
                if ( group.allocation ) {
                    throw new HTTPCodeError(409, "Allocation groups are managed via the allocations API");
                }

                try {
                    group.delete(this.db);
                } catch (err) {
                    translate_model_error(err);
                }

                const invalidation_actions = [
                    ...money_moved(),
                    remove(QK.transaction_group(group.id)),
                ];
                // Any reconciled items were released back to pending
                if ( group.statements.length ) invalidation_actions.push(invalidate(QK.statements));

                this.broadcast_invalidations(invalidation_actions, { group_id: group.id });

                return {
                    data: null,
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({ "$ref": '#/components/schemas/NullSchema' });

            static openapi_ErrorResponses = [
                { code: 404, description: "Not found", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } },
                { code: 409, description: "Conflict (finalized month; allocation group)", schema: { "$ref": '#/components/schemas/ConflictResponseSchema' } }
            ]
        },

        class PatchTransactionGroup extends Controller {
            static path = "/transaction-group/:group_id";

            static method = "PATCH";

            static editor = true;

            static openapi_Summary = "Update Transaction Group";

            static openapi_Description = "Update a transaction group's scalar fields in place: description, note, and/or date. A date change cascades to every transaction in the group (re-checking their funds' start dates) and may not move the group into -- or out of -- a finalized month (409). The group's id is stable, so bank statement reconciliation survives (this is the reason to prefer updates over delete-and-recreate). Allocation and eom_cleanup groups cannot be edited here (409). Adding/removing/editing the group's transactions goes through PATCH .../transactions.";

            static openapi_Parameters = [
                this.GroupIDParam
            ]

            static openapi_RequestBodySchema = {
                type: 'object',
                properties: {
                    description: { type: 'string' },
                    note: { type: 'string', nullable: true },
                    date: { type: 'string', format: 'date', description: "Cascades to every transaction in the group" }
                }
            }

            async parse_request(req) {
                const group = this.get_group(req);
                const data = parse_body_fields(req.body, [
                    [ "description", only_non_empty_string, "non-empty string" ],
                    [ "note", nullable(only_string), "string or null" ],
                    [ "date", only_ydate, "YYYY-MM-DD string" ],
                ]);
                return { group, data };
            }

            async respond({ group, data }) {
                this.assert_group_editable(group);

                let updated;
                try {
                    updated = group.update(this.db, data);
                } catch (err) {
                    translate_model_error(err);
                }

                // A date change moves money between periods; description/note
                // cannot, so skip the balance refetch for cosmetic edits
                const invalidation_actions = data.date !== undefined ? [
                    ...money_moved(),
                    invalidate(QK.transaction_group(group.id)),
                ] : [
                    invalidate(QK.transaction_groups),
                    invalidate(QK.transaction_group(group.id)),
                ];
                // The hydrated statements ride on the group
                if ( data.date !== undefined && group.statements.length ) {
                    invalidation_actions.push(invalidate(QK.statements));
                }

                this.broadcast_invalidations(invalidation_actions, { group_id: group.id });

                return {
                    data: updated.to_api(),
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({ "$ref": '#/components/schemas/TransactionGroupSchema' });

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } },
                { code: 404, description: "Not found", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } },
                { code: 409, description: "Conflict (finalized month; allocation/eom_cleanup group; date predates a fund's start date)", schema: { "$ref": '#/components/schemas/ConflictResponseSchema' } }
            ]
        },

        class PatchTransactionGroupTransactions extends Controller {
            static path = "/transaction-group/:group_id/transactions";

            static method = "PATCH";

            static editor = true;

            static openapi_Summary = "Edit Transaction Group Transactions (Add/Update/Remove)";

            static openapi_Description = "Edit the group's transactions in one atomic batch: `add` new transactions (they take the group's date), `update` existing ones in place (amount, funds, description, note), and/or `remove` others. Every referenced id must belong to this group and may be referenced only once. The group must keep at least one transaction -- to empty it, DELETE the group instead. The group's id is stable, so bank statement reconciliation survives. Groups in finalized months and allocation/eom_cleanup groups cannot be edited (409).";

            static openapi_Parameters = [
                this.GroupIDParam
            ]

            static openapi_RequestBodySchema = {
                type: 'object',
                properties: {
                    add: {
                        type: 'array',
                        items: TransactionSpecSchema,
                        description: "New transactions to insert (dated the group's date)"
                    },
                    update: {
                        type: 'array',
                        items: TransactionUpdateSpecSchema,
                        description: "In-place edits to transactions already in the group"
                    },
                    remove: {
                        type: 'array',
                        items: { type: 'integer', minimum: 1 },
                        description: "Ids of transactions (in this group) to delete"
                    }
                }
            }

            async parse_request(req) {
                const group = this.get_group(req);

                const ops = {
                    add: parse_transaction_specs(req.body?.add, { label: "add", allow_empty: true }),
                    update: parse_transaction_updates(req.body?.update),
                    remove: parse_id_array(req.body?.remove, "remove"),
                };
                if ( ops.add.length + ops.update.length + ops.remove.length < 1 ) {
                    throw new HTTPCodeError(400, "Missing parameter: at least one of add, update, remove");
                }

                return { group, ops };
            }

            async respond({ group, ops }) {
                this.assert_group_editable(group);

                let updated;
                try {
                    updated = TransactionGroup.edit_transactions(this.db, group, ops);
                } catch (err) {
                    translate_model_error(err);
                }

                const invalidation_actions = [
                    ...money_moved(),
                    invalidate(QK.transaction_group(group.id)),
                    ...ops.remove.map((id) => remove(QK.transaction(id))),
                ];

                this.broadcast_invalidations(invalidation_actions, { group_id: group.id });

                return {
                    data: updated.to_api(),
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({ "$ref": '#/components/schemas/TransactionGroupSchema' });

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter (including ids not in this group, an id referenced twice, or emptying the group)", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } },
                { code: 404, description: "Not found", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } },
                { code: 409, description: "Conflict (finalized month; allocation/eom_cleanup group)", schema: { "$ref": '#/components/schemas/ConflictResponseSchema' } }
            ]
        },

        class GetTransactions extends Controller {
            static path = "/transactions";

            static method = "GET";

            static openapi_Summary = "List Transactions";

            static openapi_Description = "Get a flat list of transactions across groups (transactions are created and deleted through their groups; existing ones may be edited in place via PATCH). You can filter and sort the results using query parameters.";

            static query_key = ["transactions"];

            static openapi_Parameters = [
                {
                    name: 'source_fund_id',
                    in: 'query',
                    description: 'Filter by source fund',
                    required: false,
                    schema: { type: 'integer' }
                },
                {
                    name: 'target_fund_id',
                    in: 'query',
                    description: 'Filter by target fund',
                    required: false,
                    schema: { type: 'integer' }
                },
                {
                    name: 'involving_fund_id',
                    in: 'query',
                    description: 'Filter to transactions where the fund is either source or target',
                    required: false,
                    schema: { type: 'integer' }
                },
                {
                    name: 'group_id',
                    in: 'query',
                    description: 'Filter by transaction group',
                    required: false,
                    schema: { type: 'integer' }
                },
                {
                    name: 'since',
                    in: 'query',
                    description: 'Filter to transactions dated on or after this date',
                    required: false,
                    schema: { type: 'string', format: 'date' }
                },
                {
                    name: 'until',
                    in: 'query',
                    description: 'Filter to transactions dated on or before this date',
                    required: false,
                    schema: { type: 'string', format: 'date' }
                },
                {
                    name: 'allocation',
                    in: 'query',
                    description: 'Filter by allocation status',
                    required: false,
                    schema: { type: 'boolean' }
                },
                {
                    name: 'description_like',
                    in: 'query',
                    description: 'Filter by description using a case-insensitive substring match',
                    required: false,
                    schema: { type: 'string' }
                },
                ...openapi_list_parameters([ 'id', 'date' ])
            ]

            async parse_request(req) {
                const filter = parse_list_params(req.query, [ "id", "date" ]);

                filter.source_fund_id = to_int(req.query?.source_fund_id);
                filter.target_fund_id = to_int(req.query?.target_fund_id);
                filter.involving_fund_id = to_int(req.query?.involving_fund_id);
                filter.group_id = to_int(req.query?.group_id);
                filter.since = to_ydate(req.query?.since);
                filter.until = to_ydate(req.query?.until);
                filter.allocation = string_to_boolean(req.query?.allocation);
                filter.description_like = only_string(req.query?.description_like);

                return filter;
            }

            async respond(filter, { res }) {
                res.setHeader("X-Total-Count", Transaction.count(this.db, filter));
                return Transaction.from_db(this.db, filter).map((t) => t.to_api());
            }

            static openapi_ResponseHeaders = {
                "X-Total-Count": {
                    description: "The total number of transactions matching the filter (ignoring limit and offset)",
                    schema: { type: "integer" }
                }
            }

            static openapi_ResponseSchema = {
                type: 'array',
                items: {
                    "$ref": '#/components/schemas/TransactionSchema'
                }
            }
        },

        class GetTransaction extends Controller {
            static path = "/transaction/:transaction_id";

            static method = "GET";

            static openapi_Summary = "Get Transaction";

            static openapi_Description = "Get a single transaction by ID.";

            static query_key = [ "transaction", "transaction_id" ];

            static openapi_Parameters = [
                this.TransactionIDParam
            ]

            async parse_request(req) {
                return this.get_transaction(req);
            }

            async respond(transaction) {
                return transaction.to_api();
            }

            static openapi_ResponseSchema = {
                "$ref": '#/components/schemas/TransactionSchema'
            }

            static openapi_ErrorResponses = [
                { code: 404, description: "Not found", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } }
            ]
        },

        class PatchTransaction extends Controller {
            static path = "/transaction/:transaction_id";

            static method = "PATCH";

            static editor = true;

            static openapi_Summary = "Update Transaction";

            static openapi_Description = "Edit a single transaction in place: amount, source/target funds, description, and/or note. The transaction's date is a group-level fact -- change it via PATCH on the group. Creating and deleting transactions also goes through the group (PATCH .../transaction-group/:group_id/transactions). Transactions in finalized months and allocation/eom_cleanup transactions cannot be edited (409).";

            static openapi_Parameters = [
                this.TransactionIDParam
            ]

            static openapi_RequestBodySchema = {
                type: 'object',
                properties: {
                    source_fund_id: { type: 'integer', minimum: 1 },
                    target_fund_id: { type: 'integer', minimum: 1 },
                    amount: { type: 'number', exclusiveMinimum: 0, description: "Currency as a float dollar amount; strictly positive" },
                    description: { type: 'string' },
                    note: { type: 'string', nullable: true }
                }
            }

            async parse_request(req) {
                const transaction = this.get_transaction(req);
                const data = parse_body_fields(req.body, [
                    [ "amount", only_positive_number, "positive number" ],
                    [ "source_fund_id", only_id, "positive integer" ],
                    [ "target_fund_id", only_id, "positive integer" ],
                    [ "description", only_non_empty_string, "non-empty string" ],
                    [ "note", nullable(only_string), "string or null" ],
                ]);
                return { transaction, data };
            }

            async respond({ transaction, data }) {
                this.assert_transaction_editable(transaction);

                let updated;
                try {
                    updated = transaction.update(this.db, data);
                } catch (err) {
                    translate_model_error(err);
                }

                // Amount/fund changes move money; description/note cannot,
                // so skip the balance refetch for cosmetic edits
                const money_changed = data.amount !== undefined
                    || data.source_fund_id !== undefined
                    || data.target_fund_id !== undefined;
                const invalidation_actions = [
                    ...(money_changed ? money_moved() : [ invalidate(QK.transactions) ]),
                    invalidate(QK.transaction(transaction.id)),
                    // The group embeds its transactions in to_api()
                    invalidate(QK.transaction_group(transaction.group_id)),
                ];
                if ( !money_changed ) invalidation_actions.push(invalidate(QK.transaction_groups));

                this.broadcast_invalidations(invalidation_actions, { transaction_id: transaction.id });

                return {
                    data: updated.to_api(),
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({ "$ref": '#/components/schemas/TransactionSchema' });

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } },
                { code: 404, description: "Not found", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } },
                { code: 409, description: "Conflict (finalized month; allocation/eom_cleanup transaction; source == target; fund start-date violation)", schema: { "$ref": '#/components/schemas/ConflictResponseSchema' } }
            ]
        }

    ]
}
