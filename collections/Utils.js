const { Collection, Controller } = require("./lib/asseverate.js");

const { schema_version } = require("../lib/db.js");

module.exports = class UtilsCollection extends Collection {
    static prefix = "/api/utils";

    static openapi_Tags = ["Utils"];

    static controllers = [

        class GetVersions extends Controller {
            static path = "/versions";

            static openapi_Summary = "Get the current versions of the webserver, webapp, and database";

            static openapi_Description = "This endpoint can be used by the webapp to check if the webserver and webapp are up to date, and to know what version of the database it is working with. The webapp can use this information to determine if it needs to refresh its cache or do a hard reload, and it can also display the versions in an about page or something.";

            static query_key = ["versions"];

            static reader = false;

            static method = "GET";

            init({ version, ...args }={}) {
                super.init(args);
                this.version = version;
            }

            async respond() {
                return {
                    webserver: this.version,
                    webapp: this.version, // NOTE : for now, we version the webapp and webserver together since they are deployed together, but we can split this out later by having the server read the webapp version from a file or something on startup
                    db: schema_version(this.db),
                };
            }

            static openapi_ResponseSchema = {
                type: 'object',
                properties: {
                    webserver: { type: 'string', example: '1.0.0' },
                    webapp: { type: 'string', example: '1.0.0' },
                    db: { type: 'integer', minimum: 1, description: "Schema version (PRAGMA user_version), bumped by migrations" }
                },
                required: [ 'webserver', 'webapp', 'db' ]
            };
        }
    ]
}
