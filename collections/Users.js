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
} = require("./lib/parsers.js");
const { QK, invalidate, remove } = require("./lib/query_keys.js");

const User = require("../models/User.js");
const Session = require("../models/Session.js");

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

            static openapi_Description = `Delete a user; their sessions cascade away. Self-deletion is refused (use another admin account). ${STALENESS_NOTE}`;

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
