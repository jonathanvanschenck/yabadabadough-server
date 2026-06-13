
const { join } = require("path");
const dotenv = require("dotenv");
dotenv.config({ path: join(__dirname, ".env") });
const env = process.env;


module.exports = {
    db: {
        path: env.YDD_SQLITE_PATH,
        options: {}
    }
}
