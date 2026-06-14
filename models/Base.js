
module.exports = class BaseModel {
    // Override me for `get_stmt`
    static PREPARED_STMTS = {};

    // Override me for `get_transaction`
    static PREPARED_TRANSACTIONS = {};

    // Override me for `get_order_by_column_name`
    static ORDER_BY_MAP = {}

    static get_order_direction(input) {
        switch(input) {
            case "ASC": return "ASC";
            case "DESC": return "DESC";
            default: throw new Error("Unsupported order direction: "+input);
        }
    }
    get_order_direction(input) {
        return this.constructor.get_order_direction(input);
    }

    static get_order_by_column_name(name) {
        const value = this.ORDER_BY_MAP[name];
        if ( !value ) throw new Error("Unsupported order by name: "+name);
        return value;
    }
    get_order_by_column_name(input) {
        return this.constructor.get_order_by_column_name(input);
    }

    static build_stmt(db, key, sql) {
        const total_key = this.name + "#" + key;

        // cache stmts for later use
        if ( !db.prepared_stmts.has(total_key) ) {
            db.prepared_stmts.set(total_key, db.prepare(sql));
        }

        return db.prepared_stmts.get(total_key);
    }
    build_stmt(db, key, sql) {
        return this.constructor.build_stmt(db, key, sql);
    }

    static get_stmt(db, key) {
        const stmt = this.PREPARED_STMTS[key];
        if ( !stmt ) throw new Error("No prepared statement for key: "+key);
        return this.build_stmt(db, key, stmt);
    }
    get_stmt(db, key) {
        return this.constructor.get_stmt(db, key);
    }

    static build_transaction(db, key, func) {
        const total_key = this.name + "#" + key;

        // cache transactions for later use
        if ( !db.prepared_transactions.has(total_key) ) {
            db.prepared_transactions.set(total_key, db.transaction(func));
        }

        return db.prepared_transactions.get(total_key);
    }
    build_transaction(db, key, func) {
        return this.constructor.build_transaction(db, key, func);
    }
    static get_transaction(db, key) {
        const transaction = this.PREPARED_TRANSACTIONS[key];
        if ( !transaction ) throw new Error("No prepared statement for key: "+key);
        return this.build_transaction(db, key, transaction);
    }
    get_transaction(db, key, func) {
        return this.constructor.get_transaction(db, key, func);
    }
}
