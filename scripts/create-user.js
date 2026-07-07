#!/usr/bin/env node
/**
 * Bootstrap / recovery CLI for user accounts (there is no API yet):
 *
 *   node scripts/create-user.js <email> <password> [--admin] [--editor]
 *   node scripts/create-user.js <email> <password> --set-password
 *
 * The first form creates a user; the second resets an existing user's
 * password. Prints the user's to_api() JSON on success.
 */

const env = require("../env.js");
const { create_connection, initialize_db, ConflictError } = require("../lib/db.js");
const User = require("../models/User.js");

function usage() {
    console.error("Usage: node scripts/create-user.js <email> <password> [--admin] [--editor] [--set-password]");
    process.exit(1);
}

const args = process.argv.slice(2);
const flags = args.filter(arg => arg.startsWith("--"));
const positional = args.filter(arg => !arg.startsWith("--"));

if ( positional.length !== 2 ) usage();
for ( const flag of flags ) {
    if ( flag !== "--admin" && flag !== "--editor" && flag !== "--set-password" ) usage();
}

const [ email, password ] = positional;
const admin = flags.includes("--admin");
const editor = flags.includes("--editor");
const set_password = flags.includes("--set-password");

const db = create_connection(env.db);
initialize_db(db);

!async function() {
    try {
        let user;
        if ( set_password ) {
            user = User.for_email(db, email);
            if ( !user ) {
                console.error("No such user: " + email);
                process.exit(1);
            }
            user = await user.set_password(db, password);
        } else {
            user = await User.create(db, { email, password, admin, editor });
        }

        console.log(JSON.stringify(user.to_api(), null, 2));
    } catch (err) {
        if ( err instanceof ConflictError ) {
            console.error(err.message);
            process.exit(1);
        }
        throw err;
    } finally {
        db.close();
    }
}();
