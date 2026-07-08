const { Collection, Controller, HTTPCodeError } = require("./lib/asseverate.js");
const { only_non_empty_string } = require("./lib/parsers.js");

const { ConflictError, ForeignKeyError } = require("../lib/db.js");
const User = require("../models/User.js");
const Session = require("../models/Session.js");
const ApiKey = require("../models/ApiKey.js");

// The long-lived auth token only ever needs to reach the auth endpoints, so
// its cookie is path-scoped here (the short-lived access token rides on every
// /api and /static request)
const AUTH_COOKIE_PATH = "/api/auth";

const OkResponseSchema = {
    type: 'object',
    properties: {
        message: { type: 'string', enum: ["OK"] }
    },
    required: ['message']
};

const TokensSchema = {
    type: 'object',
    properties: {
        access: { type: 'string', format: 'jwt', description: "Short-lived (~20m) stateless access token; carries effective roles" },
        auth: {
            type: 'string', format: 'jwt', nullable: true,
            description: "Long-lived session-bound auth token; ONLY good for refreshing, and ROTATED (single-use) by every successful refresh -- always store the one returned here. Null from /authenticate when no auth token was supplied"
        }
    },
    required: [ 'access', 'auth' ]
};

const InfoResponseSchema = {
    type: 'object',
    properties: {
        user: { '$ref': '#/components/schemas/UserSchema' },
        session: {
            description: "The session behind these tokens. Null only from /authenticate when the still-valid access token's session cannot be resolved (e.g. logged out elsewhere inside the access token's lifetime)",
            oneOf: [
                { '$ref': '#/components/schemas/SessionSchema' },
                { '$ref': '#/components/schemas/NullSchema' }
            ]
        },
        tokens: TokensSchema
    },
    required: [ 'user', 'session', 'tokens' ]
};

const BadCredentialsResponse = {
    code: 400,
    description: "Bad credentials (deliberately uniform: never says WHICH check failed)",
    schema: {
        type: 'object',
        properties: { message: { type: 'string', example: "Bad email or password" } },
        required: ['message']
    }
};

function mint_tokens(token_manager, user, session) {
    return {
        access: token_manager.tokenize(
            user.to_access_token_payload(session),
            { ttl_s: User.ACCESS_TOKEN_TTL_S }
        ),
        auth: token_manager.tokenize(
            user.to_auth_token_payload(session),
            { expires_at: session.expires_at }
        ),
    };
}

function set_access_cookie(res, access, { secure_cookies }) {
    res.cookie('access_token', access, {
        httpOnly: true,
        secure: secure_cookies,
        sameSite: 'Strict',
        maxAge: User.ACCESS_TOKEN_TTL_S * 1000
    });
}

function set_auth_cookie(res, auth, session, { secure_cookies }) {
    res.cookie('auth_token', auth, {
        httpOnly: true,
        secure: secure_cookies,
        sameSite: 'Strict',
        path: AUTH_COOKIE_PATH,
        expires: session.expires_at
    });
}

function clear_auth_cookies(res) {
    res.clearCookie('access_token');
    res.clearCookie('auth_token', { path: AUTH_COOKIE_PATH });
}

/**
 * The refresh flow shared by /refresh and /authenticate: signature-verify the
 * auth token, run the session guard (row exists, secret matches, owner, not
 * expired -- touches last_used_at) WITH ROTATION -- the per-session secret is
 * regenerated, so the presented auth token is single-use -- and mint fresh
 * access AND auth tokens. The new auth token still expires with the session
 * (rotation never slides the expiry). Callers must store/set BOTH tokens.
 *
 * Every failure is penalized and reported as the SAME 400 -- never leak which
 * check failed. Failures never rotate, so a rejected refresh does not burn
 * the (possibly still valid) presented token.
 */
async function refresh_flow(controller, auth_token) {
    const fail = async () => {
        await controller.penalize();
        throw new HTTPCodeError(400, "Bad auth token");
    };

    const payload = controller.token_manager.verify(auth_token);
    if ( !payload || payload.typ !== "auth" || payload.v !== 1 ) await fail();

    let session;
    try {
        session = Session.for_auth_payload(controller.db, payload, { rotate: true });
    } catch (err) {
        if ( err instanceof ForeignKeyError || err instanceof ConflictError ) await fail();
        else throw err;
    }

    // FK cascade makes a session without its user impossible, but the check
    // is cheap and this is the auth path
    const user = User.for_id(controller.db, session.user_id);
    if ( !user ) await fail();

    return {
        user,
        session,
        tokens: mint_tokens(controller.token_manager, user, session),
    };
}

