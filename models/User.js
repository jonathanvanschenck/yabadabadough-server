
const crypto = require("crypto");
const { promisify } = require("util");

const Base = require("./Base.js");

const {
    ConflictError,
    ForeignKeyError
} = require("../lib/db.js");

const {
    boolean2stmt,
    stmt2boolean,
    stmt2datetime,
} = require("../lib/db.js").helpers;

const SELECT_COLUMNS = [
    "id",
    "email",
    "password_hash",
    "admin",
    "reader",
    "editor",
    "created_at",
];

// Password hashing: node's built-in scrypt, stored as a self-describing
// string "scrypt$N$r$p$salt_b64$hash_b64". Verification reads the params out
// of the stored string (not these constants), so cost can be raised later
// without invalidating existing hashes.
//
// Hashing is ASYNC (libuv threadpool): scrypt burns ~50-100ms of CPU, and
// the sync variant would stall every other request on the event loop. The
// hash must therefore always happen OUTSIDE the sqlite transaction --
// better-sqlite3 transactions cannot contain an await (all db reads/writes
// stay sync).
const scrypt = promisify(crypto.scrypt);

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

async function hash_password(password) {
    const salt = crypto.randomBytes(SALT_BYTES);
    const hash = await scrypt(String(password), salt, HASH_BYTES, {
        N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P
    });
    return [
        "scrypt",
        SCRYPT_N,
        SCRYPT_R,
        SCRYPT_P,
        salt.toString("base64"),
        hash.toString("base64"),
    ].join("$");
}

async function verify_password(password, stored) {
    if ( typeof stored !== "string" ) return false;

    const parts = stored.split("$");
    if ( parts.length !== 6 || parts[0] !== "scrypt" ) return false;

    const N = parseInt(parts[1]);
    const r = parseInt(parts[2]);
    const p = parseInt(parts[3]);
    const salt = Buffer.from(parts[4], "base64");
    const expected = Buffer.from(parts[5], "base64");

    const actual = await scrypt(String(password), salt, expected.length, { N, r, p });
    return crypto.timingSafeEqual(actual, expected);
}

// Verified against when authenticating an unknown email, so "no such user"
// and "wrong password" take the same time (user-enumeration resistance)
const DUMMY_HASH_PROMISE = hash_password(crypto.randomBytes(16).toString("hex"));

/**
 * A user account: normalized email, salted scrypt password hash, and role
 * flags (admin/reader/editor -- everyone defaults to reader).
 *
 * Role flags are stored as explicitly granted; `user.roles` is the EFFECTIVE
 * set, where admin implies every other role (derived at read time, never
 * written back). Role checks go through `roles`; the stored flags are for
 * display/editing.
 *
 * The password_hash is never exposed via to_api, and only ever changes
 * through set_password (update handles email/roles only). Everything that
 * touches scrypt (create, set_password, verify_password, authenticate) is
 * async -- the hash runs on the libuv threadpool, never the event loop, and
 * always OUTSIDE the sqlite transaction.
 *
 * Token payloads (signing/verification is the API layer's job):
 *  - access (~1h, stateless):  { v, typ: "access", sub, email, admin, reader, editor, sid }
 *    (role claims are the EFFECTIVE roles, so request handling never
 *    re-derives the admin-implies-all rule)
 *  - auth (~1w, session-bound): { v, typ: "auth", sub, sid, token }
 * Access tokens are verified by signature alone, so logout / revoke-all /
 * admin changes do not kill outstanding access tokens -- they die at their
 * <=1h expiry. NOTE: nothing may assume `sid` is non-null; future API-key
 * credentials will mint access tokens with no session behind them.
 */
