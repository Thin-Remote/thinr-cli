import { useEffect, useMemo, useState } from 'react';
import { getProductProperty } from '../../../lib/product.js';
import { debugCount, debugLog } from '../../../lib/debug-log.js';
import { eventStream } from '../../../lib/dashboard/event-stream.js';
import { aggregate, getPath } from '../../../lib/dashboard/metric-aggregate.js';

// Reads `dashboard_metrics` from each product present in the fleet and
// watches their resources across every device of each product via a
// persistent websocket subscription to `device_resource_stream`. The
// stream has no backfill: panels render with placeholders until the
// first frame for each metric arrives.
//
// Metrics from different products live in the same flat list. The
// frontend keys per-metric state by `<product>:<name>` so two products
// using the same metric name don't collide.

const HISTORY_LEN = 32;

function metricKey(productId, name) {
    return `${productId}:${name}`;
}

export function useProductMetrics(productIds) {
    // Stable key so we can dep on the actual product set rather than the
    // identity of the array passed in (callers tend to recompute).
    const idsKey = useMemo(() => {
        if (!Array.isArray(productIds)) return '';
        return [...productIds].filter(Boolean).sort().join(',');
    }, [productIds]);
    const ids = useMemo(
        () => (idsKey ? idsKey.split(',') : []),
        [idsKey],
    );

    const [metrics, setMetrics] = useState([]);
    const [values, setValues] = useState({});
    const [history, setHistory] = useState({});
    const [lastUpdate, setLastUpdate] = useState({});
    // Latest sample per (metricKey, deviceId). Mirrors the same per-device
    // map the aggregator already holds, but exposed to React so panels can
    // turn the bucket cursor into a device list filter ("which boxes
    // reported this exact value?").
    const [valuesByDevice, setValuesByDevice] = useState({});
    const [error, setError] = useState(null);

    // Load the metric list per product, in parallel, and concatenate.
    // Each metric carries the `product` it came from so the live-stream
    // effect can subscribe with the right filter and render-keys stay
    // stable across products.
    useEffect(() => {
        if (ids.length === 0) {
            setMetrics([]);
            setError(null);
            return;
        }
        let cancelled = false;
        (async () => {
            const t0 = Date.now();
            debugLog('http:metrics-list', 'start', { products: ids });
            const results = await Promise.all(
                ids.map(async (productId) => {
                    try {
                        const value = await getProductProperty(productId, 'dashboard_metrics');
                        const list = Array.isArray(value)
                            ? value
                            : Array.isArray(value?.metrics)
                              ? value.metrics
                              : [];
                        return list.map((m) => ({ ...m, product: productId }));
                    } catch (e) {
                        if (/not found/i.test(e?.message || '')) return [];
                        throw e;
                    }
                }),
            );
            if (cancelled) return;
            const flat = results.flat();
            debugLog('http:metrics-list', 'end', {
                duration_ms: Date.now() - t0,
                products: ids,
                metric_count: flat.length,
            });
            setMetrics(flat);
            setError(null);
        })().catch((e) => {
            debugLog('http:metrics-list', 'error', {
                products: ids,
                error: e?.message || String(e),
            });
            if (!cancelled) setError(e?.message || String(e));
        });
        return () => {
            cancelled = true;
        };
    }, [ids]);

    // Live stream via the shared event stream singleton. Subscribes to
    // `device_resource_stream` once per (product, resource) tuple; the
    // singleton handles connection, replay on reconnect, and dispatching
    // frames whose `event` matches.
    useEffect(() => {
        if (metrics.length === 0) return;

        // key (product:name) → { interval, resource, field, aggregation, perDevice }
        const state = new Map();
        for (const metric of metrics) {
            const key = metricKey(metric.product, metric.name);
            state.set(key, {
                product: metric.product,
                interval: Number(metric.interval) > 0 ? Number(metric.interval) : 0,
                resource: metric.resource,
                field: metric.field,
                aggregation: metric.aggregation || 'sum',
                perDevice: {},
            });
        }
        // (product, resource) → [key] so a single incoming frame updates
        // every metric derived from the same resource within that product.
        const byProductResource = new Map();
        for (const [key, s] of state.entries()) {
            const tupleKey = `${s.product}::${s.resource}`;
            if (!byProductResource.has(tupleKey)) byProductResource.set(tupleKey, []);
            byProductResource.get(tupleKey).push(key);
        }

        eventStream.connect();
        const offFrame = eventStream.on('device_resource_stream', (frame) => {
            if (frame.signal && frame.signal !== 'data') {
                debugCount(`ws:metrics:dropped:${frame.signal}`);
                return;
            }
            const resource = frame.resource;
            const device = frame.device;
            const product = frame.product;
            const payload = frame.payload;
            if (!resource || !device || payload == null) {
                debugCount('ws:metrics:dropped:missing-fields');
                return;
            }
            // Server-side filter routes frames per subscription, but the
            // shared singleton multiplexes every product's subscription
            // over the same socket — match the frame to the right metric
            // bucket using `product` when the field is present, falling
            // back to any tuple with the same resource so older frames
            // without the field still update the right metrics (the
            // resource name is unique per product in practice).
            const tupleKey = product ? `${product}::${resource}` : null;
            let keys = tupleKey ? byProductResource.get(tupleKey) : null;
            if (!keys) {
                for (const [tk, ks] of byProductResource.entries()) {
                    if (tk.endsWith(`::${resource}`)) {
                        keys = ks;
                        break;
                    }
                }
            }
            if (!keys) {
                debugCount('ws:metrics:dropped:unknown-resource');
                return;
            }
            debugCount(`ws:metrics:ok:${resource}`);
            for (const key of keys) {
                const s = state.get(key);
                const v = getPath(payload, s.field);
                s.perDevice[device] = v;
                const agg = aggregate(Object.values(s.perDevice), s.aggregation);
                setValues((cur) => ({ ...cur, [key]: agg }));
                setHistory((cur) => ({
                    ...cur,
                    [key]: [...(cur[key] || []), agg].slice(-HISTORY_LEN),
                }));
                setLastUpdate((cur) => ({ ...cur, [key]: Date.now() }));
                setValuesByDevice((cur) => ({
                    ...cur,
                    [key]: { ...(cur[key] || {}), [device]: v },
                }));
            }
        });

        for (const [tupleKey, keys] of byProductResource.entries()) {
            const [product, resource] = tupleKey.split('::');
            const positives = keys
                .map((k) => state.get(k).interval)
                .filter((v) => v > 0);
            const msg = {
                event: 'device_resource_stream',
                filters: { product, resource },
            };
            if (positives.length > 0) {
                msg.params = { interval: Math.min(...positives) * 1000 };
            }
            eventStream.subscribe(msg);
        }

        return () => {
            offFrame();
            eventStream.disconnect();
        };
    }, [metrics]);

    return { metrics, values, history, lastUpdate, valuesByDevice, error };
}
