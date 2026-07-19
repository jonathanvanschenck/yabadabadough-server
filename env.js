
const { join } = require("path");
const dotenv = require("dotenv");
dotenv.config({ path: join(__dirname, ".env") });
const env = process.env;

function parse_port(str, fallback) {
    const port = parseInt(str);
    if ( isNaN(port) || port < 1 || port > 2**16 ) return fallback;
    return port;
}

// Unset falls back; anything else is true only when it is exactly "true", so a
// stray value fails closed rather than silently enabling something.
function parse_boolean(str, fallback) {
    if ( str === undefined || str === "" ) return fallback;
    return str === "true";
}

let log_format;
switch ( env.YDD_LOG_VERBOSITY ) {
    case "simple":
        log_format = ":TYPE | :STRING";
        break;
    case "short":
        log_format = ":TYPE - :NAMESPACE | :STRING";
        break;
    case "full":
    default:
        log_format = "[:ISO] :TYPE - :NAMESPACE | :STRING";
        break;
}

module.exports = {
    db: {
        // Absolute paths are honored as given; relative ones resolve against
        // the app root (see lib/db.js create_connection).
        path: env.YDD_SQLITE_PATH,
        options: {}
    },
    tokens: {
        // Directory of <kid>.private.pem / <kid>.public.pem Ed25519 pairs;
        // bootstrap/rotate with scripts/generate-jwt-key.js
        keys_dir: env.YDD_JWT_KEYS_DIR || join(__dirname, "keys")
    },
    log: {
        namespace: "",
        log_level: env.YDD_LOG_LEVEL || 'debug',
        // yalls' Logger takes `no_colors`, not `colorized` -- passing the
        // latter was silently ignored, so YDD_LOG_COLORIZED did nothing and
        // container logs always carried ANSI escapes.
        no_colors: !parse_boolean(env.YDD_LOG_COLORIZED, true),
        format: log_format
    },
    webserver: {
        api: {
            dev: parse_boolean(env.ASSEVERATE_DEV, false),
            disable_auth: parse_boolean(env.YDD_DISABLE_AUTH, false),
            // Only set false for local plain-http development
            secure_cookies: parse_boolean(env.YDD_SECURE_COOKIES, true),
            version: require("./package.json").version,
            penalty_ms: 1000,
            swagger: {
                use: true
            }
        },
        webservice: {
            local: {
                address: env.YDD_SERVER_ADDRESS || "localhost",
                port: parse_port(env.YDD_SERVER_PORT, 1234),
                protocol: "http"
            },
            proxy: {
                address: env.YDD_PROXY_ADDRESS || "localhost",
                port: parse_port(env.YDD_PROXY_PORT, 443),
                protocol: env.YDD_PROXY_PROTOCOL || "https"
            }
        }
    },
}
