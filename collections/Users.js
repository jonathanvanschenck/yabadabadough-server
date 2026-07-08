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

    // The self-or-admin routes take sudo OPTIONALLY (it is only needed for
    // foreign targets), so they declare this instead of the required header
    // the static admin flag would inject
    static OptionalSudoParam = {
        name: "X-Sudo-Mode",
        in: "header",
        required: false,
        schema: { type: "string", enum: ["true"] },
        description: "Required (along with the admin role) when acting on another user; unnecessary when acting on yourself."
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

    // Self-or-admin: any authenticated user may act on THEIR OWN user id;
    // anyone else's takes the admin role + X-Sudo-Mode (like every admin
    // call, but checked here because self access must not require it). A
    // foreign target reads as 404 for non-admins -- indistinguishable from a
    // nonexistent id, existence is never leaked -- while an admin who merely
    // forgot sudo gets the standard 403 hint.
    get_target_user(req) {
        if ( !this.disable_auth ) {
            const user_id = to_int(req.params.user_id);
            if ( req.access?.user_id !== user_id && !req.access?.roles?.admin ) {
                if ( req.access?.roles?.adminable ) throw HTTPCodeError.standard(403);
                throw new HTTPCodeError(404, `Not found: user ${user_id}`);
            }
        }
        return this.get_user(req);
    }

    // Whether the request carries live (sudo-mode) admin rights -- the
    // discriminator for endpoints whose semantics differ between self-service
    // and administration. disable_auth counts as admin
    is_sudo_admin(req) {
        return this.disable_auth || !!req.access?.roles?.admin;
    }
}

