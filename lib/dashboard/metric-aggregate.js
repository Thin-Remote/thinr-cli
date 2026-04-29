// @ts-check

// Pure helpers for product-metric aggregation. Extracted from
// `useProductMetrics` so the dashboard hook stays minimal and the
// reducers can be unit-tested without dragging React or the websocket
// singleton into the test runtime.

/**
 * Walk a dotted path into a payload. Returns `obj` itself when no path
 * is supplied, and `undefined` when any intermediate hop is null.
 *
 * @param {*} obj
 * @param {string | undefined} dotted
 */
export function getPath(obj, dotted) {
    if (!dotted) return obj;
    return dotted.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

/**
 * Combine the latest values reported by every device of a product into
 * a single panel value. Numeric reducers ignore non-numeric / null
 * samples; categorical reducers operate on the raw values.
 *
 *   distribution → Record<string, number> (value coerced to string → device count)
 *   count        → number of devices reporting any non-null value
 *   none         → the raw values array, untouched
 *   sum/avg/max/min → number, or null when no numeric samples are present
 *
 * @param {readonly unknown[]} values
 * @param {string | undefined} mode
 */
export function aggregate(values, mode) {
    if (mode === 'distribution') {
        /** @type {Record<string, number>} */
        const buckets = {};
        for (const v of values) {
            if (v == null) continue;
            const key = String(v);
            if (key === '') continue;
            buckets[key] = (buckets[key] || 0) + 1;
        }
        return buckets;
    }
    if (mode === 'count') {
        return values.filter((v) => v != null).length;
    }
    if (mode === 'none') {
        return values;
    }
    const nums = values.filter((v) => Number.isFinite(Number(v))).map(Number);
    if (nums.length === 0) return null;
    switch (mode) {
        case 'avg':
            return nums.reduce((a, b) => a + b, 0) / nums.length;
        case 'max':
            return Math.max(...nums);
        case 'min':
            return Math.min(...nums);
        case 'sum':
        default:
            return nums.reduce((a, b) => a + b, 0);
    }
}
