
const { readdirSync } = require('fs');
const path = require('path');

const files = readdirSync(path.join(__dirname, '../models'));

const schemas = {};

for ( const file of files ) {
    if ( file.endsWith('.js') ) {
        const model = require(path.join(__dirname, '../models', file));
        for ( const key in model ) {
            if ( key.startsWith('openapi_') && !!model[key] ) {
                const schema_name = key.replace('openapi_', '');
                schemas[schema_name] = model[key];
            }
        }
    }
}

schemas.NullSchema = {
    type: 'string',
    nullable: true,
    enum: [null]
};

// { type: "invalidate", key: ["vendors"], exact: false }
schemas.InvalidationSchema = {
    type: 'object',
    properties: {
        type: {
            description: "The type of invalidation to perform.",
            type: 'string',
            enum: [ 'invalidate', 'remove' ]
        },
        key: {
            description: "A key array that identifies the cache entry to invalidate. The exact meaning of the key depends on the collection and controller, though is is usually [ \"CATEGORY\", \"ID\", \"ID\", ... ]",
            type: 'array',
            items: {
                type: 'string'
            }
        },
        exact: {
            description: "Whether to invalidate only the exact key, or all keys that start with the provided key. For example, with a key of [ \"vendors\" ], if exact is false, then all cache entries with keys that start with [ \"vendors\" ] will be invalidated, such as [ \"vendors\", \"123\" ], [ \"vendors\", \"123\", \"details\" ], etc. If exact is true, then only the cache entry with the exact key [ \"vendors\" ] will be invalidated.",
            type: 'boolean'
        }
    },
    required: [ 'type', 'key' ]
};
schemas.InvalidationArraySchema = {
    type: 'array',
    items: schemas.InvalidationSchema
};

schemas.BadParameterResponseSchema = {
    type: 'object',
    properties: {
        message: { type: 'string', example: "Bad parameter: part_number (got 'null' expected string)`)" }
    },
    required: ['message']
};
schemas.NotFoundResponseSchema = {
    type: 'object',
    properties: {
        message: { type: 'string', example: "Component not found" }
    },
    required: ['message']
};
schemas.UnauthorizedResponseSchema = {
    type: 'object',
    properties: {
        message: { type: 'string', example: "Unauthorized" }
    },
    required: ['message']
};
schemas.ForbiddenResponseSchema = {
    type: 'object',
    properties: {
        message: { type: 'string', example: "Forbidden" }
    },
    required: ['message']
};
schemas.ConflictResponseSchema = {
    type: 'object',
    properties: {
        message: { type: 'string', example: "File name 'example.txt' already exists" }
    },
    required: ['message']
};
schemas.InternalErrorResponseSchema = {
    type: 'object',
    properties: {
        message: { type: 'string', example: "Internal Server Error" }
    },
    required: ['message']
};

const responses = {};

const securitySchemes = {
    AccessToken: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT'
    },
    CookieAccessToken: {
        type: 'apiKey', // Actually it is literally the same jwt
        in: 'cookie',
        name: 'access_token',
        description: "JWT access token stored in a cookie. Note, this is literally the same as the AccessToken scheme, just sent in a cookie instead of the Authorization header."
    }
};


function build_route(controller, collection) {
    const Controller = controller.constructor;
    const Collection = collection.constructor;

    const responses = Controller.openapi_get_responses();
    if ( !responses ) return null;
    const route = {
        summary: Controller.openapi_Summary,
        description: Controller.openapi_Description,
        tags: [
            ...(Collection.openapi_Tags || []),
            ...(Controller.openapi_Tags || [])
        ],
        security: Controller.openapi_get_security(),
        parameters: Controller.openapi_get_parameters(),
        requestBody: Controller.openapi_get_request_body(),
        responses
    }

    return route;
}

module.exports = {
    schemas,
    responses,
    securitySchemes,
    build_route
};
