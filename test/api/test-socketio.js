const { expect } = require("chai");
const { io: sio_connect } = require("socket.io-client");

const { start_harness } = require("./harness.js");

describe("API: socket.io invalidation transport", function() {

    let h;
    let sockets;
    beforeEach(async () => {
        h = await start_harness();
        sockets = [];
    });
    afterEach(async () => {
        for ( const socket of sockets ) socket.disconnect();
        await h.stop();
    });

    function connect(opts={}) {
        const socket = sio_connect(h.base, {
            transports: [ "websocket" ],
            reconnection: false,
            ...opts,
        });
        sockets.push(socket);
        return socket;
    }

    function once(socket, event, { timeout_ms=1500 }={}) {
        return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error(`Timed out waiting for '${event}'`)), timeout_ms);
            socket.once(event, (...args) => {
                clearTimeout(timer);
                res(args);
            });
        });
    }

    // Connect with a token and consume the connect-time versions
    // invalidation, so tests can assert on SUBSEQUENT clean_queries events
    async function connect_authed(token, opts={}) {
        const socket = connect({ auth: { token }, ...opts });
        const [ source, meta, actions ] = await once(socket, "clean_queries");
        expect(source).to.equal("SocketConnection");
        expect(meta).to.deep.equal({});
        expect(actions).to.deep.equal([
            { method: "invalidateQueries", args: [ { queryKey: [ "versions" ] } ] }
        ]);
        return socket;
    }

    describe("handshake", () => {

        it("accepts a handshake auth token and sends the versions invalidation", async () => {
            await connect_authed(h.tokens.reader);
        });

        it("accepts the access_token cookie", async () => {
            const socket = connect({ extraHeaders: { cookie: `access_token=${h.tokens.reader}` } });
            const [ source ] = await once(socket, "clean_queries");
            expect(source).to.equal("SocketConnection");
        });

        it("disconnects a socket with no credentials", async () => {
            const socket = connect();
            let cleaned = false;
            socket.on("clean_queries", () => { cleaned = true; });
            const [ reason ] = await once(socket, "disconnect");
            expect(reason).to.equal("io server disconnect");
            expect(cleaned).to.equal(false);
        });

        it("disconnects a socket with a garbage token", async () => {
            const socket = connect({ auth: { token: "not-a-jwt" } });
            const [ reason ] = await once(socket, "disconnect");
            expect(reason).to.equal("io server disconnect");
        });

    });

    describe("write broadcasts", () => {

        it("broadcasts tanstack-shaped invalidations for an HTTP write", async () => {
            const socket = await connect_authed(h.tokens.reader);

            const wait = once(socket, "clean_queries");
            const { status } = await h.request("/api/funds/funds", {
                method: "POST",
                token: h.tokens.editor,
                body: { name: "Broadcast me", tracked: false },
            });
            expect(status).to.equal(200);

            const [ source, meta, actions ] = await wait;
            expect(source).to.equal("PostFunds");
            expect(meta).to.deep.equal({});
            expect(actions).to.deep.equal([
                { method: "invalidateQueries", args: [ { queryKey: [ "funds" ] } ] },
                { method: "invalidateQueries", args: [ { queryKey: [ "fund-finalizations" ] } ] },
            ]);
        });

        it("maps remove actions to removeQueries", async () => {
            const { body: created } = await h.request("/api/funds/funds", {
                method: "POST",
                token: h.tokens.editor,
                body: { name: "Doomed", tracked: false },
            });
            const fund_id = created.data.id;

            const socket = await connect_authed(h.tokens.reader);

            const wait = once(socket, "clean_queries");
            const { status } = await h.request(`/api/funds/fund/${fund_id}`, {
                method: "DELETE",
                token: h.tokens.editor,
            });
            expect(status).to.equal(200);

            const [ source, , actions ] = await wait;
            expect(source).to.equal("DeleteFund");
            expect(actions).to.deep.include(
                { method: "removeQueries", args: [ { queryKey: [ "fund", fund_id.toString() ] } ] }
            );
        });

        it("reaches every connected client", async () => {
            const a = await connect_authed(h.tokens.reader);
            const b = await connect_authed(h.tokens.editor);

            const waits = [ once(a, "clean_queries"), once(b, "clean_queries") ];
            await h.request("/api/funds/funds", {
                method: "POST",
                token: h.tokens.editor,
                body: { name: "Fanout", tracked: false },
            });

            for ( const wait of waits ) {
                const [ source ] = await wait;
                expect(source).to.equal("PostFunds");
            }
        });

    });

    describe("clean_queries relay", () => {

        it("relays a client's clean_queries to every OTHER client", async () => {
            const a = await connect_authed(h.tokens.reader);
            const b = await connect_authed(h.tokens.editor);

            const echoes = [];
            a.on("clean_queries", (...args) => echoes.push(args));

            const sent = [ "webapp", { reason: "test" }, [ { method: "invalidateQueries", args: [ { queryKey: [ "funds" ] } ] } ] ];
            const wait = once(b, "clean_queries");
            a.emit("clean_queries", ...sent);

            const received = await wait;
            expect(received).to.deep.equal(sent);

            // The sender must NOT hear its own relay back
            await new Promise((res) => setTimeout(res, 50));
            expect(echoes).to.deep.equal([]);
        });

    });

});
