// @ts-check
import { getMonitoringData } from '../monitoring.js';
import { inputError } from '../errors.js';
import { BYTES, TIMEOUTS } from '../constants.js';
import { getAPI } from './helpers.js';

async function toolExec(args) {
    const { api } = getAPI(args.device, args.user);
    // Default guards against hung commands locking the session; callers
    // override for known-long operations. Knob lives in lib/constants.js.
    const timeout =
        Number.isFinite(args.timeout) && args.timeout > 0
            ? args.timeout
            : TIMEOUTS.DEFAULT_EXEC_SECONDS;
    let output = '';
    const { exitCode, timedOut } = await api.execStream(args.command, {
        timeout,
        onStdout: (s) => {
            output += s;
        },
        onStderr: (s) => {
            output += s;
        },
    });
    const trailer = [];
    if (timedOut) trailer.push(`[command timed out after ${timeout}s]`);
    trailer.push(`[exit code: ${exitCode ?? 'unknown'}]`);
    const text = [output.trimEnd(), trailer.join(' ')].filter(Boolean).join('\n');
    return {
        content: [{ type: 'text', text: text || '(no output)' }],
        isError: timedOut || exitCode !== 0,
    };
}

async function toolUpdate(args) {
    const { api: deviceApi } = getAPI(args.device, args.user);
    const payload = {
        action: args.action,
        channel: args.channel || 'latest',
    };
    const result = await deviceApi.callResource('update', payload);
    return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: false,
    };
}

async function toolMonitoring(args) {
    const device = args.device;
    const user = args.user;

    // Real-time: read the device's `monitoring` resource directly.
    if (args.realtime) {
        if (!device) throw inputError('Device required for real-time monitoring');
        const { api: deviceApi } = getAPI(device, args.user);
        const mon = await deviceApi.getResource('monitoring');
        const parts = [`Real-time monitoring for ${device}:`];
        if (mon.cpu)
            parts.push(
                `CPU: ${mon.cpu.usage?.toFixed(1)}% (${mon.cpu.cores} cores, ${mon.cpu.temperature?.toFixed(1)}°C)`,
            );
        if (mon.memory)
            parts.push(
                `Memory: ${mon.memory.usage?.toFixed(1)}% (available: ${(mon.memory.available / BYTES.GB).toFixed(1)}GB / total: ${(mon.memory.total / BYTES.GB).toFixed(1)}GB)`,
            );
        if (mon.disk?.root)
            parts.push(
                `Disk: ${mon.disk.root.usage?.toFixed(1)}% (available: ${(mon.disk.root.available / BYTES.GB).toFixed(1)}GB / total: ${(mon.disk.root.total / BYTES.GB).toFixed(0)}GB)`,
            );
        if (mon.network)
            parts.push(
                `Network: rx=${(mon.network.rx_rate / BYTES.KB).toFixed(1)}KB/s tx=${(mon.network.tx_rate / BYTES.KB).toFixed(1)}KB/s`,
            );
        if (mon.load)
            parts.push(
                `Load: ${mon.load['1m']?.toFixed(2)} / ${mon.load['5m']?.toFixed(2)} / ${mon.load['15m']?.toFixed(2)}`,
            );
        if (mon.processes) parts.push(`Processes: ${mon.processes.total}`);
        if (mon.uptime)
            parts.push(
                `Uptime: ${Math.floor(mon.uptime / 86400)}d ${Math.floor((mon.uptime % 86400) / 3600)}h ${Math.floor((mon.uptime % 3600) / 60)}m`,
            );
        if (mon.agent) parts.push(`Agent: ${mon.agent.version}`);
        return { content: [{ type: 'text', text: parts.join('\n') }], isError: false };
    }

    // Historical: query the monitoring bucket.
    const data = await getMonitoringData({
        device,
        user,
        items: args.items || 10,
        sort: args.sort || 'desc',
        minutes: args.minutes,
        min_ts: args.min_ts,
        max_ts: args.max_ts,
        agg: args.agg,
        agg_type: args.agg_type,
        fields: args.fields,
    });

    let output;
    if (Array.isArray(data) && data.length > 0) {
        output = data
            .map((d) => {
                // Single-window aggregated rows (group_by without `agg`) come
                // back without `ts`; skip it rather than emitting "Invalid Date".
                const parts = [];
                if (d.ts) parts.push(new Date(d.ts).toISOString());
                if (d.device) parts.push(`device=${d.device}`);
                if (d.cpu) {
                    const cpuParts = [];
                    if (d.cpu.usage !== undefined) cpuParts.push(`${d.cpu.usage.toFixed(1)}%`);
                    if (d.cpu.temperature !== undefined)
                        cpuParts.push(`${d.cpu.temperature.toFixed(1)}°C`);
                    if (cpuParts.length) parts.push(`cpu=${cpuParts.join(' ')}`);
                }
                if (d.memory) parts.push(`mem=${d.memory.usage?.toFixed(1)}%`);
                if (d.disk?.root) parts.push(`disk=${d.disk.root.usage?.toFixed(1)}%`);
                if (d.network)
                    parts.push(
                        `net_rx=${(d.network.rx_rate / BYTES.KB)?.toFixed(1)}KB/s tx=${(d.network.tx_rate / BYTES.KB)?.toFixed(1)}KB/s`,
                    );
                if (d.load) parts.push(`load=${d.load['1m']?.toFixed(2)}`);
                if (d.processes) parts.push(`procs=${d.processes.total}`);
                return parts.join(' | ');
            })
            .join('\n');
    } else {
        output = JSON.stringify(data, null, 2);
    }

    return {
        content: [{ type: 'text', text: output || 'No data' }],
        isError: false,
    };
}

