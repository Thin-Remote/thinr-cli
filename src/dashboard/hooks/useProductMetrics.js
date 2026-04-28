import { useEffect, useState } from 'react';
import { getProductProperty } from '../../../lib/product.js';
import { debugCount, debugLog } from '../../../lib/debug-log.js';
import { eventStream } from '../../../lib/dashboard/event-stream.js';

// Reads the `dashboard_metrics` property from a product and watches each
// metric's resource across every device of the product via a persistent
// websocket subscription to `device_resource_stream`. A one-shot REST
// baseline runs at mount so the UI has a value before the first stream
// frame arrives (the stream has no backfill).

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

export function useProductMetrics(productId) {
    const [metrics, setMetrics] = useState([]);
    const [values, setValues] = useState({});
    const [history, setHistory] = useState({});
    const [lastUpdate, setLastUpdate] = useState({});
    const [error, setError] = useState(null);

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
            const t0 = Date.now();
            debugLog('http:metrics-list', 'start', { product: productId });
            try {
                const value = await getProductProperty(productId, 'dashboard_metrics');
                debugLog('http:metrics-list', 'end', {
                    duration_ms: Date.now() - t0,
                    product: productId,
                    metric_count: Array.isArray(value) ? value.length : Array.isArray(value?.metrics) ? value.metrics.length : 0,
                });
                if (cancelled) return;
                const list = Array.isArray(value) ? value : Array.isArray(value?.metrics) ? value.metrics : [];
                setMetrics(list);
                setError(null);
            } catch (e) {
                debugLog('http:metrics-list', 'error', {
                    duration_ms: Date.now() - t0,
                    product: productId,
                    error: e?.message || String(e),
                });
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

    // Live stream via the shared event stream singleton. Subscribes to
    // `device_resource_stream` once per distinct resource (filtered by
    // product); the singleton handles connection, replay on reconnect,
    // and dispatching frames whose `event` matches.
    useEffect(() => {
        if (!productId || metrics.length === 0) return;

        let disposed = false;
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

        eventStream.connect();
        const offFrame = eventStream.on('device_resource_stream', (frame) => {
            if (frame.signal && frame.signal !== 'data') {
                debugCount(`ws:metrics:dropped:${frame.signal}`);
                return;
            }
            const resource = frame.resource;
            const device = frame.device;
            const payload = frame.payload;
            if (!resource || !device || payload == null) {
                debugCount('ws:metrics:dropped:missing-fields');
                return;
            }
            const names = byResource.get(resource);
            if (!names) {
                debugCount('ws:metrics:dropped:unknown-resource');
                return;
            }
            debugCount(`ws:metrics:ok:${resource}`);
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
            eventStream.subscribe(msg);
        }

        // No REST baseline: the previous implementation made one IOTMP
        // call per device per metric (~200 calls for 99 devices × 2
        // metrics, ~10s wallclock and a real CPU spike on the backend),
        // just to show values a few seconds earlier. The WS stream
        // already pushes values for every device within the configured
        // interval, so we let the panel render with placeholders until
        // frames arrive.

        return () => {
            disposed = true;
            offFrame();
            eventStream.disconnect();
        };
    }, [productId, metrics]);

    return { metrics, values, history, lastUpdate, error };
}
