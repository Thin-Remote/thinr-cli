// @ts-check
import { getBucketData } from '../bucket.js';
import { inputError } from '../errors.js';

async function toolBucketRead(args) {
    if (!args.bucket)
        throw inputError(
            'bucket is required. Buckets are declared in the product profile (default: "monitoring").',
        );
    const data = await getBucketData({
        bucket: args.bucket,
        device: args.device,
        user: args.user,
        items: args.items || 10,
        sort: args.sort || 'desc',
        minutes: args.minutes,
        min_ts: args.min_ts,
        max_ts: args.max_ts,
        agg: args.agg,
        agg_type: args.agg_type,
        fields: args.fields,
        group_by: args.group_by,
    });
    const text =
        Array.isArray(data) && data.length === 0
            ? 'No data'
            : JSON.stringify(data, null, 2);
    return {
        content: [{ type: 'text', text }],
        isError: false,
    };
}

export const tools = [
    {
        name: 'thinr_bucket_read',
        description: `Query any time-series bucket declared in the product profile. Use this for custom metrics (domain data, business events, custom sensors) beyond the default \`monitoring\` bucket — for \`monitoring\` itself prefer \`thinr_monitoring\`, which formats the output.

Modes:
- device set: historical time series scoped to that device.
- no device: user-level query across the fleet. By default returns raw interleaved samples; pass \`group_by=device\` (assuming the bucket tags samples with \`device\`) to get one row per device.

Custom buckets may not share the \`monitoring\` schema — don't assume a \`device\` tag exists unless the product profile defines it.`,
        inputSchema: {
            type: 'object',
            properties: {
                bucket: {
                    type: 'string',
                    description:
                        'Bucket ID as declared in the product profile (e.g. "monitoring", or a custom one like "sensors", "events").',
                },
                device: {
                    type: 'string',
                    description:
                        'Device ID. Omit for a one-row-per-device fleet view.',
                },
                items: {
                    type: 'number',
                    description:
                        'Number of data points to return (default: 10). In multi-device mode set ≥ number of devices.',
                },
                minutes: {
                    type: 'number',
                    description:
                        'Get data from the last N minutes. Alternative to min_ts/max_ts.',
                },
                min_ts: { type: 'number', description: 'Minimum timestamp in milliseconds' },
                max_ts: {
                    type: 'number',
                    description: 'Maximum timestamp in milliseconds (0 = now)',
                },
                sort: {
                    type: 'string',
                    description:
                        'Sort order by timestamp: "asc" or "desc" (default: "desc"). Does NOT sort by metric — do that client-side.',
                },
                agg: {
                    type: 'string',
                    description:
                        'Time-window size for windowed aggregation: "5m", "10m", "1h", "6h". Only meaningful with a specific device. For a per-device single value across the whole range, omit `agg` and pass `agg_type` alone.',
                },
                agg_type: {
                    type: 'string',
                    description:
                        'Reducer applied to each group/window. Supported: "mean", "max", "min", "sum", "count", "first", "last", "median", "spread", "stddev".',
                },
                fields: {
                    type: 'string',
                    description:
                        'Comma-separated fields to return (e.g., "temperature,humidity"). Narrower queries are cheaper.',
                },
                group_by: {
                    type: 'string',
                    description:
                        'Optional group key (e.g. "device" for a one-row-per-device fleet view). Omit for raw samples — custom buckets may not carry a "device" tag.',
                },
                user: { type: 'string', description: 'API user' },
            },
            required: ['bucket'],
        },
        handler: toolBucketRead,
    },
];