module.exports = class AuthCollection extends Collection {
    static prefix = "/api/auth";

    static openapi_Tags = ["Authentication"];

    static controllers = [

        class Mode extends Controller {
            static path = "/mode";

            static method = "GET";

            static access = false;

            static reader = false;

            static openapi_Summary = "Get the Auth Mode";

            static openapi_Description = "Report whether the server enforces authentication. When the server runs with YDD_DISABLE_AUTH (development only), every role gate is bypassed and this reports disable_auth: true -- the webapp uses it to skip the login workflow entirely. Unauthenticated by necessity: clients call it before they could have any token.";

            async respond() {
                return { disable_auth: !!this.disable_auth };
            }

            static openapi_ResponseSchema = {
                type: 'object',
                properties: {
                    disable_auth: { type: 'boolean', description: "True when the server bypasses all auth gates (YDD_DISABLE_AUTH development mode)" }
                },
                required: [ 'disable_auth' ]
            };
        },

        class CheckAuth extends Controller {
            static path = "/check";

            static method = "GET";

            static reader = false;

            static openapi_Summary = "Check Authentication";

            static openapi_Description = "Check if the user is authenticated and has a valid access token. Does not check for any specific roles.";

            async respond() {
                return { message: "OK" };
            }

            static openapi_ResponseSchema = OkResponseSchema;
        },

        class CheckAdmin extends Controller {
            static path = "/check-admin";

            static method = "GET";

            static admin = true;

            static reader = false;

            static openapi_Summary = "Check Admin Authentication";

            static openapi_Description = "Check if the user is authenticated and has admin privileges. Like every admin endpoint, requires the X-Sudo-Mode header.";

            async respond() {
                return { message: "OK" };
            }

            static openapi_ResponseSchema = OkResponseSchema;
        },

        class CheckEditor extends Controller {
            static path = "/check-editor";

            static method = "GET";

            static editor = true;

            static reader = false;

            static openapi_Summary = "Check Editor Authentication";

            static openapi_Description = "Check if the user is authenticated and has editor privileges.";

            async respond() {
                return { message: "OK" };
            }

            static openapi_ResponseSchema = OkResponseSchema;
        },

        class CheckReader extends Controller {
            static path = "/check-reader";

            static method = "GET";

            static openapi_Summary = "Check Reader Authentication";

            static openapi_Description = "Check if the user is authenticated and has reader privileges.";

            async respond() {
                return { message: "OK" };
            }

            static openapi_ResponseSchema = OkResponseSchema;
        },

        class Login extends Controller {
            static path = "/login";

            static method = "POST";

            static access = false;

            static reader = false;

            static openapi_Summary = "Login";

            static openapi_Description = "Login with email and password to receive access and auth tokens (also set as cookies). Every login creates its own independent session, so multiple devices coexist; logout only kills the session being logged out.";

            init({ secure_cookies, ...args }={}) {
                super.init(args);
                this.secure_cookies = secure_cookies !== false;
            }

            static openapi_RequestBodySchema = {
                type: 'object',
                properties: {
                    email: { type: 'string', format: 'email' },
                    password: { type: 'string', format: 'password' }
                },
                required: [ 'email', 'password' ]
            }

            async parse_request(req) {
                const email = only_non_empty_string(req.body?.email);
                const password = only_non_empty_string(req.body?.password);

                if ( !email || !password ) {
                    await this.penalize();
                    throw new HTTPCodeError(400, "Bad email or password");
                }

                // Device/client label for "list my logins" later
                const note = only_non_empty_string(req.headers?.['user-agent'], null);

                return { email, password, note };
            }

            async respond({ email, password, note }, { res }={}) {
                // Never distinguishes unknown-email from wrong-password (the
                // model also burns a dummy hash on unknown emails)
                const user = await User.authenticate(this.db, { email, password });
                if ( !user ) {
                    await this.penalize();
                    throw new HTTPCodeError(400, "Bad email or password");
                }

                const session = Session.create(this.db, { user_id: user.id, note });
                const tokens = mint_tokens(this.token_manager, user, session);

                set_access_cookie(res, tokens.access, this);
                set_auth_cookie(res, tokens.auth, session, this);

                return {
                    user: user.to_api(),
                    session: session.to_api(),
                    tokens,
                };
            }

            static openapi_ResponseSchema = InfoResponseSchema;

            static openapi_ErrorResponses = [ BadCredentialsResponse ];
        },

        class Refresh extends Controller {
            static path = "/refresh";

            static method = "POST";

            static access = false;

            static reader = false;

            static openapi_Summary = "Refresh Tokens";

            static openapi_Description = "Mint fresh tokens from an auth token (request body, or the auth_token cookie set at login). ONLY the auth token is needed: it is checked against its session row, so logout / revoke-all make it worthless. The auth token is ROTATED on every successful refresh -- the presented one is single-use and a NEW auth token is returned (and set as a cookie); store it in place of the old one. Rotation never slides the session's expiry. A failed refresh does not rotate.";

            init({ secure_cookies, ...args }={}) {
                super.init(args);
                this.secure_cookies = secure_cookies !== false;
            }

            static openapi_RequestBodySchema = {
                type: 'object',
                description: "Provide the auth token in the body, or omit it to use the auth_token cookie.",
                optional: true,
                properties: {
                    auth: { type: 'string', format: 'jwt' }
                }
            }

            async parse_request(req) {
                const auth = only_non_empty_string(req.body?.auth ?? req.cookies.auth_token);

                if ( !auth ) {
                    await this.penalize();
                    throw new HTTPCodeError(400, "Bad auth token");
                }

                return { auth };
            }

            async respond({ auth }, { res }={}) {
                const { user, session, tokens } = await refresh_flow(this, auth);

                set_access_cookie(res, tokens.access, this);
                set_auth_cookie(res, tokens.auth, session, this);

                return {
                    user: user.to_api(),
                    session: session.to_api(),
                    tokens,
                };
            }

            static openapi_ResponseSchema = InfoResponseSchema;

            static openapi_ErrorResponses = [ BadCredentialsResponse ];
        },

        class Authenticate extends Controller {
            static path = "/authenticate";

            static method = "POST";

            static access = false;

            static reader = false;

            static openapi_Summary = "Authenticate (Check and Refresh)";

            static openapi_Description = "\"Check my auth is good, and refresh it if it isn't\": if the access token (body or cookie) still verifies, returns the current info without minting anything; otherwise, with auto_refresh, runs the refresh flow off the auth token (which ROTATES it -- see /refresh -- with both new tokens returned and set as cookies). Browsers can call this with no body at all and let the cookies do the work.";

            init({ secure_cookies, ...args }={}) {
                super.init(args);
                this.secure_cookies = secure_cookies !== false;
            }

            static openapi_RequestBodySchema = {
                type: 'object',
                description: "Tokens fall back to the access_token / auth_token cookies when omitted (set by the server on a previous login).",
                optional: true,
                properties: {
                    access: { type: 'string', format: 'jwt' },
                    auth: { type: 'string', format: 'jwt' },
                    auto_refresh: { type: 'boolean', description: "Whether to fall back to the refresh flow when the access token is expired/invalid" }
                }
            }

            async parse_request(req) {
                const access = only_non_empty_string(req.body?.access ?? req.cookies.access_token);
                const auth = only_non_empty_string(req.body?.auth ?? req.cookies.auth_token);
                const auto_refresh = !!req.body?.auto_refresh;

                if ( !access && !auth ) {
                    await this.penalize();
                    throw new HTTPCodeError(400, "Bad access or auth token");
                }

                return { access, auth, auto_refresh };
            }

            async respond({ access, auth, auto_refresh }, { res }={}) {
                // 1. A still-valid access token: report current state, mint nothing
                if ( access ) {
                    const payload = this.token_manager.verify(access);
                    if ( payload && payload.typ === "access" && payload.v === 1 ) {
                        const user = User.for_id(this.db, payload.sub);
                        if ( user ) {
                            // sid may be null (future API-key tokens), and the
                            // session may have been killed elsewhere -- the
                            // access token is still valid either way
                            const session = payload.sid != null ? Session.for_id(this.db, payload.sid) : null;
                            return {
                                user: user.to_api(),
                                session: session ? session.to_api() : null,
                                tokens: { access, auth: auth ?? null },
                            };
                        }
                    }
                }

                // 2. Stale/invalid: fall back to the refresh flow
                if ( !auto_refresh || !auth ) {
                    await this.penalize();
                    throw new HTTPCodeError(400, "Bad access or auth token");
                }

                const { user, session, tokens } = await refresh_flow(this, auth);

                set_access_cookie(res, tokens.access, this);
                set_auth_cookie(res, tokens.auth, session, this);

                return {
                    user: user.to_api(),
                    session: session.to_api(),
                    tokens,
                };
            }

            static openapi_ResponseSchema = InfoResponseSchema;

            static openapi_ErrorResponses = [ BadCredentialsResponse ];
        },

        class Logout extends Controller {
            static path = "/logout";

            static method = "POST";

            static access = false;

            static reader = false;

            static openapi_Summary = "Logout";

            static openapi_Description = "Delete this login's session (killing its auth token's right to refresh) and clear the cookies. Idempotent: always returns OK, even when the session is already gone or the token is garbage -- outstanding access tokens still live out their <=20m expiry. Other devices' sessions are untouched.";

            async parse_request(req) {
                return { auth: only_non_empty_string(req.body?.auth ?? req.cookies.auth_token) };
            }

            async respond({ auth }, { res }={}) {
                // Best-effort session kill: an unverifiable token still logs
                // the browser out (cookies cleared), it just can't delete a
                // row. The full guard (secret match, ownership) gates the
                // delete so a forged sid can't kill someone else's session.
                if ( auth ) {
                    const payload = this.token_manager.verify(auth);
                    if ( payload && payload.typ === "auth" && payload.v === 1 ) {
                        try {
                            Session.for_auth_payload(this.db, payload).delete(this.db);
                        } catch (err) {
                            if ( !(err instanceof ForeignKeyError || err instanceof ConflictError) ) throw err;
                            // Already gone / expired / mismatched: idempotent OK
                        }
                    }
                }

                clear_auth_cookies(res);
                return { message: "OK" };
            }

            static openapi_ResponseSchema = OkResponseSchema;
        },

        class RevokeAll extends Controller {
            static path = "/revoke-all";

            static method = "POST";

            static reader = false;

            static openapi_Summary = "Revoke All Logins";

            static openapi_Description = "Delete EVERY session for the authenticated user: all devices lose the ability to refresh and must log in again (their outstanding access tokens still live out their <=20m expiry). Requires a valid access token.";

            async parse_request(req) {
                return { user_id: req.access?.user_id };
            }

            async respond({ user_id }, { res }={}) {
                // Only unreachable outside disable_auth mode (access
                // controllers always carry a user_id)
                if ( user_id == null ) throw new HTTPCodeError(400, "No authenticated user");

                const revoked = Session.revoke_all(this.db, user_id);

                clear_auth_cookies(res);
                return { message: "OK", revoked };
            }

            static openapi_ResponseSchema = {
                type: 'object',
                properties: {
                    message: { type: 'string', enum: ["OK"] },
                    revoked: { type: 'integer', minimum: 0, description: "Number of sessions deleted" }
                },
                required: [ 'message', 'revoked' ]
            };
        },

        class ApiToken extends Controller {
            static path = "/api-token";

            static method = "POST";

            static access = false;

            static reader = false;

            static openapi_Summary = "Exchange an API Key for an Access Token";

            static openapi_Description = "Exchange an API key (minted at POST /api/users/user/:user_id/api-keys) for a short-lived (~20m) sessionless access token carrying the key's role scope -- never admin. No cookies are set: this is the programmatic path, and clients simply re-exchange when the token expires. Revoking the key stops future exchanges; already-minted access tokens live out their <=20m expiry.";

            static openapi_RequestBodySchema = {
                type: 'object',
                properties: {
                    api_key: { type: 'string', format: 'password', description: "The plaintext API key ('ydd_...'), shown once at creation" }
                },
                required: [ 'api_key' ]
            }

            async parse_request(req) {
                const api_key = only_non_empty_string(req.body?.api_key);

                if ( !api_key ) {
                    await this.penalize();
                    throw new HTTPCodeError(400, "Bad API key");
                }

                return { api_key };
            }

            async respond({ api_key }) {
                // Uniform 400: never says WHICH check failed (unknown vs
                // expired vs revoked key)
                const fail = async () => {
                    await this.penalize();
                    throw new HTTPCodeError(400, "Bad API key");
                };

                let key;
                try {
                    key = ApiKey.for_exchange(this.db, api_key);
                } catch (err) {
                    if ( err instanceof ForeignKeyError || err instanceof ConflictError ) await fail();
                    else throw err;
                }

                // FK cascade makes a key without its user impossible, but the
                // check is cheap and this is the auth path
                const user = User.for_id(this.db, key.user_id);
                if ( !user ) await fail();

                return {
                    user: user.to_api(),
                    tokens: {
                        access: this.token_manager.tokenize(
                            user.to_api_key_access_token_payload(key),
                            { ttl_s: User.ACCESS_TOKEN_TTL_S }
                        ),
                    },
                };
            }

            static openapi_ResponseSchema = {
                type: 'object',
                properties: {
                    user: { '$ref': '#/components/schemas/UserSchema' },
                    tokens: {
                        type: 'object',
                        properties: {
                            access: { type: 'string', format: 'jwt', description: "Short-lived (~20m) sessionless access token; roles = owner's effective roles masked by the key's scope, admin always false" }
                        },
                        required: [ 'access' ]
                    }
                },
                required: [ 'user', 'tokens' ]
            };

            static openapi_ErrorResponses = [ {
                code: 400,
                description: "Bad API key (deliberately uniform: never says WHICH check failed)",
                schema: {
                    type: 'object',
                    properties: { message: { type: 'string', example: "Bad API key" } },
                    required: ['message']
                }
            } ];
        }

    ]
}
