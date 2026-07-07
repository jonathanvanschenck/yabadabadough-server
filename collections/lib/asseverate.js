
const { Logger } = require("yalls");

const { Collection: _Collection, Controller: _Controller, Handler: _Handler, Middleware: _Middleware, HTTPCodeError } = require("asseverate");

const { ConflictError, ForeignKeyError } = require("../../lib/db.js");
const { string_to_enum, only_direction, to_positive_int, to_non_negative_int } = require("./parsers.js");

class HTTPCodeErrorDetailed extends Error /* NOT HTTPCodeError, otherwise asseverate default error handler will catch it */ {
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
    }
}

/**
 * Validate/normalize a request body against a field spec:
 *
 *   fields: [ [ key, parser, expected, { required=false }={} ], ... ]
 *
 * - key absent from body: skipped (400 `Missing parameter` when required)
 * - parser returns undefined: 400 `Bad parameter: <key> (got ... expected <expected>)`
 * - otherwise the PARSED value lands on the returned object
 *
 * Parsers signal failure by returning undefined (every parsers.js parser
 * defaults its fallback to undefined), so transforming parsers (only_ydate)
 * work the same as identity parsers (only_non_empty_string). Bodies should
 * use the strict only_* parsers -- the coercive to_* parsers are for query
 * strings.
 */
function parse_body_fields(body={}, fields=[]) {
    const data = {};
    for ( const [ key, parser, expected, { required=false }={} ] of fields ) {
        if ( body?.[key] === undefined ) {
            if ( required ) throw new HTTPCodeError(400, `Missing parameter: ${key} (expected ${expected})`);
            continue;
        }
        const parsed = parser(body[key]);
        if ( parsed === undefined ) throw new HTTPCodeError(400, `Bad parameter: ${key} (got '${JSON.stringify(body[key])}' expected ${expected})`);
        data[key] = parsed;
    }
    return data;
}

/**
 * 404 helper for path-id lookups: returns `value` unless it is null/undefined.
 */
function assert_found(value, label) {
    if ( value == null ) throw new HTTPCodeError(404, `Not found: ${label}`);
    return value;
}

/**
 * The write-path error mapper. Wrap ONLY the model create/update/delete call
 * (never a whole handler), e.g.:
 *
 *     try { fund = Fund.create(this.db, data); }
 *     catch (err) { translate_model_error(err); }
 *
 * - ConflictError   -> 409 (duplicate / immutable-history / state conflicts)
 * - ForeignKeyError -> 400 (bad reference in the body; path ids 404 earlier
 *                     via assert_found)
 * - plain Error     -> 400 (the models' consistency checks throw bare Errors;
 *                     the constructor check keeps TypeError & friends -- real
 *                     bugs -- flowing through to the 500 handler)
 */
function translate_model_error(err) {
    if ( err instanceof ConflictError ) throw new HTTPCodeError(409, err.message);
    if ( err instanceof ForeignKeyError ) throw new HTTPCodeError(400, err.message);
    if ( err.constructor === Error ) throw new HTTPCodeError(400, err.message);
    throw err;
}

/**
 * The shared list-endpoint query params (order_by/order_direction/limit/
 * offset), parsed leniently: invalid values fall back to the model's
 * defaults (order_by/order_direction as undefined -- the from_db default
 * parameter kicks in) or the endpoint's default limit. The model's
 * ORDER_BY_MAP whitelist is what actually reaches the SQL string -- NEVER
 * pass raw user input as order_by.
 */
function parse_list_params(query, order_by_values, { default_limit=1000 }={}) {
    return {
        order_by: string_to_enum(query?.order_by, order_by_values),
        order_direction: only_direction(query?.order_direction),
        limit: to_positive_int(query?.limit) ?? default_limit,
        offset: to_non_negative_int(query?.offset) ?? 0,
    };
}

/**
 * The matching openapi parameter objects for parse_list_params.
 */
