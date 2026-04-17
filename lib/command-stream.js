// @ts-check
import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { TIMEOUTS } from './constants.js';

/**
 * One-shot execution of a shell command on a device over the IOTMP
 * WebSocket stream. The class exists to keep the four concerns of
 * streaming exec — URL/auth, framing, safety timeout, cancellation —
 * in visibly separate methods instead of braided together inside one
 * big promise executor.
 *
 * Lifecycle:
 *   new CommandStream({...}).run() → Promise<{exitCode, timedOut, cancelled}>
 *
 * `run()` opens the socket, resolves when the server sends the exit
 * frame (or the socket closes, or the safety timer fires, or `cancel()`
 * is called), and tears the WS down without waiting for the server's
 * stop cascade.
 */
export class CommandStream {
    /**
     * @param {{
     *   server: string,
     *   token: string,
     *   apiUser: string,
     *   deviceId: string,
     *   insecure: boolean,
     *   cmd: string,
     *   timeout?: number,
     *   onStdout?: (s: string) => void,
     *   onStderr?: (s: string) => void,
     *   onCancel?: (cancel: () => void) => void,
     *   stdin?: NodeJS.ReadableStream,
     * }} opts
     */
    constructor(opts) {
        this.opts = opts;
        this.sessionId = randomUUID();
        this.resource = `$cmd/${this.sessionId}`;

        this.exitCode = null;
        this.timedOut = false;
        this.cancelled = false;

        /** @type {WebSocket | null} */
        this.ws = null;
        this.resolved = false;
        /** @type {NodeJS.Timeout | null} */
        this.safetyTimer = null;
        /** @type {((value: {exitCode: number | null, timedOut: boolean, cancelled: boolean}) => void) | null} */
        this._resolve = null;
        /** @type {((reason?: any) => void) | null} */
        this._reject = null;
    }

    run() {
        this.opts.onCancel?.(() => this.cancel());
        return new Promise((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
            this.ws = this._openSocket();
            this._armSafety();
            this._wireEvents(this.ws);
        });
    }

    cancel() {
        this.cancelled = true;
        if (
            this.ws &&
            (this.ws.readyState === WebSocket.OPEN ||
                this.ws.readyState === WebSocket.CONNECTING)
        ) {
            this.ws.close();
        }
    }

    _buildUrl() {
        const { server, apiUser, deviceId, cmd, timeout } = this.opts;
        const params = new URLSearchParams({ cmd });
        if (timeout && timeout > 0) params.set('timeout', String(timeout));
        return `wss://${server}/v3/users/${apiUser}/devices/${deviceId}/resources/${this.resource}?${params}`;
    }

    _openSocket() {
        return new WebSocket(this._buildUrl(), {
            headers: { Authorization: `Bearer ${this.opts.token}` },
            rejectUnauthorized: !this.opts.insecure,
        });
    }

    /**
     * Client-side safety timeout. The `timeout` URL param asks the
     * server/agent to bound the command, but if the agent is hung the
     * server's own timeout can take longer than expected (or not fire
     * for some states) and the WS would otherwise stay open until
     * ping/pong death. Grace period lives in constants.js.
     */
    _armSafety() {
        const { timeout } = this.opts;
        if (!timeout || timeout <= 0) return;
        this.safetyTimer = setTimeout(() => {
            if (this.resolved) return;
            this.timedOut = true;
            this._finish();
        }, timeout * 1000 + TIMEOUTS.EXEC_SAFETY_GRACE_MS);
    }

    _disarmSafety() {
        if (this.safetyTimer) {
            clearTimeout(this.safetyTimer);
            this.safetyTimer = null;
        }
    }

    _wireEvents(ws) {
        ws.on('open', () => this._forwardStdin(ws));
        ws.on('error', (err) => {
            if (this.cancelled || this.resolved) return;
            this._disarmSafety();
            this._reject?.(err);
        });
        ws.on('message', (raw) => this._handleMessage(raw));
        ws.on('close', () => this._finish());
    }

    /**
     * If the caller supplied a stdin stream, forward each chunk to the
     * device as a stream frame. Payload is sent as a UTF-8 string
     * under the standard {resource, payload} envelope that the
     * server's stream handler expects.
     */
    _forwardStdin(ws) {
        const { stdin } = this.opts;
        if (!stdin || typeof stdin.on !== 'function') return;
        stdin.on('data', (chunk) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
            ws.send(JSON.stringify({ resource: this.resource, payload: text }));
        });
    }

    _handleMessage(raw) {
        let evt;
        try {
            evt = JSON.parse(raw.toString('utf8'));
        } catch {
            return;
        }
        if (evt.signal && evt.signal !== 'data') return;
        const p = evt.payload;
        if (!p || typeof p !== 'object') return;
        if (p.out !== undefined) {
            this.opts.onStdout?.(decodeBytes(p.out));
        } else if (p.err !== undefined) {
            this.opts.onStderr?.(decodeBytes(p.err));
        } else if (typeof p.exit === 'number') {
            this.exitCode = p.exit;
            if (p.timeout === true) this.timedOut = true;
            // We have the full result — resolve immediately and tear
            // down the WS without waiting for the server's stop
            // cascade, which can add several seconds.
            this._finish();
        }
    }

    _finish() {
        if (this.resolved) return;
        this.resolved = true;
        this._disarmSafety();
        this._resolve?.({
            exitCode: this.exitCode,
            timedOut: this.timedOut,
            cancelled: this.cancelled,
        });
        if (
            this.ws &&
            (this.ws.readyState === WebSocket.OPEN ||
                this.ws.readyState === WebSocket.CONNECTING)
        ) {
            this.ws.terminate();
        }
    }
}

/**
 * Decode a frame field that the server may deliver either as a plain
 * string or as the `{bytes: [...]}` envelope used for binary-safe
 * payloads. Non-strings fall back to empty so downstream handlers
 * don't have to guard.
 */
function decodeBytes(field) {
    if (typeof field === 'string') return field;
    if (field && Array.isArray(field.bytes)) {
        return Buffer.from(field.bytes).toString('utf8');
    }
    return '';
}
