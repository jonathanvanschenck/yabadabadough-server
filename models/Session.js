
const crypto = require("crypto");

const Base = require("./Base.js");

const {
    ConflictError,
    ForeignKeyError
} = require("../lib/db.js");

const {
    datetime2stmt,
    stmt2datetime,
} = require("../lib/db.js").helpers;

const SELECT_COLUMNS = [
    "id",
    "user_id",
    "token",
    "note",
    "expires_at",
    "last_used_at",
    "created_at",
];

const TOKEN_BYTES = 16;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * One login session: a row here IS the right to refresh access tokens.
 * A session is refreshable iff its row exists and expires_at is in the
 * future -- logout (delete) and revoke-all are row deletions, no flag.
 *
 * `token` is a per-session random secret embedded in the auth-token payload
 * and required to match (timing-safe) at refresh: it defends against sqlite
 * reusing integer ids, and is what refresh-token rotation regenerates
 * (for_auth_payload's `rotate` option -- the API layer rotates on every
 * refresh, making each auth token single-use). It is never exposed via
 * to_api.
 *
 * Expiry is fixed at creation (no sliding window): refreshes never extend
 * expires_at, they only touch last_used_at (and rotate the secret).
 *
 * Require direction is strictly Session -> User (users are checked via the
 * FK); User never requires Session -- list a user's sessions with
 * Session.from_db(db, { user_id }).
 */
