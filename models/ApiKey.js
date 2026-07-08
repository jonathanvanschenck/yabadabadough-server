
const crypto = require("crypto");

const Base = require("./Base.js");

const {
    ConflictError,
    ForeignKeyError
} = require("../lib/db.js");

const {
    datetime2stmt,
    stmt2datetime,
    boolean2stmt,
    stmt2boolean,
} = require("../lib/db.js").helpers;

const SELECT_COLUMNS = [
    "id",
    "user_id",
    "token_hash",
    "name",
    "reader",
    "editor",
    "expires_at",
    "last_used_at",
    "created_at",
];

const SECRET_BYTES = 32;
const KEY_PREFIX = "ydd_";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * One API-key credential: a row here (plus its secret) IS the right to mint
 * sessionless (sid: null) access tokens at POST /api/auth/api-token.
 * Revocation is row deletion -- no flag -- and outstanding access tokens
 * still live out their <=1h expiry (the same accepted staleness window as
 * sessions).
 *
 * The secret is stored ONLY as its sha256 hex (`token_hash`): the plaintext
 * ("ydd_" + 64 hex chars) leaves `create` exactly once and can never be
 * re-shown. Exchange looks the presented key up BY hash -- no timing-safe
 * compare needed, since sha256 of a high-entropy random secret is
 * unpredictable to an attacker.
 *
 * Per-key `reader`/`editor` flags scope the credential: effective roles at
 * exchange = the owner's effective roles INTERSECTED with the key's flags,
 * and admin is never minted from an API key (there is no admin column).
 *
 * `expires_at` is nullable (NULL = never expires). Expired keys refuse to
 * exchange but stay listed -- visibility over housekeeping, so unlike
 * sessions there is no prune sweep.
 *
 * Require direction is strictly ApiKey -> User (users are checked via the
 * FK); list a user's keys with ApiKey.from_db(db, { user_id }). User
 * deletion cascades keys at the db layer.
 */