function openapi_list_parameters(order_by_values, { default_limit=1000 }={}) {
    return [
        {
            name: 'order_by',
            in: 'query',
            description: `Field to order by (${order_by_values.join(", ")})`,
            required: false,
            schema: { type: 'string', enum: order_by_values }
        },
        {
            name: 'order_direction',
            in: 'query',
            description: 'Direction to order results (asc or desc)',
            required: false,
            schema: { type: 'string', enum: [ 'asc', 'desc' ] }
        },
        {
            name: 'limit',
            in: 'query',
            description: `Limit the number of results returned (default ${default_limit})`,
            required: false,
            schema: { type: 'integer', minimum: 1 }
        },
        {
            name: 'offset',
            in: 'query',
            description: 'Number of results to skip for pagination (default 0)',
            required: false,
            schema: { type: 'integer', minimum: 0 }
        }
    ];
}

/**
 * The response schema every write endpoint shares: the affected resource
 * (or null for deletes) plus the invalidation actions the webapp should
 * apply to its tanstack-query cache.
 */
function data_invalidations_response(data_schema) {
    return {
        type: 'object',
        properties: {
            data: data_schema,
            invalidations: { "$ref": '#/components/schemas/InvalidationArraySchema' }
        },
        required: [ 'data', 'invalidations' ]
    };
}

function log_error(log, error) {
    log.error("Uncaught error:");
    const stack = error.stack.split("\n").filter((x) => x);
    for ( let i = 0; i < stack.length; i++ ) {
        log.error(`  ${i==(stack.length-1)?"└":"├"}── ${stack[i]}`);
    }
}

class Collection extends _Collection {
    static openapi_Tags = [];

    init({ log, invalidator }) {
        this.log = log?.create_child(this.constructor.name) ?? Logger.noop();
        this.invalidator = invalidator;
    }
}

class Handler extends _Handler {
    init({ log, invalidator }) {
        this.log = log?.create_child(this.constructor.name) ?? Logger.noop();
        this.invalidator = invalidator;
    }

    async handle_error(response, error) {
        if ( error instanceof HTTPCodeErrorDetailed ) {
            return this.send_message(
                response,
                error.code,
                {
                    message: error.message,
                    details: error.details
                }
            );
        }

        log_error(this.log, error);
        return super.handle_error(response, error);
    }
}

class Middleware extends _Middleware {
    init({ log, invalidator }) {
        this.log = log?.create_child(this.constructor.name) ?? Logger.noop();
        this.invalidator = invalidator;
    }

    async handle_error(response, error) {
        if ( error instanceof HTTPCodeErrorDetailed ) {
            return this.send_message(
                response,
                error.code,
                {
                    message: error.message,
                    details: error.details
                }
            );
        }

        log_error(this.log, error);
        return super.handle_error(response, error);
    }

}

class Controller extends _Controller {
    static access = true;

    static admin = false;

    static editor = false;

    static reader = true;

    static openapi_Summary = "";

    static openapi_Description = "";

    static openapi_Tags = [];

    static openapi_get_security() {
        if ( this.access ) {
            return [
                { AccessToken: [] },
                { CookieAccessToken: [] }
            ];
        }
        return [];
    }

    static openapi_Parameters = []; // [{ name, in, required, schema }]

    static openapi_get_parameters() {
        if ( !this.admin ) return this.openapi_Parameters;
        return [
            {
                name: "X-Sudo-Mode",
                in: "header",
                required: true,
                schema: { type: "string", enum: ["true"] },
                description: "All admin API calls require BOTH the admin priviledge AND the X-Sudo-Mode header set to true. This is to prevent accidental admin API calls, particularly in the webapp, where it is not always clear which API calls are potentially hazardous."
            },
            ...this.openapi_Parameters
        ];
    }

    static openapi_RequestBodySchema = null; // { content_type, optional, description, ...schema }

