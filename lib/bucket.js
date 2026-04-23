import api from './api.js';
import { apiError } from './errors.js';
import { requireConfig } from './config.js';

function resolveUser(user) {
    return user || requireConfig().username;
}

/**
 * Query an arbitrary time-series bucket declared in a product profile.
 * When `device` is provided, scopes to that device's bucket; otherwise
 * queries the user-level bucket across every device of the account.
 *
 * Buckets are the mechanism products use to persist structured samples
 * over time — the platform ships a `monitoring` bucket by default, and
 * users can declare custom ones for their own metrics.
 *
 * Time range:
 *   - `minutes`: shortcut for "last N minutes" (sets min_ts to
 *     `Date.now() - minutes * 60_000`, max_ts to 0).
 *   - `min_ts` / `max_ts`: explicit unix-millis range when `minutes`
 *     is not supplied; either may be omitted for an open bound.
 *
 * Aggregation: `agg` is the time-window size (e.g. "5m"), `agg_type`
 * the reducer (e.g. "mean"), and `fields` a comma-separated allowlist
 * to trim the response down.
 *
 * `group_by` is passed through verbatim — no default. Custom buckets
 * may not even expose a `device` tag, so the caller decides whether
 * to group (e.g. `group_by=device` for a fleet view) or read raw
 * interleaved samples.
 *
 * @param {{
 *   bucket: string,
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
 * }} opts
 */
export async function getBucketData({
    bucket,
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
    if (!bucket) throw new Error('bucket is required');
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
    if (group_by) params.group_by = group_by;
    if (fields) params.fields = fields;

    const url = device
        ? `/v3/users/${apiUser}/devices/${device}/buckets/${bucket}/data`
        : `/v2/users/${apiUser}/buckets/${bucket}/data`;

    try {
        const res = await api.get(url, { params });
        return res.data;
    } catch (e) {
        throw apiError(e);
    }
}
