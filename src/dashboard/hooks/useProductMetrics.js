import { useEffect, useRef, useState } from 'react';
import WebSocket from 'ws';
import { readConfig } from '../../../lib/config.js';
import { getProductProperty } from '../../../lib/product.js';
import { callDeviceResource } from '../../../lib/resource.js';
import { runPool } from '../../../lib/concurrency.js';

// Reads the `dashboard_metrics` property from a product and watches each
// metric's resource across every device of the product via a persistent
// websocket subscription to `device_resource_stream`. A one-shot REST
// baseline runs at mount so the UI has a value before the first stream
// frame arrives (the stream has no backfill).

const BASELINE_CONCURRENCY = 15;
const MAX_BACKOFF_MS = 30_000;
const HISTORY_LEN = 32;

function getPath(obj, dotted) {
    if (!dotted) return obj;
    return dotted.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function aggregate(values, mode) {
    const nums = values.filter((v) => Number.isFinite(Number(v))).map(Number);
    if (nums.length === 0 && mode !== 'count') return null;
    switch (mode) {
        case 'avg':
            return nums.reduce((a, b) => a + b, 0) / nums.length;
        case 'max':
            return Math.max(...nums);
        case 'min':
            return Math.min(...nums);
        case 'count':
            return values.filter((v) => v != null).length;
        case 'none':
            return values;
        case 'sum':
        default:
            return nums.reduce((a, b) => a + b, 0);
    }
}

export function useProductMetrics(productId, devices) {
    const [metrics, setMetrics] = useState([]);
    const [values, setValues] = useState({});
    const [history, setHistory] = useState({});
    const [lastUpdate, setLastUpdate] = useState({});
    const [error, setError] = useState(null);
    const devicesRef = useRef(devices);
    devicesRef.current = devices;

    // Load the metric list once per product id. Treat "property missing"
    // as an empty list so a fresh product doesn't fill the UI with an
    // error banner.
    useEffect(() => {
        if (!productId) {
            setMetrics([]);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const value = await getProductProperty(productId, 'dashboard_metrics');
                if (cancelled) return;
                const list = Array.isArray(value) ? value : Array.isArray(value?.metrics) ? value.metrics : [];
                setMetrics(list);
                setError(null);
            } catch (e) {
                if (cancelled) return;
                if (/not found/i.test(e?.message || '')) {
                    setMetrics([]);
                    setError(null);
                } else {
                    setError(e?.message || String(e));
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [productId]);

    // Live stream: one persistent websocket subscribes to
    // `device_resource_stream` for each metric's resource, filtered by
    // product. Server emits a data frame per connected device every
    // metric.interval seconds; we keep a per-device map and recompute
    // the aggregate on each frame.
    useEffect(() => {
        if (!productId || metrics.length === 0) return;

        let disposed = false;
        let ws = null;
        let reconnectAttempts = 0;
        let reconnectTimer = null;
        // metric.name → { interval, field, aggregation, perDevice: {device: value} }
        const state = new Map();
        for (const metric of metrics) {
            state.set(metric.name, {
                interval: Number(metric.interval) > 0 ? Number(metric.interval) : 0,
                resource: metric.resource,
                field: metric.field,
                aggregation: metric.aggregation || 'sum',
                perDevice: {},
            });
        }
        // resource → [metric.name] so one incoming frame can update every
        // metric derived from the same resource.
        const byResource = new Map();
        for (const [name, s] of state.entries()) {
            if (!byResource.has(s.resource)) byResource.set(s.resource, []);
            byResource.get(s.resource).push(name);
        }

        function connect() {
            if (disposed) return;
            const config = readConfig();
            if (!config?.server || !config?.token || !config?.username) return;
            const url = `wss://${config.server}/v2/users/${config.username}/events?authorization=${config.token}`;
            ws = new WebSocket(url);

            ws.on('open', () => {
                if (disposed) {
                    ws.close();
                    return;
                }
                reconnectAttempts = 0;
                // One subscription per distinct resource. If any metric
                // sharing the resource defines a positive interval, drive
                // the stream at the smallest one (server expects ms); if
                // none do, subscribe without interval so the stream relays
                // whatever the device pushes on its own.
                for (const [resource, names] of byResource.entries()) {
                    const positives = names
                        .map((n) => state.get(n).interval)
                        .filter((v) => v > 0);
                    const msg = {
                        event: 'device_resource_stream',
                        filters: { product: productId, resource },
                    };
                    if (positives.length > 0) {
                        msg.params = { interval: Math.min(...positives) * 1000 };
                    }
                    ws.send(JSON.stringify(msg));
                }
            });

            ws.on('message', (raw) => {
                let frame;
                try {
                    frame = JSON.parse(raw.toString('utf8'));
                } catch {
                    return;
                }
                if (frame?.registered || frame?.success === false) return;
                if (frame?.event !== 'device_resource_stream') return;
                if (frame.signal && frame.signal !== 'data') return;

                const resource = frame.resource;
                const device = frame.device;
                const payload = frame.payload;
                if (!resource || !device || payload == null) return;
                const names = byResource.get(resource);
                if (!names) return;

                for (const name of names) {
                    const s = state.get(name);
                    const v = getPath(payload, s.field);
                    s.perDevice[device] = v;
                    const agg = aggregate(Object.values(s.perDevice), s.aggregation);
                    setValues((cur) => ({ ...cur, [name]: agg }));
                    setHistory((cur) => ({
                        ...cur,
                        [name]: [...(cur[name] || []), agg].slice(-HISTORY_LEN),
                    }));
                    setLastUpdate((cur) => ({ ...cur, [name]: Date.now() }));
                }
            });

            ws.on('error', () => {
                // surfaced via close.
            });

            ws.on('close', () => {
                ws = null;
                if (disposed) return;
                const attempt = reconnectAttempts++;
                const delay = Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS);
                reconnectTimer = setTimeout(connect, delay);
            });
        }

        // REST baseline on mount so the UI has a value before the first
        // stream frame. One sample per online device of the product.
        (async () => {
            const pool = (devicesRef.current || []).filter(
                (d) => d.connection?.active && (!d.product || d.product === productId),
            );
            if (pool.length === 0) return;
            for (const metric of metrics) {
                const results = await runPool(pool, BASELINE_CONCURRENCY, async (d) => {
                    try {
                        const data = await callDeviceResource(d.device, metric.resource);
                        return { device: d.device, value: getPath(data, metric.field) };
                    } catch {
                        return { device: d.device, value: null };
                    }
                });
                if (disposed) return;
                const s = state.get(metric.name);
                for (const r of results) {
                    if (r?.ok && r.value?.device) {
                        s.perDevice[r.value.device] = r.value.value;
                    }
                }
                const agg = aggregate(Object.values(s.perDevice), s.aggregation);
                setValues((cur) => ({ ...cur, [metric.name]: agg }));
                setHistory((cur) => ({
                    ...cur,
                    [metric.name]: [...(cur[metric.name] || []), agg].slice(-HISTORY_LEN),
                }));
                setLastUpdate((cur) => ({ ...cur, [metric.name]: Date.now() }));
            }
        })();

        connect();

        return () => {
            disposed = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            if (ws) {
                try {
                    ws.close();
                } catch {
                    // ignore
                }
                ws = null;
            }
        };
    }, [productId, metrics]);

    return { metrics, values, history, lastUpdate, error };
}
