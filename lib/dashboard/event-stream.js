// @ts-check
import WebSocket from 'ws';
import { readConfig } from '../config.js';
import { debugCount, debugLog } from '../debug-log.js';

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
    }

    connect() {
        this.refCount++;
        this.disposed = false;
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

    _open() {
        const config = readConfig();
        if (!config?.server || !config?.token || !config?.username) return;
        const url = `wss://${config.server}/v2/users/${config.username}/events?authorization=${config.token}`;
        debugLog('ws:events', 'connecting', {
            endpoint: `wss://${config.server}/v2/users/${config.username}/events`,
            pending_subs: this.subs.size,
        });
        const ws = new WebSocket(url);
        this.ws = ws;

        ws.on('open', () => {
            if (this.disposed) {
                ws.close();
                return;
            }
            this.reconnectAttempts = 0;
            debugLog('ws:events', 'open', { sub_replay: this.subs.size });
            for (const [key, msg] of this.subs.entries()) {
                debugLog('ws:events', 'subscribe', msg);
                ws.send(key);
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

        ws.on('close', (code, reason) => {
            this.ws = null;
            debugLog('ws:events', 'close', { code, reason: reason?.toString?.() });
            if (this.disposed) return;
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
