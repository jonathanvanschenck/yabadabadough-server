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
    string_to_boolean,
    only_non_empty_string,
    only_boolean,
    only_positive_number,
} = require("./lib/parsers.js");
const { QK, invalidate, remove } = require("./lib/query_keys.js");

const User = require("../models/User.js");
const Session = require("../models/Session.js");
const ApiKey = require("../models/ApiKey.js");

// Outstanding access tokens are stateless: role edits, password changes,
// session revocations, and even user deletion leave already-minted access
// tokens working until their <=1h expiry (the documented staleness window)
const STALENESS_NOTE = "Outstanding access tokens keep working until their <=1h expiry (they are stateless).";

const RoleFlagProperties = {
    admin: { type: 'boolean' },
    reader: { type: 'boolean', description: "Granted by default" },
    editor: { type: 'boolean' },
};

class Controller extends _Controller {

    static UserIDParam = {
        name: 'user_id',
        in: 'path',
        description: 'The ID of the user',
        required: true,
        schema: { type: 'integer' }
    }

    static ApiKeyIDParam = {
        name: 'api_key_id',
        in: 'path',
        description: 'The ID of the API key',
        required: true,
        schema: { type: 'integer' }
    }

    static ActiveApiKeyParam = {
        name: 'active',
        in: 'query',
        description: 'Filter to unexpired (true, never-expiring keys count) or expired (false) keys',
        required: false,
        schema: { type: 'boolean' }
    }

    // Foreign/unknown keys 404 (not 403): never leak that the id exists.
    // owner_id null skips the ownership check (admin paths pass the path
    // user's id instead).
    get_api_key(req, owner_id=null) {
        const api_key_id = to_int(req.params.api_key_id);
        if ( !api_key_id ) throw new HTTPCodeError(404, "Not found");

        const api_key = assert_found(ApiKey.for_id(this.db, api_key_id), `api key ${api_key_id}`);
        if ( owner_id !== null && api_key.user_id !== owner_id ) {
            throw new HTTPCodeError(404, `Not found: api key ${api_key_id}`);
        }

        return api_key;
    }

    get_user(req) {
        const user_id = to_int(req.params.user_id);
        if ( !user_id ) throw new HTTPCodeError(404, "Not found");
        return assert_found(User.for_id(this.db, user_id), `user ${user_id}`);
    }

    // Only unreachable outside disable_auth mode (access controllers always
    // carry a user_id)
    get_self(req) {
        if ( req.access?.user_id == null ) throw new HTTPCodeError(400, "No authenticated user");
        return assert_found(User.for_id(this.db, req.access.user_id), "authenticated user");
    }
}