module.exports = class UsersCollection extends Collection {
    static prefix = "/api/users";

    static openapi_Tags = ["Users"];

    static controllers = [

        // ------------------------------------------------------------------
        // Self-or-admin: any authed user on THEIR OWN user id; admin
        // (X-Sudo-Mode) on anyone's. There are deliberately NO /me routes:
        // viewer-relative endpoints would want viewer-relative ["me", ...]
        // query keys, which break under broadcast invalidations (every
        // client would invalidate on every user's self-writes). Clients
        // learn their own user id from the login/authenticate response.
        // ------------------------------------------------------------------

        class GetUser extends Controller {
            static path = "/user/:user_id";

            static method = "GET";

            static reader = false;

            static openapi_Summary = "Get User";

            static openapi_Description = "Get a single user by ID, FRESH from the database (the access token's roles may be up to ~1h stale). Self-or-admin: your own user needs no role (this is the \"who am I, really\" endpoint); anyone else's requires admin + X-Sudo-Mode and reads as 404 without it.";

            static query_key = [ "user", "user_id" ];

            static openapi_Parameters = [
                this.UserIDParam,
                this.OptionalSudoParam
            ]

            async parse_request(req) {
                return this.get_target_user(req);
            }

            async respond(user) {
                return user.to_api();
            }

            static openapi_ResponseSchema = {
                "$ref": '#/components/schemas/UserSchema'
            }

            static openapi_ErrorResponses = [
                { code: 403, description: "Forbidden (an admin targeting another user without X-Sudo-Mode)", schema: { "$ref": '#/components/schemas/ForbiddenResponseSchema' } },
                { code: 404, description: "Not found (including another user, for non-admins)", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } }
            ]
        },

        class GetUserSessions extends Controller {
            static path = "/user/:user_id/sessions";

            static method = "GET";

            static reader = false;

            static openapi_Summary = "List User Sessions";

            static openapi_Description = "List a user's login sessions (all of them by default; filter with active). The per-session secret is never exposed. Self-or-admin: your own sessions need no role; anyone else's require admin + X-Sudo-Mode.";

            static query_key = [ "user", "user_id", "sessions" ];

            static openapi_Parameters = [
                this.UserIDParam,
                this.OptionalSudoParam,
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
                filter.user_id = this.get_target_user(req).id;
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
                { code: 403, description: "Forbidden (an admin targeting another user without X-Sudo-Mode)", schema: { "$ref": '#/components/schemas/ForbiddenResponseSchema' } },
                { code: 404, description: "Not found (including another user, for non-admins)", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } }
            ]
        },

        class DeleteUserSession extends Controller {
            static path = "/user/:user_id/session/:session_id";

            static method = "DELETE";

            static reader = false;

            static openapi_Summary = "Delete User Session";

            static openapi_Description = `Delete one of a user's sessions: its auth token loses the right to refresh. Self-or-admin: deleting your own sessions (logging your own devices out) needs no role; another user's require admin + X-Sudo-Mode. A session under the wrong user reads as 404 (the path names the resource, it doesn't search for it). ${STALENESS_NOTE}`;

            static openapi_Parameters = [
                this.UserIDParam,
                this.OptionalSudoParam,
                {
                    name: 'session_id',
                    in: 'path',
                    description: 'The ID of the session',
                    required: true,
                    schema: { type: 'integer' }
                }
            ]

            async parse_request(req) {
                const user = this.get_target_user(req);

                const session_id = to_int(req.params.session_id);
                if ( !session_id ) throw new HTTPCodeError(404, "Not found");

                const session = assert_found(Session.for_id(this.db, session_id), `session ${session_id}`);
                // A session under the wrong user 404s: never leak that the
                // id exists
                if ( session.user_id !== user.id ) throw new HTTPCodeError(404, `Not found: session ${session_id}`);

                return session;
            }

            async respond(session) {
                session.delete(this.db);

                const invalidation_actions = [
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
                { code: 403, description: "Forbidden (an admin targeting another user without X-Sudo-Mode)", schema: { "$ref": '#/components/schemas/ForbiddenResponseSchema' } },
                { code: 404, description: "Not found (unknown user, unknown session, a session not owned by that user, or another user entirely for non-admins)", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } }
            ]
        },

        class GetUserApiKeys extends Controller {
            static path = "/user/:user_id/api-keys";

            static method = "GET";

            static reader = false;

            static openapi_Summary = "List User API Keys";

            static openapi_Description = "List a user's API keys (all of them by default; filter with active -- expired keys stay listed). The secret is never re-shown. Self-or-admin: your own keys need no role; anyone else's require admin + X-Sudo-Mode.";

            static query_key = [ "user", "user_id", "api-keys" ];

            static openapi_Parameters = [
                this.UserIDParam,
                this.OptionalSudoParam,
                this.ActiveApiKeyParam,
                ...openapi_list_parameters([ 'id', 'name', 'expires_at', 'created_at' ])
            ]

            async parse_request(req) {
                const filter = parse_list_params(req.query, [ "id", "name", "expires_at", "created_at" ]);
                filter.active = string_to_boolean(req.query?.active);
                filter.user_id = this.get_target_user(req).id;
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
                { code: 403, description: "Forbidden (an admin targeting another user without X-Sudo-Mode)", schema: { "$ref": '#/components/schemas/ForbiddenResponseSchema' } },
                { code: 404, description: "Not found (including another user, for non-admins)", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } }
            ]
        },

        class PostUserApiKeys extends Controller {
            static path = "/user/:user_id/api-keys";

            static method = "POST";

            static reader = false;

            static openapi_Summary = "Create API Key";

            static openapi_Description = "Mint a new API key for a user. The response's api_key field is the ONLY time the plaintext secret is ever shown -- store it now. The key's reader/editor flags scope what its exchanged tokens may do (intersected with the OWNER's roles at exchange time; admin is never minted). Exchange it at POST /api/auth/api-token. Self-or-admin: minting your own keys needs no role; minting for another user requires admin + X-Sudo-Mode (and hands YOU their secret -- an onboarding convenience, not a routine path).";

            static openapi_Parameters = [
                this.UserIDParam,
                this.OptionalSudoParam
            ]

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

                return { user: this.get_target_user(req), ...data };
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
                { code: 400, description: "Bad parameter", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } },
                { code: 403, description: "Forbidden (an admin targeting another user without X-Sudo-Mode)", schema: { "$ref": '#/components/schemas/ForbiddenResponseSchema' } },
                { code: 404, description: "Not found (including another user, for non-admins)", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } }
            ]
        },

        class DeleteUserApiKey extends Controller {
            static path = "/user/:user_id/api-key/:api_key_id";

            static method = "DELETE";

            static reader = false;

            static openapi_Summary = "Revoke User API Key";

            static openapi_Description = `Revoke one of a user's API keys: its secret loses the right to exchange for access tokens. Self-or-admin: revoking your own keys needs no role; another user's require admin + X-Sudo-Mode -- and the admin path matters, because keys survive password resets (this is the kill switch for a compromised or orphaned credential). A key under the wrong user reads as 404. ${STALENESS_NOTE}`;

            static openapi_Parameters = [
                this.UserIDParam,
                this.OptionalSudoParam,
                this.ApiKeyIDParam
            ]

            async parse_request(req) {
                // A key under the wrong user 404s: the path names the
                // resource, it doesn't search for it
                return this.get_api_key(req, this.get_target_user(req).id);
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
                { code: 403, description: "Forbidden (an admin targeting another user without X-Sudo-Mode)", schema: { "$ref": '#/components/schemas/ForbiddenResponseSchema' } },
                { code: 404, description: "Not found (unknown user, unknown key, a key not owned by that user, or another user entirely for non-admins)", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } }
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

                return { user: this.get_user(req), patch };
            }

            async respond({ user, patch }) {
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

            static reader = false;

            static openapi_Summary = "Set User Password";

            static openapi_Description = `Set a user's password. Self-or-admin, with split semantics: WITHOUT sudo-mode admin rights you may only change your own password and must supply current_password (verified with a uniform, penalized 400 on failure); WITH them (any target, including yourself) it is an administrative reset and current_password is not required. By default every one of the TARGET's sessions is revoked -- when changing your own, that includes this one, so the client must log in again. API keys deliberately survive password changes. ${STALENESS_NOTE}`;

            static openapi_Parameters = [
                this.UserIDParam,
                this.OptionalSudoParam
            ]

            static openapi_RequestBodySchema = {
                type: 'object',
                properties: {
                    current_password: { type: 'string', format: 'password', description: "The user's current password; required unless the caller has sudo-mode admin rights" },
                    password: { type: 'string', format: 'password', description: "The new password (min 8 chars)" },
                    revoke_sessions: { type: 'boolean', description: "Revoke every one of the user's sessions (default true)" }
                },
                required: [ 'password' ]
            }

            async parse_request(req) {
                const data = parse_body_fields(req.body, [
                    [ "current_password", only_non_empty_string, "non-empty string" ],
                    [ "password", only_non_empty_string, "non-empty string", { required: true } ],
                    [ "revoke_sessions", only_boolean, "boolean" ],
                ]);

                return { user: this.get_target_user(req), admin: this.is_sudo_admin(req), ...data };
            }

            async respond({ user, admin, current_password, password, revoke_sessions=true }) {
                // Self-service path: verify the current password first.
                // Uniform failure: never confirms the current password was
                // the problem vs anything else about the account
                if ( !admin ) {
                    if ( current_password === undefined ) {
                        throw new HTTPCodeError(400, "Missing parameter: current_password (expected non-empty string)");
                    }
                    if ( !await user.verify_password(current_password) ) {
                        await this.penalize();
                        throw new HTTPCodeError(400, "Bad password");
                    }
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
                { code: 400, description: "Bad parameter (including short password) or bad current password (uniform)", schema: { "$ref": '#/components/schemas/BadParameterResponseSchema' } },
                { code: 403, description: "Forbidden (an admin targeting another user without X-Sudo-Mode)", schema: { "$ref": '#/components/schemas/ForbiddenResponseSchema' } },
                { code: 404, description: "Not found (including another user, for non-admins)", schema: { "$ref": '#/components/schemas/NotFoundResponseSchema' } }
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
