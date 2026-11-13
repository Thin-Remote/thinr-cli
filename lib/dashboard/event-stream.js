// @ts-check
import WebSocket from 'ws';
import { readConfig, serverWebSocketURL } from '@thinger-io/cli-core/config';
import { refreshToken } from '@thinger-io/cli-core/auth';
import { debugCount, debugLog } from '../debug-log.js';
import { v2 } from '@thinger-io/cli-core/paths';

// Single shared websocket to /v2/users/{user}/events. Both fleet
// monitoring and product metrics live on the same endpoint with the
// same auth, so opening two sockets per dashboard session is just
// extra load on both ends.
//
// Use:
//   const off = eventStream.on('bucket_write', (frame) => {...});
//   eventStream.subscribe({ event: 'bucket_write', filters: { bucket } });
//   eventStream.connect();      // ref-counted; first call opens
//   ...
//   off();                      // stop receiving frames
//   eventStream.disconnect();   // ref-counted; last call closes
//
// `subscribe` is additive and idempotent — the server has no
// unsubscribe verb in this protocol, so we can't take a filter back.
// What we *can* do is dedupe locally so the same filter isn't sent
// twice per session, and replay every active subscription whenever
// the socket reconnects.

const MAX_BACKOFF_MS = 30_000;

class EventStream {
    constructor() {
        /** @type {WebSocket | null} */
        this.ws = null;
        this.refCount = 0;
        /** @type {Map<string, Set<(frame: any) => void>>} */
        this.handlers = new Map();
        /** @type {Map<string, any>} */
        this.subs = new Map();
        this.reconnectAttempts = 0;
        /** @type {NodeJS.Timeout | null} */
        this.reconnectTimer = null;
        this.disposed = true;
        // Used by `onReconnect` to skip the very first open — that one is the
        // initial connection, not a reconnect, and consumers already seed
        // their state via the REST snapshot at mount time.
        this.hasOpenedOnce = false;
        /** @type {Set<() => void>} */
        this.reconnectHandlers = new Set();
        // Why the stream gave up for good (the session is over, or the
        // account may not read its events): no reconnect fixes that.
        /** @type {string | null} */
        this.stopped = null;
    }

    /**
     * Stop reconnecting, and tell the `stream_stopped` handlers why: a
     * stream whose session cannot be renewed would otherwise retry with
     * the same refused token every half minute for as long as it runs.
     */
    _stop(reason) {
        if (this.stopped) return;
        this.stopped = reason;
        debugLog('ws:events', 'stopped', { reason });
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        for (const h of this.handlers.get('stream_stopped') ?? []) {
            try {
                h({ event: 'stream_stopped', message: reason });
            } catch {
                // A handler's failure is its own.
            }
        }
    }

    // Fired when the socket reopens after a previous disconnection. Use it
    // to re-fetch any REST snapshot that backs an event-driven view, since
    // events emitted while we were offline are gone for good.
    onReconnect(handler) {
        this.reconnectHandlers.add(handler);
        return () => this.reconnectHandlers.delete(handler);
    }

    connect() {
        this.refCount++;
        this.disposed = false;
        // A new session (signed in again) gets another chance.
        this.stopped = null;
        if (this.ws == null && this.reconnectTimer == null) this._open();
    }

    disconnect() {
        this.refCount = Math.max(0, this.refCount - 1);
        if (this.refCount === 0) {
            this.disposed = true;
            this._teardown();
        }
    }

    on(eventName, handler) {
        let set = this.handlers.get(eventName);
        if (!set) {
            set = new Set();
            this.handlers.set(eventName, set);
        }
        set.add(handler);
        return () => {
            const cur = this.handlers.get(eventName);
            if (cur) {
                cur.delete(handler);
                if (cur.size === 0) this.handlers.delete(eventName);
            }
        };
    }