    static openapi_get_request_body() {
        if ( !this.openapi_RequestBodySchema ) return undefined;
        return {
            description: this.openapi_RequestBodySchema.description,
            required: !this.openapi_RequestBodySchema.optional,
            content: {
                [this.openapi_RequestBodySchema.content_type||"application/json"]: {
                    schema: {
                        ...this.openapi_RequestBodySchema,
                        // Clean out custom properties
                        content_type: undefined,
                        optional: undefined,
                        description: undefined
                    }
                }
            }
        };
    }

    static openapi_ResponseDescription = undefined; // Description of the response

    static openapi_ResponseSchema = undefined; // Set to { content_type, ...schema }||(null for no content) to enable automatic response schema documentation

    static openapi_ResponseHeaders = undefined; // { [header_name]: { description, schema } }

    static openapi_ErrorResponses = []; // [{ code, description, content_type, schema }]

    static openapi_get_responses() {
        if ( this.openapi_ResponseSchema === undefined ) return null;
        const error_responses = JSON.parse(JSON.stringify(this.openapi_ErrorResponses || []));
        if ( this.access ) {
            error_responses.push({
                code: 401,
                description: "Unauthorized: Request lacked necessary access token",
                schema: { "$ref": '#/components/schemas/UnauthorizedResponseSchema' }
            });
        }
        if ( this.admin || this.editor || this.reader ) {
            error_responses.push({
                code: 403,
                description: "Forbidden: Request lacked necessary permissions",
                schema: { "$ref": '#/components/schemas/ForbiddenResponseSchema' }
            });
        }
        error_responses.push({
            code: 500,
            description: "Internal Server Error",
            schema: { "$ref": '#/components/schemas/InternalErrorResponseSchema' }
        });

        return {
            [this.status_code]: {
                description: this.constructor.openapi_ResponseDescription,
                headers: this.constructor.openapi_ResponseHeaders,
                content: this.openapi_ResponseSchema === null ? undefined : {
                    [this.openapi_ResponseSchema.content_type ?? "application/json"]: {
                        schema: {
                            ...this.openapi_ResponseSchema,
                            // Clean out custom properties
                            content_type: undefined
                        }
                    }
                }
            },
            ...error_responses.reduce((acc, { code, description, content_type="application/json", schema }) => {
                if ( acc[code] ) {
                    acc[code].description += `; ${description}`;
                    if ( !acc[code].content?.[content_type] ) {
                        acc[code].content[content_type] = { schema };
                    } else {
                        if ( !acc[code].content[content_type].schema.oneOf ) {
                            acc[code].content[content_type] = { schema: { oneOf: [acc[code].content[content_type].schema] } };
                        }
                        acc[code].content[content_type].schema.oneOf.push(schema);
                    }
                } else {
                    acc[code] = {
                        description,
                        content: {
                            [content_type]: {
                                schema
                            }
                        }
                    };
                }
                return acc;
            }, {})
        };
    }

    init({ log, db, token_manager, disable_auth, invalidator }) {
        this.log = log?.create_child(this.constructor.name) ?? Logger.noop();
        this.db = db
        this.token_manager = token_manager;
        this.disable_auth = disable_auth;
        this.invalidator = invalidator;
    }

    async handle_error(response, error) {
        if ( error instanceof HTTPCodeErrorDetailed ) {
            return this.send_message(
                response,
                error.code,
                {
                    message: error.message,
                    details: error.details
                }
            );
        }

        log_error(this.log, error);
        return super.handle_error(response, error);
    }

    async preprocess_request(req, res) {
        if ( this.constructor.access && !req.access?.authed && !this.disable_auth ) throw HTTPCodeError.standard(401);
        if ( this.constructor.admin && !req.access?.roles?.admin && !this.disable_auth ) throw HTTPCodeError.standard(403);
        if ( this.constructor.editor && !req.access?.roles?.editor && !this.disable_auth ) throw HTTPCodeError.standard(403);
        if ( this.constructor.reader && !req.access?.roles?.reader && !this.disable_auth ) throw HTTPCodeError.standard(403);
    }

