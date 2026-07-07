const { Logger } = require("yalls");

const Webserver = require("./lib/Webserver.js");
const TokenManager = require("./lib/TokenManager.js");

const env = require("./env.js");

const {
    create_connection,
    initialize_db
} = require("./lib/db.js");



const db = create_connection(env.db);


// Start
!async function(){

    const log = Logger.console(env.log.namespace, env.log);


    log.info("Initalizing db....");
    initialize_db(db, log.create_child("db"));


    log.info("Loading JWT keys....");
    const token_manager = TokenManager.from_dir(env.tokens.keys_dir);
    log.info(` └─── ${token_manager.keys.size} key(s) loaded, signing with kid ${token_manager.active_kid}`);


    const ws = new Webserver(
        env.webserver,
        {
            log,
            db,
            token_manager,
        }
    );
    await ws.start();

    for ( const sig of [ "SIGINT", "SIGTERM" ] ) {
        process.once(sig, async() => {
            // Allow repeats to force kill
            for ( const sig of [ "SIGINT", "SIGTERM" ] ) {
                process.on(sig, () => {
                    log.info(sig+" recieved, ungracefully shutting down now");
                    process.exit(1)
                });
            };

            log.info(sig+" received, shutting down");


            await ws.stop();

        });
    }

}();
