#!/usr/bin/env node
/**
 * Bootstrap / recovery CLI for user accounts:
 *
 *   node scripts/create-user.js <email> [password] [--admin] [--editor]
 *   node scripts/create-user.js <email> [password] --set-password
 *
 * The first form creates a user; the second resets an existing user's
 * password. Prints the user's to_api() JSON on success.
 *
 * Omitting <password> prompts for it (twice, with the echo suppressed), which
 * keeps the secret out of the shell history and the process table. That needs
 * a terminal: piped/redirected stdin is a hard error rather than a silent
 * read of whatever happened to be on the pipe.
 *
 * NOTE this script is now only the headless/recovery path -- a fresh server
 * with no users at all offers first-run admin creation in the browser
 * (POST /api/auth/setup, see collections/Auth.js), so a plain
 * docker-compose-up install needs no CLI step.
 */

const env = require("../env.js");
const { create_connection, initialize_db, ConflictError } = require("../lib/db.js");
const User = require("../models/User.js");

function usage() {
    console.error("Usage: node scripts/create-user.js <email> [password] [--admin] [--editor] [--set-password]");
    console.error("       (omit [password] to be prompted for it)");
    process.exit(1);
}

/**
 * Read one line from the terminal without echoing it.
 *
 * Done by hand on a raw-mode stdin rather than through readline: readline
 * only hides input via its private `_writeToOutput`, and -- worse -- closing
 * a terminal interface pauses stdin, so the SECOND prompt of a
 * password/confirm pair never receives a line and simply hangs. Reading the
 * keystrokes directly keeps both prompts on one un-disturbed stream.
 */
function hidden_question(question) {
    return new Promise((resolve) => {
        const stdin = process.stdin;

        process.stdout.write(question);

        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding("utf8");

        let answer = "";

        function finish(value) {
            stdin.removeListener("data", on_data);
            stdin.removeListener("end", on_end);
            stdin.setRawMode(false);
            stdin.pause();
            // Nothing was echoed, so the Enter the user pressed never landed
            process.stdout.write("\n");
            resolve(value);
        }

        function on_end() {
            // stdin closed mid-prompt: treat as an empty answer and let the
            // caller's validation reject it, rather than hanging forever
            finish(answer);
        }

        function on_data(chunk) {
            for ( const ch of chunk ) {
                if ( ch === "\r" || ch === "\n" || ch === "\u0004" ) return finish(answer);

                if ( ch === "\u0003" ) { // Ctrl-C: restore the terminal first
                    stdin.setRawMode(false);
                    stdin.pause();
                    process.stdout.write("\n");
                    process.exit(1);
                }

                if ( ch === "\u007f" || ch === "\b" ) {
                    answer = answer.slice(0, -1);
                } else if ( ch >= " " ) { // ignore every other control char
                    answer = answer + ch;
                }
            }
        }

        stdin.on("data", on_data);
        stdin.on("end", on_end);
    });
}

async function prompt_for_password() {
    if ( !process.stdin.isTTY ) {
        console.error("No password given and stdin is not a terminal.");
        console.error("Pass the password as an argument, or run this interactively.");
        process.exit(1);
    }

    const password = await hidden_question("Password: ");
    const confirm = await hidden_question("Confirm password: ");

    if ( password !== confirm ) {
        console.error("Passwords do not match.");
        process.exit(1);
    }

    return password;
}

const args = process.argv.slice(2);
const flags = args.filter(arg => arg.startsWith("--"));
const positional = args.filter(arg => !arg.startsWith("--"));

if ( positional.length < 1 || positional.length > 2 ) usage();
for ( const flag of flags ) {
    if ( flag !== "--admin" && flag !== "--editor" && flag !== "--set-password" ) usage();
}

const [ email, password_arg ] = positional;
const admin = flags.includes("--admin");
const editor = flags.includes("--editor");
const set_password = flags.includes("--set-password");

const db = create_connection(env.db);
initialize_db(db);

!async function() {
    try {
        const password = password_arg ?? await prompt_for_password();

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
        // Conflicts and the model's own validation ("Password must be at
        // least 8 characters", "Invalid email") are ordinary user mistakes,
        // especially now that the password is typed at a prompt -- report
        // them as messages, not stack traces
        if ( err instanceof ConflictError || err.constructor === Error ) {
            console.error(err.message);
            process.exit(1);
        }
        throw err;
    } finally {
        db.close();
    }
}();
