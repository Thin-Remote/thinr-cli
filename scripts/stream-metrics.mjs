#!/usr/bin/env node
// Dev helper: open a websocket to device_resource_stream for a product's
// resource and print every frame to stdout in real time. Use it to eyeball
// what the dashboard_metrics hook is consuming.
//
//   node scripts/stream-metrics.mjs [options]
//
// Options:
//   --product <id>       default: thinremote
//   --resource <name>    default: server_stats
//   --field <dotted>     default: connections.devices
//   --aggregation <mode> sum|avg|min|max|count|none   default: sum
//   --device <id>        also filter to a single device (scope subscription)
//   --interval <seconds> pass params.interval to the server (off by default —
//                        the dashboard comment warns this collides with the
//                        product bucket handler, so by default we omit it)
//   --raw                print every frame verbatim (no collapsing)
//   --verbose            also print registered/ack frames

import WebSocket from 'ws';
import { readConfig } from '../lib/config.js';

function parseArgs(argv) {
    const out = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
            out[key] = next;
            i++;
        } else {
            out[key] = true;
        }
    }
    return out;
}

const args = parseArgs(process.argv);
const product = args.product ?? 'thinremote';
const resource = args.resource ?? 'server_stats';
const field = args.field ?? 'connections.devices';
const aggregation = args.aggregation ?? 'sum';
const deviceFilter = args.device ?? null;
const interval = args.interval ? Number(args.interval) : null;
const raw = Boolean(args.raw);
const verbose = Boolean(args.verbose);

function getPath(obj, dotted) {
    if (!dotted) return obj;
    return dotted.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function aggregate(values, mode) {
    const nums = values.filter((v) => Number.isFinite(Number(v))).map(Number);
    if (nums.length === 0 && mode !== 'count') return null;
    switch (mode) {
        case 'avg': return nums.reduce((a, b) => a + b, 0) / nums.length;
        case 'max': return Math.max(...nums);
        case 'min': return Math.min(...nums);
        case 'count': return values.filter((v) => v != null).length;
        case 'none': return values;
        case 'sum':
        default: return nums.reduce((a, b) => a + b, 0);
    }
}

function ts() {
    return new Date().toISOString().replace('T', ' ').slice(11, 19);
}

const config = readConfig();
if (!config?.server || !config?.token || !config?.username) {
    console.error('Missing config (server/token/username). Run `thinr` to authenticate first.');
    process.exit(1);
}

const url = `wss://${config.server}/v2/users/${config.username}/events?authorization=${config.token}`;
console.log(`→ connecting ${config.server} as ${config.username}`);
console.log(`  product=${product} resource=${resource} field=${field} agg=${aggregation}` +
    (deviceFilter ? ` device=${deviceFilter}` : '') +
    (interval ? ` interval=${interval}s` : ''));
if (!raw) console.log('  (collapsing signal=error bursts; use --raw to see every frame)');

const perDevice = {};
// Error-signal burst collapsing: counts per device. Flushed periodically.
const errorSeen = new Map();
let errorFlushTimer = null;

function scheduleErrorFlush() {
    if (errorFlushTimer) return;
    errorFlushTimer = setTimeout(() => {
        errorFlushTimer = null;
        if (errorSeen.size === 0) return;
        const total = [...errorSeen.values()].reduce((a, b) => a + b, 0);
        const unique = errorSeen.size;
        const sample = [...errorSeen.keys()].slice(0, 3).join(', ');
        console.log(
            `[${ts()}] ⚠ signal=error burst — ${total} frame(s) over ${unique} device(s)` +
            ` (e.g. ${sample}${unique > 3 ? ', …' : ''})`,
        );
        errorSeen.clear();
    }, 800);
}

const ws = new WebSocket(url);

ws.on('open', () => {
    console.log('✓ open — subscribing to device_resource_stream');
    const filters = { product, resource };
    if (deviceFilter) filters.device = deviceFilter;
    const msg = { event: 'device_resource_stream', filters };
    if (interval) msg.params = { interval };
    ws.send(JSON.stringify(msg));
});

ws.on('message', (rawBuf) => {
    let frame;
    try { frame = JSON.parse(rawBuf.toString('utf8')); }
    catch { return console.log('✗ non-JSON frame:', rawBuf.toString('utf8')); }

    if (raw) {
        console.log(`[${ts()}]`, JSON.stringify(frame));
        return;
    }

    if (frame?.registered) {
        if (verbose || true) console.log(`[${ts()}] ✓ registered`, frame.registered);
        return;
    }
    if (frame?.success === false) {
        console.log(`[${ts()}] ✗ subscribe failed`, frame);
        return;
    }
    if (frame?.event !== 'device_resource_stream') {
        console.log(`[${ts()}] other event`, frame);
        return;
    }

    const device = frame.device;
    const signal = frame.signal || 'data';

    if (signal === 'error') {
        if (device) errorSeen.set(device, (errorSeen.get(device) || 0) + 1);
        scheduleErrorFlush();
        return;
    }

    if (signal !== 'data') {
        console.log(`[${ts()}] signal=${signal} device=${device}`, frame);
        return;
    }

    const payload = frame.payload;
    const value = getPath(payload, field);
    if (device != null) perDevice[device] = value;
    const agg = aggregate(Object.values(perDevice), aggregation);

    console.log(
        `[${ts()}] 📊 device=${device} ${field}=${JSON.stringify(value)}  ` +
        `fleet(${aggregation}, n=${Object.keys(perDevice).length})=${agg}`,
    );
});

ws.on('close', (code, reason) => {
    console.log(`✗ close code=${code} reason=${reason?.toString() || ''}`);
    process.exit(0);
});

ws.on('error', (err) => {
    console.error('✗ error', err?.message || err);
});

process.on('SIGINT', () => {
    console.log('\n→ closing');
    try { ws.close(); } catch { /* ignore */ }
});
