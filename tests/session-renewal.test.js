// What thinr does when the session expires outside the HTTP requests the
// core renews by itself: the dashboard's event stream, and file uploads
// whose body is a stream that cannot be sent twice.
import './setup.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import {
    deleteConfig,
    getProfile,
    setActiveProfile,
    writeConfig,
} from '@thinger-io/cli-core/config';
import { createDeviceAPI } from '../lib/device-api.js';
import { eventStream } from '../lib/dashboard/event-stream.js';

/** An unsigned JWT of ana that expires in `seconds`. */
function jwt(seconds) {
    const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${part({ alg: 'HS256' })}.${part({ usr: 'ana', exp: Math.floor(Date.now() / 1000) + seconds, n: Math.random() })}.sig`;
}

let server;
const sockets = new Set();
let baseURL;
/** What the server does, and saw. */
let srv;

before(async () => {
    server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            srv.requests.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
            if (req.url === '/oauth/token') {
                const ok = srv.renew && body.includes('refresh_token=R-valid');
                res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
                return res.end(
                    JSON.stringify(
                        ok
                            ? { access_token: srv.fresh, refresh_token: 'R-next' }
                            : { error: { message: 'invalid refresh token' } },
                    ),
                );
            }
            const ok = req.headers.authorization === `Bearer ${srv.fresh}`;
            res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(ok ? { ok: true } : { error: { message: 'expired' } }));
        });
    });
    // The event stream: a handshake with the session the server issued last
    // is taken, any other refused as expired.
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
        srv.handshakes++;
        const token = new URL(req.url ?? '', 'http://x').searchParams.get('authorization');
        if (token !== srv.fresh) {
            // Answered and kept open, as a server with keep-alive does: the
            // client must end it.
            socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
            sockets.add(socket);
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            srv.opened++;
            ws.on('message', () => {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
    baseURL = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.close();
});

beforeEach(() => {
    srv = { requests: [], handshakes: 0, opened: 0, renew: true, fresh: jwt(7200) };
    deleteConfig();
    setActiveProfile('p');
    writeConfig({
        server: baseURL,
        username: 'ana',
        token: jwt(-60),
        refresh_token: 'R-valid',
        oauth_client_id: 'cli',
    });
});

describe('the event stream', () => {
    it('stops when the session cannot be renewed, and says so', { timeout: 10_000 }, async () => {
        srv.renew = false;
        const stopped = new Promise((resolve) => eventStream.on('stream_stopped', resolve));
        eventStream.connect();
        const frame = await stopped;
        assert.match(frame.message, /expired|sign in/i);
        // No more handshakes with the refused session.
        const seen = srv.handshakes;
        await new Promise((r) => setTimeout(r, 2500));
        assert.equal(srv.handshakes, seen);
        assert.equal(eventStream.reconnectTimer, null);
        eventStream.disconnect();
    });

    it(
        'opens again with the session renewed after a refused handshake',
        { timeout: 10_000 },
        async () => {
            eventStream.connect();
            for (let i = 0; i < 100 && !srv.opened; i++)
                await new Promise((r) => setTimeout(r, 50));
            assert.equal(srv.opened, 1, `handshakes: ${srv.handshakes}`);
            assert.equal(getProfile('p').refresh_token, 'R-next');
            eventStream.disconnect();
        },
    );
});

describe('a file upload', () => {
    it('renews a session about to expire before sending, not after a 401', async () => {
        const api = createDeviceAPI('d1');
        await api.writeFile('/tmp/x', Buffer.from('hello'));
        const puts = srv.requests.filter((r) => r.startsWith('PUT'));
        assert.deepEqual(puts, [`PUT /v3/users/ana/devices/d1/files/tmp/x Bearer ${srv.fresh}`]);
        assert.equal(getProfile('p').refresh_token, 'R-next');
    });
});
