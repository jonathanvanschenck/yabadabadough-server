
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
const COLLECTIONS = require('../collections');

module.exports = class Webserver {
    constructor(config, { log, db, token_manager }) {
        this.config = config;

        this.log = log?.create_child("WS") ?? Logger.noop();
        this.db = db;
        this.token_manager = token_manager;

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
                    // TODO : broadcast_invalidation_array is commented out
                    //        until socket.io lands -- noop for now
                    broadcast: () => {}
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
                    title: "Yabadabadoh API",
                    version: this.config.api.version,
                    description: "API documentation for Yabadabadoh. Download the OpenAPI spec [here](/api-docs.json).\nNote, if you are logged into the webapp in this browser, you can piggyback on those cookies and get auth over here for free!"
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
        // TODO : add a webapp
        // this.app.use(express.static(join(__dirname, "../webapp/dist")));

        // Enable client-side routing
        // TODO : add a webapp
        // const path = join(__dirname, "../webapp/dist/index.html");
        // this.app.use((req, res) => res.sendFile(path));


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


        // TODO : add socket.io
        /*
        const iolog = this.log.create_child("sio");
        this.io = new SocketIOServer(this.server, {
            // TODO
        });
        this.io.log = iolog;

        this.io.on("connection", async (socket) => {
            this.io.log.debug(`New socket.io connection: ${socket.id}`);

            // Check auth
            const match = (socket.handshake.headers?.cookie||"").match(/access_token=([^;]+)/);
            if ( !match ) {
                this.io.log.debug(`New socket.io ${socket.id} failed handshake (1)`);
                return setTimeout(() => socket.disconnect(true), 1000);
            }

            // No sudo masking here (req: null): sockets never take admin actions
            const access = Access.from_access_token(this.token_manager, match[1], null);
            if ( !access.authed ) {
                this.io.log.debug(`New socket.io ${socket.id} failed handshake (2)`);
                return setTimeout(() => socket.disconnect(true), 1000);
            }

            socket.data.access = access;

            this.io.log.info(`Socket.io connected: ${socket.id} (User: ${socket.data.access.identifier})`);

            // Invalidate the version query on (re)connect so clients detect a new deployment
            this.send_invalidation_array(
                socket,
                "SocketConnection",
                {},
                [{ type: "invalidate", key: ['versions'] }]
            )

            // TODO : finish configuring
            socket.on("disconnect", (reason) => {
                this.io.log.info(`Socket.io disconnected: ${socket.data.access.identifier} (${reason})`);
            });

            socket.on("page_view", ({ url, pathname, search, hash }) => {
                this.io.log.info(`${socket.id} - ${socket.data.access.identifier} - "NAV ${url}"`);
            })

            // FIXME : eventually, we should remove this, so that clients cannot trigger invalidations
            socket.on("clean_queries", (source, meta, actions) => {
                this.io.log.debug(`${socket.id} - ${socket.data.access.identifier} - "CLEAN QUERIES from ${source}" ${JSON.stringify(meta)}`);
                socket.broadcast.emit("clean_queries", source, meta, actions);
                // socket.emit("clean_queries", source, meta, actions);
            });

            // socket.onAny((event, ...args) => {
            //     iolog.debug(`Socket.io event from ${socket.data.access.identifier}: ${event}`, args);
            // });
        });
        */
    }


    async start() {
        this.log.info(`Starting`);
        const { local } = this.config.webservice;
        return new Promise((res) => this.server.listen({ port: local.port, host: local.address }, res));
    }

    async stop() {
        this.log.info(`Stopping`);
        this.stopping = true;
        // TODO :
        // this.io.close();
        return new Promise((res) => this.server.close(() => {
            this.log.debug(`Calling "destroy" on all sockets`);
            for ( const sock of this.socks ) sock.destroy();
            res();
        }));
    }


    // TODO 
    /*
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
    */
}
