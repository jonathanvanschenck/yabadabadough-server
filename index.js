
const env = require("./env.js");

const {
    create_connection,
    initialize_db
} = require("./lib/db.js");



const db = create_connection(env.db);


// Start
!async function(){
    initialize_db(db);
}();