export const tools = [
    {
        name: 'thinr_exec',
        description: `Execute a shell command on a remote device. Returns stdout, stderr, and exit code.`,
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command to execute' },
                device: { type: 'string', description: 'Device ID (from thinr_devices)' },
                timeout: { type: 'number', description: 'Timeout in seconds (default: 30)' },
                user: { type: 'string', description: 'API user (for admin impersonation)' },
            },
            required: ['command', 'device'],
        },
        handler: toolExec,
    },
    {
        name: 'thinr_update',
        description: `Check for agent updates or apply an update on a remote device.`,
        inputSchema: {
            type: 'object',
            properties: {
                device: { type: 'string', description: 'Device ID' },
                action: {
                    type: 'string',
                    description: '"check" to check for updates, "apply" to install the update',
                },
                channel: { type: 'string', description: 'Update channel (default: "latest")' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['action', 'device'],
        },
        handler: toolUpdate,
    },
    {
        name: 'thinr_monitoring',
        description: `Get monitoring data (CPU, memory, disk, network, temperature, load).

Modes:
- realtime=true + device: live sample read straight from the agent.
- device only: historical time series for that device. Use \`agg\`+\`agg_type\` for time-windowed aggregates (e.g. avg CPU every 5m over the last hour).
- no device: historical fleet view — returns ONE ROW PER DEVICE. Without \`agg_type\` each row is the latest sample for that device ("current fleet state"). With \`agg_type\` each row is the reducer applied over the time window per device (e.g. \`agg_type=max\`+\`minutes=60\` ⇒ peak per device in the last hour, ideal for ranking "which device had the most X"). Sort the returned array client-side on the metric to get the top N.`,
        inputSchema: {
            type: 'object',
            properties: {
                realtime: {
                    type: 'boolean',
                    description:
                        'If true, get live data directly from the device. If false/omitted, query historical data from the monitoring bucket.',
                },
                device: {
                    type: 'string',
                    description:
                        'Device ID. Required for realtime. Omit for a one-row-per-device fleet view.',
                },
                items: {
                    type: 'number',
                    description: 'Number of data points to return (default: 10). In multi-device mode set ≥ number of devices (e.g. 200) since each device contributes one row.',
                },
                minutes: {
                    type: 'number',
                    description: 'Get data from the last N minutes. Alternative to min_ts/max_ts.',
                },
                min_ts: { type: 'number', description: 'Minimum timestamp in milliseconds' },
                max_ts: {
                    type: 'number',
                    description: 'Maximum timestamp in milliseconds (0 = now)',
                },
                sort: {
                    type: 'string',
                    description: 'Sort order by timestamp: "asc" or "desc" (default: "desc"). Does NOT sort by metric — do that client-side on the result.',
                },
                agg: { type: 'string', description: 'Time-window size for windowed aggregation: "5m", "10m", "1h", "6h". Only meaningful with a specific device. For a per-device single value across the whole range, omit `agg` and pass `agg_type` alone.' },
                agg_type: {
                    type: 'string',
                    description: 'Reducer applied to each group/window. Supported: "mean", "max", "min", "sum", "count", "first", "last", "median", "spread" (max-min), "stddev". Most common for monitoring: max, mean, min.',
                },
                fields: {
                    type: 'string',
                    description:
                        'Comma-separated fields to return (e.g., "cpu.usage,memory.usage,disk.root.usage"). Narrower queries are cheaper and produce tidier output.',
                },
                user: { type: 'string', description: 'API user' },
            },
            required: [],
        },
        handler: toolMonitoring,
    },
];
