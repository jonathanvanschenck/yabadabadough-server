
const { createServer: createHTTPServer } = require("http");
const { Server: SocketIOServer } = require("socket.io");
const { Writable: WritableStream } = require("stream");
const { join } = require("path");

const express = require("express");
const morgan = require('morgan');
const { Logger } = require("yalls");
const cookie_parser = require("cookie-parser");
const SwaggerUI = require('swagger-ui-express');


const { schemas, responses, securitySchemes, build_route } = require("./openapi.js");

const {
    CookieMiddleware,
    JWTMiddleware,
    FlyTrap,
    Access
} = require('../collections/lib/asseverate.js');
const { QK, invalidate } = require('../collections/lib/query_keys.mjs');
const COLLECTIONS = require('../collections');

module.exports = class Webserver {
    constructor(config, { log, db, token_manager }) {
        this.config = config;

        this.log = log?.create_child("WS") ?? Logger.noop();
        this.db = db;
        this.token_manager = token_manager;
        this.invalidator_log = this.log.create_child("invalidator");

        this.app = new express();

        this.app.use(express.json({
            type: ["application/json"]
        }));
        this.app.use(cookie_parser());

        // Attach middleware
        this.log.info("Attaching Authentication middleware to app");
        JWTMiddleware.for_app(
            this.app,
            Object.assign({
                log: this.log,
                token_manager: this.token_manager
            }, this.config.api)
        );
        CookieMiddleware.for_app(
            this.app,
            Object.assign({
                log: this.log,
                token_manager: this.token_manager
            }, this.config.api)
        );

        // Add morgan AFTER middleware, to get extras tacked onto req
        morgan.token('id', (req) => {
            return req.access?.identifier ?? "Unknown";
        });
        const _log = this.log.create_child("http");
        const info_log_stream = new WritableStream({
            write(chunk, encoding, done) {
                _log.info(chunk.toString().replace(/^[\r\n]+|[\r\n]+$/g, ""));
                done();
            }
        });
        this.app.use(morgan(
            ':remote-addr - :id - ":method :url HTTP/:http-version" :status :res[content-length] - :response-time ms',
            { "stream": info_log_stream }

        ));

        this.log.info("Attaching Collections to app");
        const collections = [];
        for ( const Collection of COLLECTIONS ) {
            const collection = Collection.for_app(this.app, Object.assign({
                log: this.log,
                db: this.db,
                token_manager: this.token_manager,
                invalidator: {
                    broadcast: (source, meta, actions) =>
                        this.broadcast_invalidation_array(source, meta, actions)
                }
            }, this.config.api));

            this.log.info(` └─── ${Collection.name} under ${collection.prefix}`);
            for ( const middleware of collection.middlewares ) this.log.info(`   └─── Middlware: ${middleware.path}`);
            for ( const controller of collection.controllers ) this.log.info(`   └─── ${controller.method.padEnd(7, "·")}${controller.path}`);

            collections.push(collection);
        }

        if ( this.config.api.swagger.use ) {
            // TODO
            const swagger = {
                openapi: "3.0.0",
                info: {
                    title: "Yabadabadough API",
                    version: this.config.api.version,
                    description: "API documentation for Yabadabadough. Download the OpenAPI spec [here](/api-docs.json).\nNote, if you are logged into the webapp in this browser, you can piggyback on those cookies and get auth over here for free!"
                },
                paths: {},
                components: {
                    schemas: schemas,
                    responses: responses,
                    securitySchemes: securitySchemes
                }
            };

            for ( const collection of collections ) {
                for ( const controller of collection.controllers ) {
                    const route = build_route(controller, collection);
                    if ( !route ) continue; // skip if no OpenAPI info

                    const cleaned_path = controller.path.replace(/:([^\/]+)/g, (match) => {
                        return `{${match.slice(1)}}`;
                    });
                    if ( !swagger.paths[cleaned_path] ) swagger.paths[cleaned_path] = {};
                    // console.log(build_route(controller, collection));
                    swagger.paths[cleaned_path][controller.method.toLowerCase()] = route;
                }
            }


            this.app.use('/api-docs', SwaggerUI.serve, SwaggerUI.setup(swagger));
            this.log.info("Swagger UI available at /api-docs");

            this.app.use('/api-docs.json', (req, res) => res.json(swagger));
            this.log.info("Swagger JSON available at /api-docs.json");

        }

        // Add a fly trap
        FlyTrap.for_app(this.app, this.config.api);

        // Expose the built files
        this.app.use(express.static(join(__dirname, "../webapp/dist")));

        // Enable client-side routing
        const path = join(__dirname, "../webapp/dist/index.html");
        this.app.use((req, res) => res.sendFile(path));


        this.stopping = false;
        this.socks = new Set();
        const { local, proxy } = this.config.webservice;
        this.server = createHTTPServer()
            .on('connection', (socket) => {
                if ( this.stopping ) return socket.destroy();
                this.socks.add(socket);
                socket.once('close', () => {
                    this.socks.delete(socket);
                });
            })
            .on("request", this.app)
            .on("listening", () => {
                this.log.info(`Webservice listening on ${local.protocol}://${local.address}:${local.port}`);
                this.log.info(`Webservice listening on ${proxy.protocol}://${proxy.address}:${proxy.port}`);
            });


        const iolog = this.log.create_child("sio");
        this.io = new SocketIOServer(this.server, {
            serveClient: false // the webapp bundles its own socket.io-client
        });
        this.io.log = iolog;

        this.io.on("connection", (socket) => {
            this.io.log.debug(`New socket.io connection: ${socket.id}`);

            // Check auth: the handshake `auth.token` field (non-browser
            // clients, tests) first, then the access_token cookie (the
            // webapp) -- same precedence as the HTTP middlewares (Bearer,
            // then cookie)
            const token = socket.handshake.auth?.token
                ?? (socket.handshake.headers?.cookie || "").match(/access_token=([^;]+)/)?.[1];

            // No sudo masking here (req: null): sockets never take admin actions
            const access = Access.from_access_token(this.token_manager, token, null);
            if ( !access.authed && !this.config.api.disable_auth ) {
                this.io.log.debug(`New socket.io ${socket.id} failed handshake`);
                // Slow-fail like the credential-failure penalize() on the HTTP side
                return setTimeout(() => socket.disconnect(true), this.config.api.penalty_ms ?? 1000);
            }

            socket.data.access = access;
            const identifier = () => socket.data.access.identifier ?? "Unknown";

            this.io.log.info(`Socket.io connected: ${socket.id} (User: ${identifier()})`);

            // Invalidate the version query on (re)connect so clients detect a new deployment
            this.send_invalidation_array(
                socket,
                "SocketConnection",
                {},
                [ invalidate(QK.versions) ]
            );

            socket.on("disconnect", (reason) => {
                this.io.log.info(`Socket.io disconnected: ${identifier()} (${reason})`);
            });

            socket.on("page_view", ({ url }={}) => {
                this.io.log.info(`${socket.id} - ${identifier()} - "NAV ${url}"`);
            });

            // FIXME : eventually, we should remove this, so that clients cannot trigger invalidations
            socket.on("clean_queries", (source, meta, actions) => {
                this.io.log.debug(`${socket.id} - ${identifier()} - "CLEAN QUERIES from ${source}" ${JSON.stringify(meta)}`);
                // Relay to every OTHER client, already tanstack-shaped
                socket.broadcast.emit("clean_queries", source, meta, actions);
            });
        });
    }


    async start() {
        this.log.info(`Starting`);
        const { local } = this.config.webservice;
        return new Promise((res) => this.server.listen({ port: local.port, host: local.address }, res));
    }

    async stop() {
        this.log.info(`Stopping`);
        this.stopping = true;
        // io.close() disconnects every socket.io client, then closes the
        // underlying http server (this.server) -- the callback fires once
        // the server is fully closed
        return new Promise((res) => this.io.close(() => {
            this.log.debug(`Calling "destroy" on all sockets`);
            for ( const sock of this.socks ) sock.destroy();
            res();
        }));
    }


    /**
     * Translate our `{ type: "invalidate"|"remove", key }` actions (from
     * collections/lib/query_keys.js) into the tanstack-query method calls the
     * webapp applies to its cache, in the `clean_queries` wire shape:
     * [ source, meta, [{ method, args }] ].
     */
    generate_tanstack_invalidation(source, meta, actions) {
        return [
            source,
            meta,
            actions.map(({ type, key, exact }) => {
                switch (type) {
                    case "invalidate":
                        return { method: "invalidateQueries", args: [{ queryKey: key, exact }] };
                    case "remove":
                        return { method: "removeQueries", args: [{ queryKey: key, exact }] };
                    default:
                        throw new Error(`Unknown invalidation type: ${type}`);
                }
            })
        ];
    }

    broadcast_invalidation_array(source, meta, actions) {
        this.invalidator_log.debug(`Broadcasting invalidation from ${source}: ${JSON.stringify(meta)}`);
        try {
            this.io.emit("clean_queries", ...this.generate_tanstack_invalidation(source, meta, actions));
        } catch (err) {
            this.invalidator_log.error(`Error broadcasting invalidation: ${err.message}`);
        }
    }

    send_invalidation_array(socket, source, meta, actions) {
        this.invalidator_log.debug(`Sending invalidation to ${socket.id} from ${source}: ${JSON.stringify(meta)}`);
        try {
            socket.emit("clean_queries", ...this.generate_tanstack_invalidation(source, meta, actions));
        } catch (err) {
            this.invalidator_log.error(`Error sending invalidation to ${socket.id}: ${err.message}`);
        }
    }
}
