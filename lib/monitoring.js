import api from './api.js';
import { apiError } from './errors.js';
import { requireConfig } from './config.js';

function resolveUser(user) {
    return user || requireConfig().username;
}

/**
 * Query the monitoring bucket. When `device` is provided, scopes to
 * that device's bucket; otherwise queries the user-level bucket
 * across every device of the account.
 *
 * Time range:
 *   - `minutes`: shortcut for "last N minutes" (sets min_ts to
 *     `Date.now() - minutes * 60_000`, max_ts to 0).
 *   - `min_ts` / `max_ts`: explicit unix-millis range when `minutes`
 *     is not supplied; either may be omitted for an open bound.
 *
 * Aggregation: `agg` is the bucket size (e.g. "5m"), `agg_type` the
 * reducer (e.g. "avg"), and `fields` a comma-separated allowlist to
 * trim the response down.
 *
 * Multi-device queries (no `device`) default to `group_by=device`, so
 * the server returns one row per device instead of a stream of raw
 * samples interleaved across the fleet. Without `agg_type`, that row is
 * the latest sample per device; with `agg_type` (max/mean/min/...), the
 * reducer is applied across the time window per device. Pass
 * `group_by=''` to opt out and get raw interleaved samples.
 *
 * @param {{
 *   device?: string | null,
 *   user?: string | null,
 *   items?: number,
 *   sort?: string,
 *   minutes?: number,
 *   min_ts?: number,
 *   max_ts?: number,
 *   agg?: string,
 *   agg_type?: string,
 *   fields?: string,
 *   group_by?: string | null,
 * }} [opts]
 */
export async function getMonitoringData({
    device = null,
    user = null,
    items = 10,
    sort = 'desc',
    minutes,
    min_ts,
    max_ts,
    agg,
    agg_type,
    fields,
    group_by,
} = {}) {
    const apiUser = resolveUser(user);
    const params = { items, sort };
    if (minutes) {
        params.min_ts = Date.now() - minutes * 60 * 1000;
        params.max_ts = 0;
    } else {
        if (min_ts) params.min_ts = min_ts;
        if (max_ts !== undefined) params.max_ts = max_ts;
    }
    if (agg) params.agg = agg;
    if (agg_type) params.agg_type = agg_type;
    // Default multi-device queries to one row per device. An explicit empty
    // string opts out (raw interleaved samples); any other explicit value
    // is passed through verbatim.
    const effectiveGroupBy = group_by === undefined ? (device ? null : 'device') : group_by;
    if (effectiveGroupBy) params.group_by = effectiveGroupBy;
    if (fields) {
        // Raw multi-device queries (no group_by) need `device` in the field
        // list to attribute each sample — otherwise rows come back anonymous.
        // With group_by the server already projects the group key in the
        // output, and injecting `device` here would confuse the field filter.
        const hasDevice = fields
            .split(',')
            .map((s) => s.trim())
            .includes('device');
        params.fields =
            !device && !effectiveGroupBy && !hasDevice ? `device,${fields}` : fields;
    }

    const url = device
        ? `/v3/users/${apiUser}/devices/${device}/buckets/monitoring/data`
        : `/v2/users/${apiUser}/buckets/monitoring/data`;

    try {
        const res = await api.get(url, { params });
        return res.data;
    } catch (e) {
        throw apiError(e);
    }
}
