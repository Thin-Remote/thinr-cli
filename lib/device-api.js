import api from './api.js';
import { requireConfig } from './config.js';
import WebSocket from 'ws';
import { randomUUID } from 'crypto';

/**
 * Create a device API client for filesystem and command operations
 * @param {string} deviceId - The device ID
 * @param {Object} [options] - Options
 * @param {string} [options.user] - Override API user (admin impersonation)
 * @returns {Object} API client with fs and exec methods
 */
export function createDeviceAPI(deviceId, options = {}) {
    const config = requireConfig();
    const apiUser = options.user || config.username;
    const resourcePath = `/v3/users/${apiUser}/devices/${deviceId}/resources`;
    const filesPath = `/v3/users/${apiUser}/devices/${deviceId}/files`;

    /**
     * Call a device resource (for cmd, etc.)
     */
    async function callResource(resource, payload = null, opts = {}) {
        const url = `${resourcePath}/${resource}`;
        const response = await api.post(url, payload, {
            responseType: opts.responseType || 'json',
            params: opts.params || {},
            headers: opts.headers || {},
            timeout: opts.timeout || 30000,
        });
        return response;
    }

    return {
        /**
         * List directory contents
         * GET /v3/users/{user}/devices/{device}/files/{path}/
         */
        async listDir(dirPath, includeHidden = false) {
            const normalized = dirPath.endsWith('/') ? dirPath : dirPath + '/';
            const params = {};
            if (includeHidden) params.hidden = true;
            const response = await api.get(`${filesPath}${normalized}`, { params });
            return response.data;
        },

        /**
         * Read file contents
         * GET /v3/users/{user}/devices/{device}/files/{path}
         */
        async readFile(filePath) {
            const response = await api.get(`${filesPath}${filePath}`, {
                responseType: 'arraybuffer',
            });
            return Buffer.from(response.data);
        },

        /**
         * Write file contents
         * PUT /v3/users/{user}/devices/{device}/files/{path}
         */
        async writeFile(filePath, content, overwrite = true) {
            const params = {};
            if (!overwrite) params.overwrite = false;
            const response = await api.put(`${filesPath}${filePath}`, content, {
                headers: { 'Content-Type': 'application/octet-stream' },
                params,
            });
            return response.data;
        },

        /**
         * Get file/directory info
         * GET /v3/users/{user}/devices/{device}/files/{path}?info=true
         */
        async info(filePath) {
            const response = await api.get(`${filesPath}${filePath}`, {
                params: { info: true },
            });
            return response.data;
        },

        /**
         * Delete file or directory
         * DELETE /v3/users/{user}/devices/{device}/files/{path}
         */
        async delete(filePath, recursive = true) {
            const params = {};
            if (recursive) params.recursive = true;
            const response = await api.delete(`${filesPath}${filePath}`, { params });
            return response.data;
        },

        /**
         * Move/rename file or directory
         * PATCH /v3/users/{user}/devices/{device}/files/{sourcePath}
         */
        async move(source, destination, overwrite = false) {
            const response = await api.patch(`${filesPath}${source}`, {
                path: destination,
                overwrite,
            });
            return response.data;
        },

        /**
         * Create directory
         * PUT /v3/users/{user}/devices/{device}/files/{path}/
         */
        async mkdir(dirPath) {
            const normalized = dirPath.endsWith('/') ? dirPath : dirPath + '/';
            const response = await api.put(`${filesPath}${normalized}`, null, {
                headers: { 'Content-Length': '0' },
            });
            return response.data;
        },

        /**
         * Read a device resource property (GET)
         * GET /v3/users/{user}/devices/{device}/resources/{resource}
         */
        async getResource(resource) {
            const url = `${resourcePath}/${resource}`;
            const response = await api.get(url, { timeout: 15000 });
            return response.data;
        },

        /**
         * Call a device resource action (POST)
         * POST /v3/users/{user}/devices/{device}/resources/{resource}
         */
        async callResource(resource, payload = null, { timeout = 30000 } = {}) {
            const url = `${resourcePath}/${resource}`;
            const response = await api.post(url, payload, { timeout });
            return response.data;
        },

        /**
         * Execute a command on the device
         * POST /v3/users/{user}/devices/{device}/resources/cmd
         */
        async exec(cmd, timeout = 30) {
            const response = await callResource(
                'cmd',
                {
                    cmd,
                    timeout,
                    mode: 'api',
                },
                { timeout: (timeout + 5) * 1000 },
            );
            return response.data;
        },

        /**
         * Execute a command on the device using the WebSocket stream. Incoming
         * frames are dispatched to onStdout/onStderr as they arrive. Resolves
         * with { exitCode, timedOut } when the remote command completes or the
         * connection closes. Returns a `cancel()` function via the optional
         * onCancel hook so callers (e.g. SIGINT handlers) can tear it down.
         *
         * Preferred path for the CLI: the server detects WS close and stops
         * the device-side stream automatically.
         */
        execStream(cmd, { timeout = 0, onStdout, onStderr, onCancel, stdin } = {}) {
            const sessionId = randomUUID();
            const resource = `$cmd/${sessionId}`;
            const params = new URLSearchParams({ cmd });
            if (timeout > 0) params.set('timeout', String(timeout));
            const isLocal = config.server === 'localhost' || config.server === '127.0.0.1';
            const insecure = isLocal || process.env.THINR_INSECURE === '1';
            const wsUrl = `wss://${config.server}/v3/users/${apiUser}/devices/${deviceId}/resources/${resource}?${params}`;
            const ws = new WebSocket(wsUrl, {
                headers: { Authorization: `Bearer ${config.token}` },
                rejectUnauthorized: !insecure,
            });

            let exitCode = null;
            let timedOut = false;
            let cancelled = false;

            const cancel = () => {
                cancelled = true;
                if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                    ws.close();
                }
            };
            onCancel?.(cancel);

            const decodeBytes = (field) => {
                if (typeof field === 'string') return field;
                if (field && Array.isArray(field.bytes)) {
                    return Buffer.from(field.bytes).toString('utf8');
                }
                return '';
            };

            return new Promise((resolve, reject) => {
                let resolved = false;
                /** @type {NodeJS.Timeout | null} */
                let safetyTimer = null;

                const clearSafety = () => {
                    if (safetyTimer) {
                        clearTimeout(safetyTimer);
                        safetyTimer = null;
                    }
                };

                const done = () => {
                    if (resolved) return;
                    resolved = true;
                    clearSafety();
                    resolve({ exitCode, timedOut, cancelled });
                    // Tear down the socket without blocking on the server's
                    // close handshake.
                    if (
                        ws.readyState === WebSocket.OPEN ||
                        ws.readyState === WebSocket.CONNECTING
                    ) {
                        ws.terminate();
                    }
                };

                // Client-side safety timeout. The `timeout` URL param asks
                // the server/agent to bound the command, but if the agent
                // is hung the server's own timeout can take longer than
                // expected (or not fire for some states), and the WS would
                // otherwise stay open until ping/pong death.
                //
                // Grace = 2s: enough for a round-trip so the server's
                // normal path can still deliver its `{ exit, timeout: true }`
                // frame when it can, without being proportional to the
                // declared timeout (a 5-min command shouldn't wait 5 extra
                // minutes just in case).
                const GRACE_MS = 2000;
                if (timeout > 0) {
                    safetyTimer = setTimeout(() => {
                        if (resolved) return;
                        timedOut = true;
                        done();
                    }, timeout * 1000 + GRACE_MS);
                }

                ws.on('open', () => {
                    // If the caller supplied a stdin stream, forward each
                    // chunk to the device as a stream frame. Payload is sent
                    // as a UTF-8 string under the standard {resource, payload}
                    // envelope that the server's stream handler expects.
                    if (stdin && typeof stdin.on === 'function') {
                        stdin.on('data', (chunk) => {
                            if (ws.readyState !== WebSocket.OPEN) return;
                            const text = Buffer.isBuffer(chunk)
                                ? chunk.toString('utf8')
                                : String(chunk);
                            ws.send(JSON.stringify({ resource, payload: text }));
                        });
                    }
                });
                ws.on('error', (err) => {
                    if (cancelled || resolved) return;
                    clearSafety();
                    reject(err);
                });
                ws.on('message', (raw) => {
                    let evt;
                    try {
                        evt = JSON.parse(raw.toString('utf8'));
                    } catch {
                        return;
                    }
                    if (evt.signal && evt.signal !== 'data') return;
                    const p = evt.payload;
                    if (!p || typeof p !== 'object') return;
                    if (p.out !== undefined) onStdout?.(decodeBytes(p.out));
                    else if (p.err !== undefined) onStderr?.(decodeBytes(p.err));
                    else if (typeof p.exit === 'number') {
                        exitCode = p.exit;
                        if (p.timeout === true) timedOut = true;
                        // We have the full result — resolve immediately and
                        // tear down the WS without waiting for the server's
                        // stop cascade, which can add several seconds.
                        done();
                    }
                });
                ws.on('close', () => done());
            });
        },
    };
}
