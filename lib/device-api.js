import api from './api.js';
import { requireConfig } from './config.js';
import { BYTES, TIMEOUTS } from './constants.js';
import { CommandStream } from './command-stream.js';
import { Readable } from 'node:stream';

// Directory endpoints on the agent expect a trailing slash so it can
// distinguish "list this directory" from "read a file with this name".
const withTrailingSlash = (p) => (p.endsWith('/') ? p : p + '/');

// The $fs/hash resource is mounted under the resource path, which is
// already an absolute URL path; the caller's relative `foo/bar` would
// otherwise produce `…/resources/$fs/hashfoo/bar`. Prepend the slash.
const withLeadingSlash = (p) => (p.startsWith('/') ? p : `/${p}`);

export function createDeviceAPI(deviceId, options = {}) {
    const config = requireConfig();
    const apiUser = options.user || config.username;
    const resourcePath = `/v3/users/${apiUser}/devices/${deviceId}/resources`;
    const filesPath = `/v3/users/${apiUser}/devices/${deviceId}/files`;

    async function callResource(resource, payload = null, opts = {}) {
        const url = `${resourcePath}/${resource}`;
        const response = await api.post(url, payload, {
            responseType: opts.responseType || 'json',
            params: opts.params || {},
            headers: opts.headers || {},
            timeout: opts.timeout || TIMEOUTS.DEVICE_RESOURCE_CALL_MS,
        });
        return response;
    }

    return {
        // GET /v3/users/{user}/devices/{device}/files/{path}/
        async listDir(dirPath, includeHidden = false) {
            const normalized = withTrailingSlash(dirPath);
            const params = {};
            if (includeHidden) params.hidden = true;
            const response = await api.get(`${filesPath}${normalized}`, { params });
            return response.data;
        },

        /**
         * Read file contents. Pass `opts.onProgress` to observe the
         * download byte-by-byte (axios ProgressEvent: `{ loaded, total,
         * progress, rate, ... }`). File transfers run with no HTTP
         * timeout by default because a large pull can easily outlast
         * the default 10s axios timeout.
         *
         * GET /v3/users/{user}/devices/{device}/files/{path}
         */
        async readFile(filePath, opts = {}) {
            const response = await api.get(`${filesPath}${filePath}`, {
                responseType: 'arraybuffer',
                timeout: opts.timeout ?? 0,
                onDownloadProgress: opts.onProgress,
            });
            return Buffer.from(response.data);
        },

        /**
         * Write file contents. Pass `opts.onProgress` to observe the
         * upload byte-by-byte (axios ProgressEvent: `{ loaded, total,
         * progress, rate, ... }`). Buffers are wrapped in a chunked
         * Readable so the progress callback fires per chunk — axios
         * otherwise flushes the whole body in one socket write and
         * progress ends up binary (0% → 100%). Timeout defaults to
         * unbounded; a 10s default kills any transfer bigger than
         * a handful of megabytes.
         *
         * PUT /v3/users/{user}/devices/{device}/files/{path}
         */
        async writeFile(filePath, content, overwrite = true, opts = {}) {
            const params = {};
            if (!overwrite) params.overwrite = false;
            const isBuffer = Buffer.isBuffer(content);
            // Streams: the caller gets granular `onUploadProgress` events
            // per socket write. Buffers: axios flushes the whole body in
            // a single write, so the callback only fires at 0% and 100%
            // — callers that care about progress should pass a stream.
            const body = isBuffer
                ? Readable.from(content, { highWaterMark: BYTES.STREAM_CHUNK })
                : content;
            const headers = { 'Content-Type': 'application/octet-stream' };
            if (isBuffer) {
                headers['Content-Length'] = String(content.byteLength);
            } else if (opts.contentLength != null) {
                headers['Content-Length'] = String(opts.contentLength);
            }
            const response = await api.put(`${filesPath}${filePath}`, body, {
                headers,
                params,
                timeout: opts.timeout ?? 0,
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
                // `follow-redirects` (axios' default HTTP client)
                // buffers the request body in memory to be able to
                // replay it on a 3xx. That defeats the upstream
                // backpressure that the CLI's progress meter relies
                // on — bytes get "sent" to RAM instantly, then the
                // real socket drain happens out-of-band. The
                // /v3/…/files/ endpoint doesn't redirect, so opting
                // out is free and restores true streaming.
                maxRedirects: 0,
                onUploadProgress: opts.onProgress,
            });
            return response.data;
        },

        // GET /v3/users/{user}/devices/{device}/files/{path}?info=true
        async info(filePath) {
            const response = await api.get(`${filesPath}${filePath}`, {
                params: { info: true },
            });
            return response.data;
        },

        /**
         * Hash the remote file with the given algorithm.
         * GET /v3/users/{user}/devices/{device}/resources/$fs/hash/{path}
         *
         * Returns `{ path, algorithm, hash, size, mtime }`. Throws axios
         * errors (404 for missing file, 400 for non-regular path, 403
         * when the path is outside the agent's allowed base).
         */
        async hashFile(filePath, algorithm = 'sha256') {
            const normalized = withLeadingSlash(filePath);
            const response = await api.get(`${resourcePath}/$fs/hash${normalized}`, {
                params: algorithm && algorithm !== 'sha256' ? { algorithm } : {},
                timeout: TIMEOUTS.DEVICE_RESOURCE_CALL_MS,
            });
            return response.data;
        },

        // DELETE /v3/users/{user}/devices/{device}/files/{path}
        async delete(filePath, recursive = true) {
            const params = {};
            if (recursive) params.recursive = true;
            const response = await api.delete(`${filesPath}${filePath}`, { params });
            return response.data;
        },

        // PATCH /v3/users/{user}/devices/{device}/files/{sourcePath}
        async move(source, destination, overwrite = false) {
            const response = await api.patch(`${filesPath}${source}`, {
                path: destination,
                overwrite,
            });
            return response.data;
        },

        // PUT /v3/users/{user}/devices/{device}/files/{path}/
        async mkdir(dirPath) {
            const normalized = withTrailingSlash(dirPath);
            const response = await api.put(`${filesPath}${normalized}`, null, {
                headers: { 'Content-Length': '0' },
            });
            return response.data;
        },

        // GET /v3/users/{user}/devices/{device}/resources/{resource}
        async getResource(resource) {
            const url = `${resourcePath}/${resource}`;
            const response = await api.get(url, { timeout: TIMEOUTS.DEVICE_RESOURCE_GET_MS });
            return response.data;
        },

        // POST /v3/users/{user}/devices/{device}/resources/{resource}
        async callResource(resource, payload = null, { timeout = TIMEOUTS.DEVICE_RESOURCE_CALL_MS } = {}) {
            const url = `${resourcePath}/${resource}`;
            const response = await api.post(url, payload, { timeout });
            return response.data;
        },

        // Legacy one-shot exec via POST /resources/cmd. Prefer execStream
        // for anything interactive or longer than a few seconds.
        async exec(cmd, timeout = TIMEOUTS.DEFAULT_EXEC_SECONDS) {
            const response = await callResource(
                'cmd',
                {
                    cmd,
                    timeout,
                    mode: 'api',
                },
                { timeout: timeout * 1000 + TIMEOUTS.EXEC_EXTRA_GRACE_MS },
            );
            return response.data;
        },

        /**
         * Execute a command on the device using the WebSocket stream. Incoming
         * frames are dispatched to onStdout/onStderr as they arrive. Resolves
         * with { exitCode, timedOut, cancelled } when the remote command
         * completes, the connection closes, the safety timer fires, or the
         * caller invokes the `cancel()` function exposed via onCancel.
         *
         * Preferred path for the CLI: the server detects WS close and stops
         * the device-side stream automatically. Framing, timeout and
         * cancellation live in `CommandStream` (lib/command-stream.js).
         */
        execStream(cmd, { timeout = 0, onStdout, onStderr, onCancel, stdin } = {}) {
            const isLocal = config.server === 'localhost' || config.server === '127.0.0.1';
            const insecure = isLocal || process.env.THINR_INSECURE === '1';
            return new CommandStream({
                server: config.server,
                token: config.token,
                apiUser,
                deviceId,
                insecure,
                cmd,
                timeout,
                onStdout,
                onStderr,
                onCancel,
                stdin,
            }).run();
        },
    };
}
