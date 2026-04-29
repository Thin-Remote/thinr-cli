// @ts-check

// Pure helper for the "click a bucket → filter devices" interaction.
//
// `valuesByDevice` mirrors the per-device latest sample map maintained
// inside `useProductMetrics`: keyed by metricKey (`<product>:<name>`),
// the value is a map of deviceId → latest value reported for that
// metric. We compare reported values to the bucket key after coercing
// both sides to string, matching the behaviour of the `distribution`
// aggregator (which also bins by `String(v)`).

/**
 * @typedef {{ device: string, [k: string]: any }} DeviceLike
 * @typedef {{ metricKey: string, bucket: string, [k: string]: any } | null | undefined} MetricFilter
 */

/**
 * Filter a fleet view down to the devices whose latest sample for the
 * filter's metric equals the chosen bucket. Devices missing a sample for
 * that metric (offline or never-reported) drop out — they belong to the
 * implicit "no data" bucket, which the panel doesn't surface.
 *
 * @template {DeviceLike} D
 * @param {readonly D[]} devices
 * @param {Record<string, Record<string, any>> | null | undefined} valuesByDevice
 * @param {MetricFilter} metricFilter
 * @returns {D[]}
 */
export function filterDevicesByMetric(devices, valuesByDevice, metricFilter) {
    if (!metricFilter || metricFilter.bucket == null) return [...devices];
    const map = valuesByDevice?.[metricFilter.metricKey];
    if (!map) return [];
    const target = String(metricFilter.bucket);
    return devices.filter((d) => {
        const v = map[d.device];
        if (v == null) return false;
        return String(v) === target;
    });
}