module.exports = class ApiKey extends Base {
    static PREPARED_STMTS = {
        for_id: `
            SELECT ${SELECT_COLUMNS.join(", ")}
            FROM user_api_keys
            WHERE id = @id
        `,
        for_token_hash: `
            SELECT ${SELECT_COLUMNS.join(", ")}
            FROM user_api_keys
            WHERE token_hash = @token_hash
        `,
        create: `
            INSERT INTO user_api_keys (
                user_id,
                token_hash,
                name,
                reader,
                editor,
                expires_at
            ) VALUES (
                @user_id,
                @token_hash,
                @name,
                @reader,
                @editor,
                @expires_at
            )
        `,
        touch: `
            UPDATE user_api_keys
            SET last_used_at = @last_used_at
            WHERE id = @id
        `,
        delete: `
            DELETE FROM user_api_keys
            WHERE id = @id
        `,
    }

    static PREPARED_TRANSACTIONS = {}

    static ORDER_BY_MAP = {
        "id": "id",
        "name": "name",
        "expires_at": "expires_at",
        "created_at": "created_at"
    }

    constructor({
        id,
        user_id,
        token_hash,
        name,
        reader,
        editor,
        expires_at,
        last_used_at,
        created_at,
    }={}) {
        super();
        this.id = id;
        this.user_id = user_id;
        this.token_hash = token_hash;
        this.name = name;
        this.reader = reader;
        this.editor = editor;
        this.expires_at = expires_at;
        this.last_used_at = last_used_at;
        this.created_at = created_at;
    }

    get expired() {
        return this.expires_at != null && this.expires_at <= new Date();
    }

    static hash_secret(secret) {
        return crypto.createHash("sha256").update(String(secret), "utf8").digest("hex");
    }

    static openapi_ApiKeySchema = {
        description: "An API-key credential: exchanged at POST /api/auth/api-token for sessionless access tokens carrying the key's role scope (never admin). The secret itself is shown exactly once at creation and never again. Revoking a key stops future exchanges; already-minted access tokens live out their <=1h expiry.",
        type: 'object',
        properties: {
            id: { type: 'integer', minimum: 1 },
            user_id: { type: 'integer', minimum: 1 },
            name: { type: 'string', description: "Human label ('metrics dashboard', 'statement importer', ...)" },
            reader: { type: 'boolean', description: "Key-level role scope: minted tokens carry reader only if both the key and the owner have it" },
            editor: { type: 'boolean', description: "Key-level role scope: minted tokens carry editor only if both the key and the owner have it" },
            expires_at: { type: 'string', format: 'date-time', nullable: true, description: "Null = never expires; expired keys refuse to exchange but stay listed" },
            last_used_at: { type: 'string', format: 'date-time', nullable: true, description: "Touched on every exchange" },
            created_at: { type: 'string', format: 'date-time' }
        },
        required: [ 'id', 'user_id', 'name', 'reader', 'editor', 'expires_at', 'last_used_at', 'created_at' ]
    };

    // `token_hash` never leaves the model: the plaintext secret is returned
    // once from `create`, and even its hash is not API-visible
    to_api() {
        return {
            id: this.id,
            user_id: this.user_id,
            name: this.name,
            reader: this.reader,
            editor: this.editor,
            expires_at: this.expires_at ? this.expires_at.toISOString() : null,
            last_used_at: this.last_used_at ? this.last_used_at.toISOString() : null,
            created_at: this.created_at.toISOString(),
        };
    }

    static from_row(row) {
        if ( row == null ) return null;

        return new this({
            id: row.id,
            user_id: row.user_id,
            token_hash: row.token_hash,
            name: row.name,
            reader: stmt2boolean(row.reader),
            editor: stmt2boolean(row.editor),
            expires_at: stmt2datetime(row.expires_at),
            last_used_at: stmt2datetime(row.last_used_at),
            created_at: stmt2datetime(row.created_at),
        });
    }

    static for_id(db, id) {
        const stmt = this.get_stmt(db, "for_id");
        return this.from_row(stmt.get({ id }) ?? null);
    }

    static _from_db_wheres({
        user_id,
        active,  // true: not expired (never-expiring counts), false: expired
    }={}) {
        const wheres = [];
        const params = {};
        const keys = [];

        if ( user_id !== undefined ) {
            wheres.push("user_id = @user_id");
            params.user_id = user_id;
            keys.push("user_id");
        }
        if ( active !== undefined ) {
            wheres.push(active
                ? "(expires_at IS NULL OR expires_at > @now)"
                : "expires_at <= @now");
            params.now = datetime2stmt(new Date());
            keys.push("active_" + (active ? 1 : 0));
        }

        return { wheres, params, keys };
    }

    static from_db(db, {
        order_by = "id",
        order_direction = "ASC",
        limit = 100,
        offset = 0,
        ...filters
    }={}) {
        const { wheres, params, keys } = this._from_db_wheres(filters);

        let sql = `SELECT ${SELECT_COLUMNS.join(", ")}\n`
                + `FROM user_api_keys\n`;
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

    /**
     * Total rows matching the same filters as from_db (order/limit/offset
     * are accepted and ignored, so the API layer can pass one filter object
     * to both).
     */
    static count(db, { order_by, order_direction, limit, offset, ...filters }={}) {
        const { wheres, params, keys } = this._from_db_wheres(filters);

        let sql = `SELECT COUNT(*) AS count\n`
                + `FROM user_api_keys\n`;
        if ( wheres.length ) {
            sql = sql + `WHERE\n    ${wheres.join("\n    AND ")}\n`;
        }

        const stmt = this.build_stmt(
            db,
            "count$" + keys.join(":"),
            sql
        );

        return stmt.get(params).count;
    }

    static _create(db, { user_id, token_hash, name, reader, editor, expires_at }={}) {
        let result;
        try {
            result = this.get_stmt(db, "create").run({
                user_id,
                token_hash,
                name,
                reader: boolean2stmt(reader),
                editor: boolean2stmt(editor),
                expires_at: expires_at ? datetime2stmt(expires_at) : null,
            });
        } catch (err) {
            if ( err.code === "SQLITE_CONSTRAINT_FOREIGNKEY" ) {
                throw new ForeignKeyError("User does not exist: " + user_id);
            }
            throw err;
        }

        return this.for_id(db, result.lastInsertRowid);
    }

    /**
     * Mint a new API key. Returns { api_key, secret } -- the ONLY time the
     * plaintext secret ("ydd_" + 64 hex chars) exists outside the caller's
     * hands; only its sha256 is stored.
     *
     * ttl_days: null (the default) creates a key that never expires;
     * otherwise any finite number, including negative/zero -- a non-positive
     * value creates an already-expired key, useless for real credentials but
     * deliberately allowed so tests can fabricate expired keys without
     * inline SQL against the table (the Session.create convention).
     */
    static create(db, {
        user_id,
        name,
        reader = true,
        editor = false,
        ttl_days = null,
    }={}) {
        if ( user_id == null ) throw new Error("Missing user_id");
        if ( typeof name !== "string" || !name.trim() ) {
            throw new Error("Missing name");
        }
        if ( ttl_days !== null && (typeof ttl_days !== "number" || !Number.isFinite(ttl_days)) ) {
            throw new Error("Invalid ttl_days: " + ttl_days);
        }

        const secret = KEY_PREFIX + crypto.randomBytes(SECRET_BYTES).toString("hex");
        const expires_at = ttl_days === null
            ? null
            : new Date(Date.now() + ttl_days * MS_PER_DAY);

        const transaction = this.build_transaction(db, "create", this._create.bind(this));
        const api_key = transaction(db, {
            user_id,
            token_hash: this.hash_secret(secret),
            name: name.trim(),
            reader,
            editor,
            expires_at,
        });

        return { api_key, secret };
    }

    static _for_exchange(db, secret) {
        const stmt = this.get_stmt(db, "for_token_hash");
        const api_key = this.from_row(
            stmt.get({ token_hash: this.hash_secret(secret) }) ?? null);
        if ( !api_key ) {
            throw new ForeignKeyError("API key does not exist");
        }

        if ( api_key.expired ) {
            throw new ConflictError("API key is expired: " + api_key.id);
        }

        this.get_stmt(db, "touch").run({
            id: api_key.id,
            last_used_at: datetime2stmt(new Date()),
        });

        return this.for_id(db, api_key.id);
    }

    /**
     * The exchange guard: resolves a presented plaintext key (row exists for
     * its hash, not expired), touches last_used_at, and returns the fresh
     * ApiKey. The controller then mints a sessionless access token via
     * User.for_id(db, api_key.user_id).to_api_key_access_token_payload(api_key).
     */
    static for_exchange(db, secret) {
        const transaction = this.build_transaction(
            db, "for_exchange", this._for_exchange.bind(this));
        return transaction(db, secret);
    }

    static _delete(db, api_key) {
        const fresh = this.for_id(db, api_key.id);
        if ( !fresh ) {
            throw new ForeignKeyError("API key does not exist: " + api_key.id);
        }

        this.get_stmt(db, "delete").run({ id: fresh.id });
    }

    /**
     * Revocation: the secret becomes worthless for future exchanges
     * (outstanding access tokens still live out their <=1h expiry).
     */
    delete(db) {
        const transaction = this.constructor.build_transaction(
            db, "delete", this.constructor._delete.bind(this.constructor));
        return transaction(db, this);
    }
}