module.exports = class UsersCollection extends Collection {
    static prefix = "/api/users";

    static openapi_Tags = ["Users"];

    static controllers = [

        // ------------------------------------------------------------------
        // Self-service: any authenticated user, no role needed
        // ------------------------------------------------------------------

        class GetMe extends Controller {
            static path = "/me";

            static method = "GET";

            static reader = false;

            static openapi_Summary = "Get Current User";

            static openapi_Description = "Get the authenticated user, FRESH from the database (the access token's roles may be up to ~1h stale).";

            static query_key = ["me"];

            async parse_request(req) {
                return this.get_self(req);
            }

            async respond(user) {
                return user.to_api();
            }

            static openapi_ResponseSchema = {
                "$ref": '#/components/schemas/UserSchema'
            }
        },

        class PostMePassword extends Controller {
            static path = "/me/password";

            static method = "POST";

            static reader = false;

            static openapi_Summary = "Change My Password";

            static openapi_Description = `Change the authenticated user's password, verifying the current one first (uniform, penalized 400 on failure). By default every session is revoked -- including this one, so the client must log in again. ${STALENESS_NOTE}`;

            static openapi_RequestBodySchema = {
                type: 'object',
                properties: {
                    current_password: { type: 'string', format: 'password' },
                    password: { type: 'string', format: 'password', description: "The new password (min 8 chars)" },
                    revoke_sessions: { type: 'boolean', description: "Revoke EVERY session, including this one (default true)" }
                },
                required: [ 'current_password', 'password' ]
            }

            async parse_request(req) {
                const data = parse_body_fields(req.body, [
                    [ "current_password", only_non_empty_string, "non-empty string", { required: true } ],
                    [ "password", only_non_empty_string, "non-empty string", { required: true } ],
                    [ "revoke_sessions", only_boolean, "boolean" ],
                ]);

                return { user: this.get_self(req), ...data };
            }

            async respond({ user, current_password, password, revoke_sessions=true }) {
                // Uniform failure: never confirms the current password was
                // the problem vs anything else about the account
                if ( !await user.verify_password(current_password) ) {
                    await this.penalize();
                    throw new HTTPCodeError(400, "Bad password");
                }

                try {
                    await user.set_password(this.db, password);
                } catch (err) {
                    translate_model_error(err);
                }

                // Password changed: kill every session (API-layer policy --
                // the model deliberately leaves this to us)
                if ( revoke_sessions ) Session.revoke_all(this.db, user.id);

                const invalidation_actions = [
                    invalidate(QK.me_sessions),
                    invalidate(QK.user_sessions(user.id)),
                ];

                this.broadcast_invalidations(invalidation_actions, { user_id: user.id });

                return {
                    data: user.to_api(),
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({ "$ref": '#/components/schemas/UserSchema' });

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter or bad password (uniform)", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } }
            ]
        },

        class GetMeSessions extends Controller {
            static path = "/me/sessions";

            static method = "GET";

            static reader = false;

            static openapi_Summary = "List My Sessions";

            static openapi_Description = "List the authenticated user's login sessions (all of them by default; filter with active). The per-session secret is never exposed.";

            static query_key = [ "me", "sessions" ];

            static openapi_Parameters = [
                {
                    name: 'active',
                    in: 'query',
                    description: 'Filter to unexpired (true) or expired (false) sessions',
                    required: false,
                    schema: { type: 'boolean' }
                },
                ...openapi_list_parameters([ 'id', 'expires_at', 'created_at' ])
            ]

            async parse_request(req) {
                const filter = parse_list_params(req.query, [ "id", "expires_at", "created_at" ]);
                filter.active = string_to_boolean(req.query?.active);
                filter.user_id = this.get_self(req).id;
                return filter;
            }

            async respond(filter, { res }) {
                res.setHeader("X-Total-Count", Session.count(this.db, filter));
                return Session.from_db(this.db, filter).map((s) => s.to_api());
            }

            static openapi_ResponseHeaders = {
                "X-Total-Count": {
                    description: "The total number of sessions matching the filter (ignoring limit and offset)",
                    schema: { type: "integer" }
                }
            }

            static openapi_ResponseSchema = {
                type: 'array',
                items: {
                    "$ref": '#/components/schemas/SessionSchema'
                }
            }
        },

        class DeleteMeSession extends Controller {
            static path = "/me/session/:session_id";

            static method = "DELETE";

            static reader = false;

            static openapi_Summary = "Delete My Session";

            static openapi_Description = `Delete one of the authenticated user's own sessions (log that device out): its auth token loses the right to refresh. Another user's session reads as 404 (existence is never leaked). ${STALENESS_NOTE}`;

            static openapi_Parameters = [
                {
                    name: 'session_id',
                    in: 'path',
                    description: 'The ID of the session',
                    required: true,
                    schema: { type: 'integer' }
                }
            ]

            async parse_request(req) {
                const self = this.get_self(req);

                const session_id = to_int(req.params.session_id);
                if ( !session_id ) throw new HTTPCodeError(404, "Not found");

                const session = assert_found(Session.for_id(this.db, session_id), `session ${session_id}`);
                // Foreign sessions 404 (not 403): never leak that the id exists
                if ( session.user_id !== self.id ) throw new HTTPCodeError(404, `Not found: session ${session_id}`);

                return session;
            }

            async respond(session) {
                session.delete(this.db);

                const invalidation_actions = [
                    invalidate(QK.me_sessions),
                    invalidate(QK.user_sessions(session.user_id)),
                ];

                this.broadcast_invalidations(invalidation_actions, { session_id: session.id });

                return {
                    data: null,
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({ "$ref": '#/components/schemas/NullSchema' });

            static openapi_ErrorResponses = [
                { code: 404, description: "Not found (including another user's session)", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } }
            ]
        },

        class GetMeApiKeys extends Controller {
            static path = "/me/api-keys";

            static method = "GET";

            static reader = false;

            static openapi_Summary = "List My API Keys";

            static openapi_Description = "List the authenticated user's API keys (all of them by default; filter with active -- expired keys stay listed). The secret is never re-shown. NOTE the query key is id-scoped, not [\"me\", ...]: invalidations broadcast to every client, so the webapp keys this view by its own user id.";

            static query_key = [ "user", "user_id", "api-keys" ];

            static openapi_Parameters = [
                this.ActiveApiKeyParam,
                ...openapi_list_parameters([ 'id', 'name', 'expires_at', 'created_at' ])
            ]

            async parse_request(req) {
                const filter = parse_list_params(req.query, [ "id", "name", "expires_at", "created_at" ]);
                filter.active = string_to_boolean(req.query?.active);
                filter.user_id = this.get_self(req).id;
                return filter;
            }

            async respond(filter, { res }) {
                res.setHeader("X-Total-Count", ApiKey.count(this.db, filter));
                return ApiKey.from_db(this.db, filter).map((k) => k.to_api());
            }

            static openapi_ResponseHeaders = {
                "X-Total-Count": {
                    description: "The total number of API keys matching the filter (ignoring limit and offset)",
                    schema: { type: "integer" }
                }
            }

            static openapi_ResponseSchema = {
                type: 'array',
                items: {
                    "$ref": '#/components/schemas/ApiKeySchema'
                }
            }
        },

        class PostMeApiKeys extends Controller {
            static path = "/me/api-keys";

            static method = "POST";

            static reader = false;

            static openapi_Summary = "Create API Key";

            static openapi_Description = "Mint a new API key for the authenticated user. The response's api_key field is the ONLY time the plaintext secret is ever shown -- store it now. The key's reader/editor flags scope what its exchanged tokens may do (intersected with the owner's roles at exchange time; admin is never minted). Exchange it at POST /api/auth/api-token.";

            static openapi_RequestBodySchema = {
                type: 'object',
                properties: {
                    name: { type: 'string', description: "Human label ('metrics dashboard', 'statement importer', ...)" },
                    reader: { type: 'boolean', description: "Key-level reader scope (default true)" },
                    editor: { type: 'boolean', description: "Key-level editor scope (default false)" },
                    ttl_days: { type: 'number', exclusiveMinimum: 0, description: "Days until the key expires; omit for a key that never expires" }
                },
                required: [ 'name' ]
            }

            async parse_request(req) {
                const data = parse_body_fields(req.body, [
                    [ "name", only_non_empty_string, "non-empty string", { required: true } ],
                    [ "reader", only_boolean, "boolean" ],
                    [ "editor", only_boolean, "boolean" ],
                    [ "ttl_days", only_positive_number, "positive number" ],
                ]);

                return { user: this.get_self(req), ...data };
            }

            async respond({ user, ...data }) {
                let api_key, secret;
                try {
                    ({ api_key, secret } = ApiKey.create(this.db, { ...data, user_id: user.id }));
                } catch (err) {
                    translate_model_error(err);
                }

                const invalidation_actions = [
                    invalidate(QK.user_api_keys(user.id)),
                ];

                this.broadcast_invalidations(invalidation_actions, { user_id: user.id });

                return {
                    data: { ...api_key.to_api(), api_key: secret },
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({
                allOf: [
                    { "$ref": '#/components/schemas/ApiKeySchema' },
                    {
                        type: 'object',
                        properties: {
                            api_key: { type: 'string', format: 'password', description: "The plaintext secret ('ydd_...'): shown here ONCE and never again" }
                        },
                        required: [ 'api_key' ]
                    }
                ]
            });

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } }
            ]
        },

        class DeleteMeApiKey extends Controller {
            static path = "/me/api-key/:api_key_id";

            static method = "DELETE";

            static reader = false;

            static openapi_Summary = "Revoke My API Key";

            static openapi_Description = `Revoke one of the authenticated user's own API keys: its secret loses the right to exchange for access tokens. Another user's key reads as 404 (existence is never leaked). ${STALENESS_NOTE}`;

            static openapi_Parameters = [
                this.ApiKeyIDParam
            ]

            async parse_request(req) {
                return this.get_api_key(req, this.get_self(req).id);
            }

            async respond(api_key) {
                api_key.delete(this.db);

                const invalidation_actions = [
                    invalidate(QK.user_api_keys(api_key.user_id)),
                ];

                this.broadcast_invalidations(invalidation_actions, { api_key_id: api_key.id });

                return {
                    data: null,
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({ "$ref": '#/components/schemas/NullSchema' });

            static openapi_ErrorResponses = [
                { code: 404, description: "Not found (including another user's API key)", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } }
            ]
        },

        // ------------------------------------------------------------------
        // User management: admin only (X-Sudo-Mode required)
        // ------------------------------------------------------------------

        class GetUsers extends Controller {
            static path = "/users";

            static method = "GET";

            static admin = true;

            static reader = false;

            static openapi_Summary = "List Users";

            static openapi_Description = "Get a list of users. The reader/editor filters match EFFECTIVE roles (admins count); the admin filter is exact.";

            static query_key = ["users"];

            static openapi_Parameters = [
                {
                    name: 'admin',
                    in: 'query',
                    description: 'Filter by the admin flag (exact)',
                    required: false,
                    schema: { type: 'boolean' }
                },
                {
                    name: 'reader',
                    in: 'query',
                    description: 'Filter by effective reader role (admins count)',
                    required: false,
                    schema: { type: 'boolean' }
                },
                {
                    name: 'editor',
                    in: 'query',
                    description: 'Filter by effective editor role (admins count)',
                    required: false,
                    schema: { type: 'boolean' }
                },
                ...openapi_list_parameters([ 'id', 'email', 'created_at' ])
            ]

            async parse_request(req) {
                const filter = parse_list_params(req.query, [ "id", "email", "created_at" ]);

                filter.admin = string_to_boolean(req.query?.admin);
                filter.reader = string_to_boolean(req.query?.reader);
                filter.editor = string_to_boolean(req.query?.editor);

                return filter;
            }

            async respond(filter, { res }) {
                res.setHeader("X-Total-Count", User.count(this.db, filter));
                return User.from_db(this.db, filter).map((u) => u.to_api());
            }

            static openapi_ResponseHeaders = {
                "X-Total-Count": {
                    description: "The total number of users matching the filter (ignoring limit and offset)",
                    schema: { type: "integer" }
                }
            }

            static openapi_ResponseSchema = {
                type: 'array',
                items: {
                    "$ref": '#/components/schemas/UserSchema'
                }
            }
        },

        class GetUser extends Controller {
            static path = "/user/:user_id";

            static method = "GET";

            static admin = true;

            static reader = false;

            static openapi_Summary = "Get User";

            static openapi_Description = "Get a single user by ID.";

            static query_key = [ "user", "user_id" ];

            static openapi_Parameters = [
                this.UserIDParam
            ]

            async parse_request(req) {
                return this.get_user(req);
            }

            async respond(user) {
                return user.to_api();
            }

            static openapi_ResponseSchema = {
                "$ref": '#/components/schemas/UserSchema'
            }

            static openapi_ErrorResponses = [
                { code: 404, description: "Not found", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } }
            ]
        },

        class GetUserSessions extends Controller {
            static path = "/user/:user_id/sessions";

            static method = "GET";

            static admin = true;

            static reader = false;

            static openapi_Summary = "List User Sessions";

            static openapi_Description = "List a user's login sessions (all of them by default; filter with active).";

            static query_key = [ "user", "user_id", "sessions" ];

            static openapi_Parameters = [
                this.UserIDParam,
                {
                    name: 'active',
                    in: 'query',
                    description: 'Filter to unexpired (true) or expired (false) sessions',
                    required: false,
                    schema: { type: 'boolean' }
                },
                ...openapi_list_parameters([ 'id', 'expires_at', 'created_at' ])
            ]

            async parse_request(req) {
                const filter = parse_list_params(req.query, [ "id", "expires_at", "created_at" ]);
                filter.active = string_to_boolean(req.query?.active);
                filter.user_id = this.get_user(req).id;
                return filter;
            }

            async respond(filter, { res }) {
                res.setHeader("X-Total-Count", Session.count(this.db, filter));
                return Session.from_db(this.db, filter).map((s) => s.to_api());
            }

            static openapi_ResponseHeaders = {
                "X-Total-Count": {
                    description: "The total number of sessions matching the filter (ignoring limit and offset)",
                    schema: { type: "integer" }
                }
            }

            static openapi_ResponseSchema = {
                type: 'array',
                items: {
                    "$ref": '#/components/schemas/SessionSchema'
                }
            }

            static openapi_ErrorResponses = [
                { code: 404, description: "Not found", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } }
            ]
        },

        class GetUserApiKeys extends Controller {
            static path = "/user/:user_id/api-keys";

            static method = "GET";

            static admin = true;

            static reader = false;

            static openapi_Summary = "List User API Keys";

            static openapi_Description = "List a user's API keys (all of them by default; filter with active). The secret is never shown.";

            static query_key = [ "user", "user_id", "api-keys" ];

            static openapi_Parameters = [
                this.UserIDParam,
                this.ActiveApiKeyParam,
                ...openapi_list_parameters([ 'id', 'name', 'expires_at', 'created_at' ])
            ]

            async parse_request(req) {
                const filter = parse_list_params(req.query, [ "id", "name", "expires_at", "created_at" ]);
                filter.active = string_to_boolean(req.query?.active);
                filter.user_id = this.get_user(req).id;
                return filter;
            }

            async respond(filter, { res }) {
                res.setHeader("X-Total-Count", ApiKey.count(this.db, filter));
                return ApiKey.from_db(this.db, filter).map((k) => k.to_api());
            }

            static openapi_ResponseHeaders = {
                "X-Total-Count": {
                    description: "The total number of API keys matching the filter (ignoring limit and offset)",
                    schema: { type: "integer" }
                }
            }

            static openapi_ResponseSchema = {
                type: 'array',
                items: {
                    "$ref": '#/components/schemas/ApiKeySchema'
                }
            }

            static openapi_ErrorResponses = [
                { code: 404, description: "Not found", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } }
            ]
        },

        class DeleteUserApiKey extends Controller {
            static path = "/user/:user_id/api-key/:api_key_id";

            static method = "DELETE";

            static admin = true;

            static reader = false;

            static openapi_Summary = "Revoke User API Key";

            static openapi_Description = `Administratively revoke one of a user's API keys. Unlike sessions, keys survive password resets, so this is the admin kill path for a compromised or orphaned credential. ${STALENESS_NOTE}`;

            static openapi_Parameters = [
                this.UserIDParam,
                this.ApiKeyIDParam
            ]

            async parse_request(req) {
                // A key under the wrong user 404s: the path names the
                // resource, it doesn't search for it
                return this.get_api_key(req, this.get_user(req).id);
            }

            async respond(api_key) {
                api_key.delete(this.db);

                const invalidation_actions = [
                    invalidate(QK.user_api_keys(api_key.user_id)),
                ];

                this.broadcast_invalidations(invalidation_actions, { api_key_id: api_key.id });

                return {
                    data: null,
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({ "$ref": '#/components/schemas/NullSchema' });

            static openapi_ErrorResponses = [
                { code: 404, description: "Not found (unknown user, unknown key, or a key not owned by that user)", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } }
            ]
        },

        class PostUsers extends Controller {
            static path = "/users";

            static method = "POST";

            static admin = true;

            static reader = false;

            static openapi_Summary = "Create User";

            static openapi_Description = "Create a new user. Email is normalized (lowercase, trimmed) and must be unique (409); passwords are min 8 chars. The flags are what is explicitly granted -- admin implies the other roles effectively without setting them.";

            static openapi_RequestBodySchema = {
                type: 'object',
                properties: {
                    email: { type: 'string', format: 'email' },
                    password: { type: 'string', format: 'password', description: "Min 8 chars" },
                    ...RoleFlagProperties
                },
                required: [ 'email', 'password' ]
            }

            async parse_request(req) {
                return parse_body_fields(req.body, [
                    [ "email", only_non_empty_string, "non-empty string", { required: true } ],
                    [ "password", only_non_empty_string, "non-empty string", { required: true } ],
                    [ "admin", only_boolean, "boolean" ],
                    [ "reader", only_boolean, "boolean" ],
                    [ "editor", only_boolean, "boolean" ],
                ]);
            }

            async respond(data) {
                let user;
                try {
                    user = await User.create(this.db, data);
                } catch (err) {
                    translate_model_error(err);
                }

                const invalidation_actions = [
                    invalidate(QK.users),
                ];

                this.broadcast_invalidations(invalidation_actions, { user_id: user.id });

                return {
                    data: user.to_api(),
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({ "$ref": '#/components/schemas/UserSchema' });

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter (including bad email / short password)", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } },
                { code: 409, description: "Conflict (email already exists)", schema: { "$ref": '#/components/schemas/ConflictResponseSchema' } }
            ]
        },

        class PatchUser extends Controller {
            static path = "/user/:user_id";

            static method = "PATCH";

            static admin = true;

            static reader = false;

            static openapi_Summary = "Update User";

            static openapi_Description = `Update a user's email and/or explicitly-granted role flags. Passwords change via the password endpoints, never here. ${STALENESS_NOTE} There is deliberately no last-admin guard (recovery goes through scripts/create-user.js).`;

            static openapi_Parameters = [
                this.UserIDParam
            ]

            static openapi_RequestBodySchema = {
                type: 'object',
                properties: {
                    email: { type: 'string', format: 'email' },
                    ...RoleFlagProperties
                }
            }

            async parse_request(req) {
                const patch = parse_body_fields(req.body, [
                    [ "email", only_non_empty_string, "non-empty string" ],
                    [ "admin", only_boolean, "boolean" ],
                    [ "reader", only_boolean, "boolean" ],
                    [ "editor", only_boolean, "boolean" ],
                ]);

                return { user: this.get_user(req), patch, self_id: req.access?.user_id };
            }

            async respond({ user, patch, self_id }) {
                let new_user;
                try {
                    new_user = user.update(this.db, patch);
                } catch (err) {
                    translate_model_error(err);
                }

                const invalidation_actions = [
                    invalidate(QK.users),
                    invalidate(QK.user(user.id)),
                ];
                if ( user.id === self_id ) invalidation_actions.push(invalidate(QK.me));

                this.broadcast_invalidations(invalidation_actions, { user_id: user.id });

                return {
                    data: new_user.to_api(),
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({ "$ref": '#/components/schemas/UserSchema' });

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } },
                { code: 404, description: "Not found", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } },
                { code: 409, description: "Conflict (email already exists)", schema: { "$ref": '#/components/schemas/ConflictResponseSchema' } }
            ]
        },

        class PostUserPassword extends Controller {
            static path = "/user/:user_id/password";

            static method = "POST";

            static admin = true;

            static reader = false;

            static openapi_Summary = "Set User Password";

            static openapi_Description = `Administratively reset a user's password (no current password needed). By default every one of THEIR sessions is revoked. ${STALENESS_NOTE}`;

            static openapi_Parameters = [
                this.UserIDParam
            ]

            static openapi_RequestBodySchema = {
                type: 'object',
                properties: {
                    password: { type: 'string', format: 'password', description: "The new password (min 8 chars)" },
                    revoke_sessions: { type: 'boolean', description: "Revoke every one of the user's sessions (default true)" }
                },
                required: [ 'password' ]
            }

            async parse_request(req) {
                const data = parse_body_fields(req.body, [
                    [ "password", only_non_empty_string, "non-empty string", { required: true } ],
                    [ "revoke_sessions", only_boolean, "boolean" ],
                ]);

                return { user: this.get_user(req), ...data };
            }

            async respond({ user, password, revoke_sessions=true }) {
                try {
                    await user.set_password(this.db, password);
                } catch (err) {
                    translate_model_error(err);
                }

                if ( revoke_sessions ) Session.revoke_all(this.db, user.id);

                const invalidation_actions = [
                    invalidate(QK.user_sessions(user.id)),
                ];

                this.broadcast_invalidations(invalidation_actions, { user_id: user.id });

                return {
                    data: user.to_api(),
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({ "$ref": '#/components/schemas/UserSchema' });

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter (including short password)", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } },
                { code: 404, description: "Not found", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } }
            ]
        },

        class DeleteUser extends Controller {
            static path = "/user/:user_id";

            static method = "DELETE";

            static admin = true;

            static reader = false;

            static openapi_Summary = "Delete User";

            static openapi_Description = `Delete a user; their sessions and API keys cascade away. Self-deletion is refused (use another admin account). ${STALENESS_NOTE}`;

            static openapi_Parameters = [
                this.UserIDParam
            ]

            async parse_request(req) {
                const user = this.get_user(req);
                // A small footgun guard; there is deliberately no last-admin
                // guard beyond it
                if ( user.id === req.access?.user_id ) {
                    throw new HTTPCodeError(400, "Cannot delete the authenticated user (use another admin account)");
                }
                return user;
            }

            async respond(user) {
                try {
                    user.delete(this.db);
                } catch (err) {
                    translate_model_error(err);
                }

                const invalidation_actions = [
                    invalidate(QK.users),
                    remove(QK.user(user.id)),
                    remove(QK.user_sessions(user.id)),
                    remove(QK.user_api_keys(user.id)),
                ];

                this.broadcast_invalidations(invalidation_actions, { user_id: user.id });

                return {
                    data: null,
                    invalidations: invalidation_actions
                };
            }

            static openapi_ResponseSchema = data_invalidations_response({ "$ref": '#/components/schemas/NullSchema' });

            static openapi_ErrorResponses = [
                { code: 400, description: "Bad parameter (self-deletion)", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } },
                { code: 404, description: "Not found", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } }
            ]
        }

    ]
}