    async handle(req, res) {
        await this.preprocess_request(req, res);

        const request = await this.parse_request(req);
        const response = await this.respond(request, { res });

        if ( this.constructor.invalidating ) {
            const [ meta, actions ] = await this.parse_invalidations(request, response, { req, res });
            if ( actions.length ) {
                this.invalidator.broadcast(this.invalidator.generate(
                    this.constructor.name,
                    {},
                    actions
                ))
            }
        }
        return this.send( res, this.status_code, response, this.content_type );
    }

    async broadcast_invalidations(actions, meta={}) {
        this.invalidator.broadcast(
            this.constructor.name,
            meta,
            actions
        )
    }

}


class Access {
    static requests_admin(req) {
        return req?.headers?.['x-sudo-mode'] === "true";
    }

    /**
     * Build from a signature-verified ACCESS token payload. The payload
     * carries EFFECTIVE roles (admin-implies-all applied at mint time), so
     * no derivation happens here -- except sudo masking: admin is masked
     * out unless the request carries `X-Sudo-Mode: true`; `adminable` says
     * whether sudo WOULD work.
     *
     * session_id may be null (future API-key credentials mint access tokens
     * with no session behind them) -- nothing may assume it is set.
     */
    static from_payload(payload, req=null) {
        const sudo = this.requests_admin(req);
        return new this(
            payload.email,
            {
                admin: !!payload.admin && sudo,
                adminable: !!payload.admin,
                editor: !!payload.editor,
                reader: !!payload.reader
            },
            {
                user_id: payload.sub,
                session_id: payload.sid ?? null
            }
        );
    }

    /**
     * The one true token -> Access path (middlewares, socket.io handshake):
     * verify signature + expiry, require an access-type v1 payload, and
     * fall back to unauthed on ANY failure.
     */
    static from_access_token(token_manager, token, req=null) {
        if ( !token ) return this.from_unauthed();

        const payload = token_manager.verify(token);
        if ( !payload || payload.typ !== "access" || payload.v !== 1 ) {
            return this.from_unauthed();
        }

        return this.from_payload(payload, req);
    }

    static from_unauthed() {
        return new this();
    }


    constructor(identifier, roles={}, { user_id=null, session_id=null }={}) {
        this.identifier = identifier;
        this.roles = roles;
        this.user_id = user_id;
        this.session_id = session_id;
    }

    get authed() {
        return !!this.identifier;
    }
}

class CookieMiddleware extends Middleware {
    static path = [ "/api", "/static" ];

    init({ token_manager, ...args }={}) {
        super.init(args);
        this.token_manager = token_manager;
    }

    async meddle(req) {
        if ( req?.access?.authed ) return;
        req.access = Access.from_access_token(this.token_manager, req.cookies.access_token, req);
    }
}

class JWTMiddleware extends Middleware {
    static path = [ "/api", "/static" ];

    init({ token_manager, ...args }={}) {
        super.init(args);
        this.token_manager = token_manager;
    }

    async meddle(req) {
        if ( req?.access?.authed ) return;
        const token = req.headers?.['authorization']?.match(/Bearer\s+(.*)/)?.[1];
        req.access = Access.from_access_token(this.token_manager, token, req);
    }
}

class FlyTrap extends Handler {
    static path = "/api";

    async handle() { throw HTTPCodeError.standard(404); }
}


module.exports = {
    Collection,
    Controller,
    Handler,
    Middleware,
    HTTPCodeError,
    HTTPCodeErrorDetailed,
    CookieMiddleware,
    JWTMiddleware,
    FlyTrap,
    Access,
    log_error,
    parse_body_fields,
    assert_found,
    translate_model_error,
    parse_list_params,
    openapi_list_parameters,
    data_invalidations_response
};

