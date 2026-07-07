
const { join, dirname } = require("path");
const { readFileSync, existsSync, mkdirSync } = require("fs");
const Database = require("better-sqlite3");

const YDate = require("./YDate.js");


module.exports = {
    create_connection: function(config) {
        let path = config.path;
        const options = config.option;

        if ( path != ":memory:" ) {
            path = join(__dirname, "..", path); // Relative to parent
            const dir = dirname(path);
            if ( !existsSync(dir) ) {
                mkdirSync(dir, { recursive: true });
            }
        }

        const db = new Database(path, options);
        db.pragma("journal_mode = WAL");
        db.pragma("foreign_keys = ON");

        // For models to use
        db.prepared_stmts = new Map();
        db.prepared_transactions = new Map();

        return db;
    },

    initialize_db: function(db, log) {
        const version = db.pragma("user_version", { simple: true });

        if ( version == 0 ) {
            log?.info("Initializing schema");
            // DB is uninitialized, just write the correct schema
            const schema = readFileSync(join(__dirname, '../db/migrations/_schema.sql'), 'utf8');
            db.exec(schema);

            return; // THen bail, becuase we are done
        }


        // TODO
        if ( version < 2 ) {
            // Run migration 1->2
        }
        if ( version < 3 ) {
            // Run migration 2->3
        }
    },

    // The schema version (PRAGMA user_version) that initialize_db manages
    schema_version: function(db) {
        return db.pragma("user_version", { simple: true });
    },


    ConflictError: class ConflictError extends Error {},
    ForeignKeyError: class ForeignKeyError extends Error {},

    helpers: {
        currency2stmt: (value, fallback=null) => {
            const number = parseFloat(value);
            if ( isNaN(number) ) return fallback;
            return Math.round(10000*number);
        },
        stmt2currency: (value, fallback=null) => {
            const number = parseInt(value);
            if ( isNaN(number) ) return fallback;
            return number / 10000;
        },

        datetime2stmt: (value, fallback=null) => {
            const date = new Date(value);
            if ( isNaN(date) ) return fallback;
            return date.toISOString();
        },
        stmt2datetime: (value, fallback=null) => {
            // new Date(null) is the epoch, so NULL columns need an explicit check
            if ( value == null ) return fallback;
            const date = new Date(value);
            return isNaN(date) ? fallback : date;
        },

        boolean2stmt: (value) => {
            if ( value == null ) return value;
            return value ? 1 : 0
        },
        stmt2boolean: (value) => {
            if ( value == null ) return value;
            return !!value;
        },

        stmt2ydate: (value, fallback=null) => {
            const retval = YDate.parse(value);
            if ( !retval ) return fallback;
            return retval;
        },
        ydate2stmt: (value) => {
            if ( value == null ) return value;
            return value.toString();
        }
    }
}