module.exports = class Session extends Base {
    static DEFAULT_TTL_DAYS = 7;

    static PREPARED_STMTS = {
        for_id: `
            SELECT ${SELECT_COLUMNS.join(", ")}
            FROM user_sessions
            WHERE id = @id
        `,
        create: `
            INSERT INTO user_sessions (
                user_id,
                token,
                note,
                expires_at
            ) VALUES (
                @user_id,
                @token,
                @note,
                @expires_at
            )
        `,
        touch: `
            UPDATE user_sessions
            SET last_used_at = @last_used_at
            WHERE id = @id
        `,
        rotate: `
            UPDATE user_sessions
            SET token = @token, last_used_at = @last_used_at
            WHERE id = @id
        `,
        delete: `
            DELETE FROM user_sessions
            WHERE id = @id
        `,
        revoke_all: `
            DELETE FROM user_sessions
            WHERE user_id = @user_id
        `,
        prune: `
            DELETE FROM user_sessions
            WHERE expires_at <= @now
        `,
    }

    static PREPARED_TRANSACTIONS = {}

    static ORDER_BY_MAP = {
        "id": "id",
        "expires_at": "expires_at",
        "created_at": "created_at"
    }

    constructor({
        id,
        user_id,
        token,
        note,
        expires_at,
        last_used_at,
        created_at,
    }={}) {
        super();
        this.id = id;
        this.user_id = user_id;
        this.token = token;
        this.note = note;
        this.expires_at = expires_at;
        this.last_used_at = last_used_at;
        this.created_at = created_at;
    }

    get expired() {
        return this.expires_at <= new Date();
    }

    static openapi_SessionSchema = {
        description: "A login session: the row IS the right to refresh access tokens, until expires_at. The per-session secret is never exposed.",
        type: 'object',
        properties: {
            id: { type: 'integer', minimum: 1 },
            user_id: { type: 'integer', minimum: 1 },
            note: { type: 'string', nullable: true, description: "Optional device/client label" },
            expires_at: { type: 'string', format: 'date-time', description: "Fixed at login; refreshes never extend it" },
            last_used_at: { type: 'string', format: 'date-time', nullable: true, description: "Touched on every refresh" },
            created_at: { type: 'string', format: 'date-time' }
        },
        required: [ 'id', 'user_id', 'note', 'expires_at', 'last_used_at', 'created_at' ]
    };

    // `token` is a secret: it only ever leaves the model inside an
    // auth-token payload (User.to_auth_token_payload)
    to_api() {
        return {
            id: this.id,
            user_id: this.user_id,
            note: this.note,
            expires_at: this.expires_at.toISOString(),
            last_used_at: this.last_used_at ? this.last_used_at.toISOString() : null,
            created_at: this.created_at.toISOString(),
        };
    }

    static from_row(row) {
        if ( row == null ) return null;

        return new this({
            id: row.id,
            user_id: row.user_id,
            token: row.token,
            note: row.note,
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
        active,  // true: not expired, false: expired
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
            wheres.push(active ? "expires_at > @now" : "expires_at <= @now");
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
                + `FROM user_sessions\n`;
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
                + `FROM user_sessions\n`;
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

    static _create(db, { user_id, token, expires_at, note }={}) {
        // Opportunistic housekeeping: every login sweeps expired sessions
        // (ALL users'), so the table stays bounded by real usage without a
        // cron. Runs before the insert so a deliberately-expired session
        // (negative ttl_days) survives its own creation.
        this.get_stmt(db, "prune").run({ now: datetime2stmt(new Date()) });

        let result;
        try {
            result = this.get_stmt(db, "create").run({
                user_id,
                token,
                note: note ?? null,
                expires_at: datetime2stmt(expires_at),
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
     * Also prunes ALL expired sessions as a side effect (see _create) --
     * logins are the housekeeping trigger, so no cron is needed.
     *
     * ttl_days may be any finite number, including negative/zero -- a
     * non-positive value creates an already-expired session. That is useless
     * for real logins but deliberately allowed so tests can fabricate
     * expired sessions without inline SQL against the table. (Note the
     * sweep above: an expired session only survives until the NEXT create.)
     */
    static create(db, {
        user_id,
        ttl_days = this.DEFAULT_TTL_DAYS,
        note = null,
    }={}) {
        if ( user_id == null ) throw new Error("Missing user_id");
        if ( typeof ttl_days !== "number" || !Number.isFinite(ttl_days) ) {
            throw new Error("Invalid ttl_days: " + ttl_days);
        }

        const token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
        const expires_at = new Date(Date.now() + ttl_days * MS_PER_DAY);

        const transaction = this.build_transaction(db, "create", this._create.bind(this));
        return transaction(db, { user_id, token, expires_at, note });
    }

    static _for_auth_payload(db, { payload={}, rotate=false }={}) {
        const session = this.for_id(db, payload.sid);
        if ( !session ) {
            throw new ForeignKeyError("Session does not exist: " + payload.sid);
        }

        // Timing-safe token match; length differs only for malformed payloads
        const given = Buffer.from(String(payload.token ?? ""), "utf8");
        const actual = Buffer.from(session.token, "utf8");
        if ( given.length !== actual.length || !crypto.timingSafeEqual(given, actual) ) {
            throw new ConflictError("Session token mismatch: " + session.id);
        }

        if ( payload.sub !== session.user_id ) {
            throw new ConflictError("Session does not belong to user: " + payload.sub);
        }

        if ( session.expired ) {
            throw new ConflictError("Session is expired: " + session.id);
        }

        if ( rotate ) {
            this.get_stmt(db, "rotate").run({
                id: session.id,
                token: crypto.randomBytes(TOKEN_BYTES).toString("hex"),
                last_used_at: datetime2stmt(new Date()),
            });
        } else {
            this.get_stmt(db, "touch").run({
                id: session.id,
                last_used_at: datetime2stmt(new Date()),
            });
        }

        return this.for_id(db, session.id);
    }

    /**
     * The refresh guard: validates a signature-verified AUTH payload against
     * its session row (exists, secret matches, owned by payload.sub, not
     * expired), touches last_used_at, and returns the fresh Session. The
     * controller then mints a new access token via
     * User.for_id(db, session.user_id).to_access_token_payload(session).
     *
     * With `rotate: true` the per-session secret is regenerated in the same
     * transaction as the guard, so the presented payload is single-use: the
     * controller must mint a NEW auth token from the returned session (still
     * against the session's fixed expires_at -- rotation never extends a
     * session). Guard failures never rotate.
     */
    static for_auth_payload(db, payload={}, { rotate=false }={}) {
        if ( payload.v !== 1 ) {
            throw new Error("Unsupported token payload version: " + payload.v);
        }
        if ( payload.typ !== "auth" ) {
            throw new Error("Not an auth token payload: " + payload.typ);
        }

        const transaction = this.build_transaction(
            db, "for_auth_payload", this._for_auth_payload.bind(this));
        return transaction(db, { payload, rotate });
    }

    static _delete(db, session) {
        const fresh = this.for_id(db, session.id);
        if ( !fresh ) {
            throw new ForeignKeyError("Session does not exist: " + session.id);
        }

        this.get_stmt(db, "delete").run({ id: fresh.id });
    }

    /**
     * Logout: the auth token referencing this session becomes worthless
     * (outstanding access tokens still live out their <=20m expiry).
     */
    delete(db) {
        const transaction = this.constructor.build_transaction(
            db, "delete", this.constructor._delete.bind(this.constructor));
        return transaction(db, this);
    }

    /**
     * Revoke all logins for a user. Returns the number of sessions killed.
     */
    static revoke_all(db, user_id) {
        const result = this.get_stmt(db, "revoke_all").run({ user_id });
        return result.changes;
    }

    /**
     * Housekeeping: delete expired sessions (they are already dead -- this
     * just reclaims the rows). Returns the number pruned.
     */
    static prune(db) {
        const result = this.get_stmt(db, "prune").run({
            now: datetime2stmt(new Date()),
        });
        return result.changes;
    }
}