    subscribe(message) {
        const key = JSON.stringify(message);
        if (this.subs.has(key)) return;
        this.subs.set(key, message);
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            debugLog('ws:events', 'subscribe', message);
            this.ws.send(key);
        }
    }

    async _open() {
        // If a previous handshake hit 401 we trigger a token refresh in the
        // background; await it here so the next attempt uses the fresh
        // token instead of racing the HTTP interceptor's refresh.
        if (this._refreshing) {
            try {
                await this._refreshing;
            } catch {
                /* fall through; readConfig may still have a usable token */
            }
        }
        if (this.disposed || this.stopped) return;
        const config = readConfig();
        if (!config?.server || !config?.token || !config?.username) return;
        const { token } = config;
        const url = `${serverWebSocketURL(config.server)}${v2(config.username)}/events?authorization=${config.token}`;
        debugLog('ws:events', 'connecting', {
            endpoint: `${serverWebSocketURL(config.server)}${v2(config.username)}/events`,
            pending_subs: this.subs.size,
        });
        const ws = new WebSocket(url);
        this.ws = ws;

        ws.on('open', () => {
            if (this.disposed) {
                ws.close();
                return;
            }
            const isReconnect = this.hasOpenedOnce;
            this.hasOpenedOnce = true;
            this.reconnectAttempts = 0;
            debugLog('ws:events', 'open', {
                sub_replay: this.subs.size,
                reconnect: isReconnect,
            });
            for (const [key, msg] of this.subs.entries()) {
                debugLog('ws:events', 'subscribe', msg);
                ws.send(key);
            }
            // Notify after replaying subs so reconnect handlers run with a
            // fully resubscribed socket — they can rely on new events landing.
            if (isReconnect) {
                for (const h of this.reconnectHandlers) {
                    try {
                        h();
                    } catch (err) {
                        debugLog('ws:events', 'reconnect-handler-error', {
                            error: err?.message || String(err),
                        });
                    }
                }
            }
        });

        ws.on('message', (raw) => {
            const bytes = raw?.length ?? 0;
            debugCount('ws:events:bytes', bytes);
            debugCount('ws:events:frames');
            let frame;
            try {
                frame = JSON.parse(raw.toString('utf8'));
            } catch {
                return;
            }
            if (frame?.registered || frame?.success === false) {
                debugLog('ws:events', 'ack', frame);
                return;
            }
            const ev = frame?.event;
            if (!ev) return;
            debugCount(`ws:events:${ev}`);
            const set = this.handlers.get(ev);
            if (!set || set.size === 0) return;
            for (const h of set) {
                try {
                    h(frame);
                } catch (err) {
                    debugLog('ws:events', 'handler-error', {
                        event: ev,
                        error: err?.message || String(err),
                    });
                }
            }
        });

        ws.on('error', (err) => {
            debugLog('ws:events', 'error', { error: err?.message || String(err) });
        });

        // Server rejects expired tokens at the WS handshake with HTTP 401.
        // Without this, we'd reconnect with the same stale token until the
        // exponential backoff outlasted the HTTP interceptor's refresh,
        // which leaves the dashboard empty for up to a minute on the first
        // open after a token expires. Trigger an explicit refresh; _open
        // awaits the in-flight promise on the next reconnect attempt.
        ws.on('unexpected-response', (req, res) => {
            debugLog('ws:events', 'unexpected-response', {
                status: res?.statusCode,
                pending_refresh: !!this._refreshing,
            });
            // With this listener, ws leaves the refused handshake open: end
            // it, so `close` runs and schedules the next attempt.
            try {
                req.destroy();
                ws.terminate();
            } catch {
                // Already gone.
            }
            if (res?.statusCode === 403) {
                this._stop('The account may not read its live events with this session.');
                return;
            }
            if (res?.statusCode === 401 && !this._refreshing) {
                // The token this socket was refused with: when another
                // process has renewed the session meanwhile, that one is used.
                this._refreshing = refreshToken(token)
                    .then(() => {
                        debugLog('ws:events', 'token-refreshed');
                    })
                    .catch((err) => {
                        debugLog('ws:events', 'token-refresh-failed', {
                            error: err?.message || String(err),
                        });
                        // The session is over (or has no renewal): only a
                        // new sign-in brings the stream back. A network
                        // error keeps retrying.
                        if (err?.code === 'unauthorized') {
                            this._stop(err?.message || 'The session expired: sign in again.');
                        }
                    })
                    .finally(() => {
                        this._refreshing = null;
                    });
            }
        });

        ws.on('close', (code, reason) => {
            this.ws = null;
            debugLog('ws:events', 'close', { code, reason: reason?.toString?.() });
            if (this.disposed || this.stopped) return;
            const attempt = this.reconnectAttempts++;
            const delay = Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS);
            debugLog('ws:events', 'reconnect-scheduled', { attempt, delay_ms: delay });
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                if (!this.disposed) this._open();
            }, delay);
        });
    }

    _teardown() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            try {
                this.ws.close();
            } catch {
                // ignore
            }
            this.ws = null;
        }
        this.subs.clear();
        this.handlers.clear();
        this.reconnectAttempts = 0;
    }
}

export const eventStream = new EventStream();