module.exports = class User extends Base {
    static ACCESS_TOKEN_TTL_S = 3600;

    static PREPARED_STMTS = {
        for_id: `
            SELECT ${SELECT_COLUMNS.join(", ")}
            FROM users
            WHERE id = @id
        `,
        for_email: `
            SELECT ${SELECT_COLUMNS.join(", ")}
            FROM users
            WHERE email = @email
        `,
        create: `
            INSERT INTO users (
                email,
                password_hash,
                admin,
                reader,
                editor
            ) VALUES (
                @email,
                @password_hash,
                @admin,
                @reader,
                @editor
            )
        `,
        update: `
            UPDATE users
            SET email = @email,
                admin = @admin,
                reader = @reader,
                editor = @editor
            WHERE id = @id
        `,
        set_password: `
            UPDATE users
            SET password_hash = @password_hash
            WHERE id = @id
        `,
        delete: `
            DELETE FROM users
            WHERE id = @id
        `,
    }

    static PREPARED_TRANSACTIONS = {}

    static ORDER_BY_MAP = {
        "id": "id",
        "email": "email",
        "created_at": "created_at"
    }

    constructor({
        id,
        email,
        password_hash,
        admin,
        reader,
        editor,
        created_at,
    }={}) {
        super();
        this.id = id;
        this.email = email;
        this.password_hash = password_hash;
        this.admin = admin;
        this.reader = reader;
        this.editor = editor;
        this.created_at = created_at;
    }

    /**
     * The EFFECTIVE role set: admin implies every other role. All role
     * checks go through here -- the stored flags only say what was
     * explicitly granted.
     */
    get roles() {
        return {
            admin: !!this.admin,
            reader: !!(this.reader || this.admin),
            editor: !!(this.editor || this.admin),
        };
    }

    static openapi_UserSchema = {
        description: "A user account. The flat admin/reader/editor flags are what was explicitly granted (what update edits); `roles` is the effective set, where admin implies every other role. The password hash is never exposed.",
        type: 'object',
        properties: {
            id: { type: 'integer', minimum: 1 },
            email: { type: 'string', format: 'email', description: "Stored normalized (lowercase, trimmed)" },
            admin: { type: 'boolean' },
            reader: { type: 'boolean', description: "Granted by default" },
            editor: { type: 'boolean' },
            roles: {
                description: "Effective roles: admin implies every other role",
                type: 'object',
                properties: {
                    admin: { type: 'boolean' },
                    reader: { type: 'boolean' },
                    editor: { type: 'boolean' }
                },
                required: [ 'admin', 'reader', 'editor' ]
            },
            created_at: { type: 'string', format: 'date-time' }
        },
        required: [ 'id', 'email', 'admin', 'reader', 'editor', 'roles', 'created_at' ]
    };

    to_api() {
        return {
            id: this.id,
            email: this.email,
            admin: this.admin,
            reader: this.reader,
            editor: this.editor,
            roles: this.roles,
            created_at: this.created_at.toISOString(),
        };
    }

    static from_row(row) {
        if ( row == null ) return null;

        return new this({
            id: row.id,
            email: row.email,
            password_hash: row.password_hash,
            admin: stmt2boolean(row.admin),
            reader: stmt2boolean(row.reader),
            editor: stmt2boolean(row.editor),
            created_at: stmt2datetime(row.created_at),
        });
    }

    static for_id(db, id) {
        const stmt = this.get_stmt(db, "for_id");
        return this.from_row(stmt.get({ id }) ?? null);
    }

    static for_email(db, email) {
        const stmt = this.get_stmt(db, "for_email");
        return this.from_row(stmt.get({ email: this._normalize_email(email) }) ?? null);
    }

    /**
     * The reader/editor filters match EFFECTIVE roles (admins count), same
     * semantics as user.roles; the admin filter is exact.
     */
    static from_db(db, {
        admin,
        reader,
        editor,
        order_by = "id",
        order_direction = "ASC",
        limit = 100,
        offset = 0
    }={}) {
        const wheres = [];
        const params = {};
        const keys = [];

        if ( admin !== undefined ) {
            wheres.push("admin = @admin");
            params.admin = boolean2stmt(admin);
            keys.push("admin");
        }

        if ( reader !== undefined ) {
            wheres.push("(reader = 1 OR admin = 1) = @reader");
            params.reader = boolean2stmt(reader);
            keys.push("reader");
        }

        if ( editor !== undefined ) {
            wheres.push("(editor = 1 OR admin = 1) = @editor");
            params.editor = boolean2stmt(editor);
            keys.push("editor");
        }

        let sql = `SELECT ${SELECT_COLUMNS.join(", ")}\n`
                + `FROM users\n`;
        if ( wheres.length ) {
            sql = sql + `WHERE\n    ${wheres.join("\n    AND ")}\n`;
        }
        if ( order_by !== null ) {
            const _order_by = this.get_order_by_column_name(order_by);
            const _order_direction = this.get_order_direction(order_direction);

            sql = sql + `ORDER BY ${_order_by} ${_order_direction}\n`;

            keys.push("order_by_"+order_by);
            keys.push(_order_direction);
        }
        if ( limit !== null ) {
            sql = sql + `LIMIT @limit OFFSET @offset\n`;
            params.limit = limit;
            params.offset = offset;
            keys.push("limit");
        }

        const stmt = this.build_stmt(
            db,
            "from_db$" + keys.join(":"),
            sql
        );

        return stmt.all(params).map(row => this.from_row(row));
    }

    static _normalize_email(email) {
        if ( typeof email !== "string" ) return email;
        return email.trim().toLowerCase();
    }

    // Minimal format check -- real validation is a UI/API concern
    static _assert_valid_email(email) {
        if ( !email || typeof email !== "string" ) throw new Error("Missing email");
        if ( !email.includes("@") ) throw new Error("Invalid email: " + email);
    }

    static _assert_valid_password(password) {
        if ( !password || typeof password !== "string" ) throw new Error("Missing password");
        if ( password.length < 8 ) throw new Error("Password must be at least 8 characters");
    }

    static _create(db, { email, password_hash, admin, reader, editor }={}) {
        if ( this.get_stmt(db, "for_email").get({ email }) ) {
            throw new ConflictError("User already exists: " + email);
        }

        const result = this.get_stmt(db, "create").run({
            email,
            password_hash,
            admin: boolean2stmt(admin),
            reader: boolean2stmt(reader),
            editor: boolean2stmt(editor),
        });

        return this.for_id(db, result.lastInsertRowid);
    }

    static async create(db, {
        email,
        password,
        admin = false,
        reader = true,
        editor = false,
    }={}) {
        const _email = this._normalize_email(email);
        this._assert_valid_email(_email);
        this._assert_valid_password(password);

        // Hash before entering the sqlite transaction (transactions must
        // stay synchronous; scrypt is the slow part anyway)
        const password_hash = await hash_password(password);

        const transaction = this.build_transaction(db, "create", this._create.bind(this));
        return transaction(db, { email: _email, password_hash, admin, reader, editor });
    }

    static _update(db, user, changes={}) {
        const fresh = this.for_id(db, user.id);
        if ( !fresh ) {
            throw new ForeignKeyError("User does not exist: " + user.id);
        }

        const next = {
            email: changes.email !== undefined ? changes.email : fresh.email,
            admin: changes.admin !== undefined ? changes.admin : fresh.admin,
            reader: changes.reader !== undefined ? changes.reader : fresh.reader,
            editor: changes.editor !== undefined ? changes.editor : fresh.editor,
        };

        const existing = this.get_stmt(db, "for_email").get({ email: next.email });
        if ( existing && existing.id !== fresh.id ) {
            throw new ConflictError("User already exists: " + next.email);
        }

        this.get_stmt(db, "update").run({
            id: fresh.id,
            email: next.email,
            admin: boolean2stmt(next.admin),
            reader: boolean2stmt(next.reader),
            editor: boolean2stmt(next.editor),
        });

        return this.for_id(db, fresh.id);
    }

    /**
     * Only `email` and the role flags -- passwords change via set_password.
     */
    update(db, {
        email,
        admin,
        reader,
        editor,
    }={}) {
        if ( email !== undefined ) {
            email = this.constructor._normalize_email(email);
            this.constructor._assert_valid_email(email);
        }

        const transaction = this.constructor.build_transaction(
            db, "update", this.constructor._update.bind(this.constructor));
        return transaction(db, this, { email, admin, reader, editor });
    }

    static _set_password(db, user, password_hash) {
        const fresh = this.for_id(db, user.id);
        if ( !fresh ) {
            throw new ForeignKeyError("User does not exist: " + user.id);
        }

        this.get_stmt(db, "set_password").run({
            id: fresh.id,
            password_hash,
        });

        return this.for_id(db, fresh.id);
    }

    /**
     * Re-hashes with a fresh salt. Deliberately does NOT revoke sessions --
     * whether "password changed" kills logins is API-layer policy
     * (one Session.revoke_all call away).
     */
    async set_password(db, password) {
        this.constructor._assert_valid_password(password);
        const password_hash = await hash_password(password);

        const transaction = this.constructor.build_transaction(
            db, "set_password", this.constructor._set_password.bind(this.constructor));
        return transaction(db, this, password_hash);
    }

    async verify_password(password) {
        return verify_password(password, this.password_hash);
    }

    /**
     * Login helper: resolves the User on success, null on unknown email OR
     * wrong password (never distinguishable). Unknown emails still burn a
     * scrypt verification so the two failures take the same time.
     */
    static async authenticate(db, { email, password }={}) {
        const user = this.for_email(db, email);
        if ( !user ) {
            await verify_password(password ?? "", await DUMMY_HASH_PROMISE);
            return null;
        }
        return (await user.verify_password(password ?? "")) ? user : null;
    }

    static _delete(db, user) {
        const fresh = this.for_id(db, user.id);
        if ( !fresh ) {
            throw new ForeignKeyError("User does not exist: " + user.id);
        }

        // Sessions die via user_sessions.user_id ON DELETE CASCADE
        this.get_stmt(db, "delete").run({ id: fresh.id });
    }

    delete(db) {
        const transaction = this.constructor.build_transaction(
            db, "delete", this.constructor._delete.bind(this.constructor));
        return transaction(db, this);
    }

    _assert_session_owner(session) {
        if ( !session || session.user_id !== this.id ) {
            throw new ConflictError("Session does not belong to user: " + this.id);
        }
    }

    /**
     * Payload for the short-lived (~1h) stateless access token. Carries
     * everything request handling needs so the users table is never hit --
     * including the EFFECTIVE roles (admin-implies-all applied at mint
     * time, so consumers never re-derive it).
     * The API controller signs it and sets exp from ACCESS_TOKEN_TTL_S.
     */
    to_access_token_payload(session) {
        this._assert_session_owner(session);
        const roles = this.roles;
        return {
            v: 1,
            typ: "access",
            sub: this.id,
            email: this.email,
            admin: roles.admin,
            reader: roles.reader,
            editor: roles.editor,
            sid: session.id,
        };
    }

    /**
     * Payload for the long-lived (~1w) auth token: only good for refreshing,
     * and only while its session row survives (see Session.for_auth_payload).
     * The API controller signs it and sets exp to mirror session.expires_at.
     */
    to_auth_token_payload(session) {
        this._assert_session_owner(session);
        return {
            v: 1,
            typ: "auth",
            sub: this.id,
            sid: session.id,
            token: session.token,
        };
    }

    /**
     * Db-free construction from a signature-verified ACCESS payload, for
     * stateless request handling: the instance is unsaved (no password_hash,
     * no created_at) and the role flags may be up to ~1h stale. The payload
     * carries EFFECTIVE roles, so the instance's flags are effective too
     * (its `roles` getter returns the same set). Anything needing
     * fresh/trusted state should use User.for_id(db, payload.sub) instead.
     */
    static from_token_payload(payload={}) {
        if ( payload.v !== 1 ) {
            throw new Error("Unsupported token payload version: " + payload.v);
        }
        if ( payload.typ !== "access" ) {
            throw new Error("Not an access token payload: " + payload.typ);
        }

        return new this({
            id: payload.sub,
            email: payload.email,
            admin: payload.admin,
            reader: payload.reader,
            editor: payload.editor,
            password_hash: null,
            created_at: null,
        });
    }
}
