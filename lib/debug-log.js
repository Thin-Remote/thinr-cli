// @ts-check
import { createWriteStream, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Opt-in JSONL logger for diagnosing dashboard backend load. Activates only
// when `THINR_DEBUG` is set to a truthy string. Writes to
// `~/.thinr/dashboard-debug.log` so it never collides with the Ink alt-screen.
//
// API:
//   debugLog(category, msg, data?) — one line per event
//   debugCount(key, n = 1)         — bump a counter; flushed every 5s in a
//                                    `summary` line and then reset, so the
//                                    log shows event rates without one row
//                                    per high-frequency frame.
//   isDebugEnabled()
//
// Each line is JSON:
//   { t: <iso>, c: <category>, m: <msg>, d?: <data> }
//   { t: <iso>, c: 'summary', d: { '<key>': <count>, ... } }

const SUMMARY_MS = 5_000;

let stream = null;
let enabled = null;
let counters = new Map();
let summaryTimer = null;

function init() {
    if (enabled !== null) return;
    enabled = !!process.env.THINR_DEBUG;
    if (!enabled) return;
    const dir = join(homedir(), '.thinr');
    try {
        mkdirSync(dir, { recursive: true });
    } catch {
        // best-effort; if creation fails the createWriteStream below will
        // also fail and we silently disable.
    }
    const path = join(dir, 'dashboard-debug.log');
    try {
        stream = createWriteStream(path, { flags: 'w' });
    } catch {
        enabled = false;
        return;
    }
    write({
        t: new Date().toISOString(),
        c: 'init',
        m: 'log open',
        d: { pid: process.pid, mode: process.env.THINR_DEBUG },
    });
    summaryTimer = setInterval(flushSummary, SUMMARY_MS);
    summaryTimer.unref?.();
}

function write(obj) {
    if (!stream) return;
    try {
        stream.write(JSON.stringify(obj) + '\n');
    } catch {
        // ignore — better to drop a line than crash the dashboard.
    }
}

function flushSummary() {
    if (!enabled || counters.size === 0) return;
    const d = Object.fromEntries(counters);
    counters = new Map();
    write({ t: new Date().toISOString(), c: 'summary', d });
}

export function debugLog(category, msg, data) {
    init();
    if (!enabled) return;
    write({
        t: new Date().toISOString(),
        c: category,
        m: msg,
        ...(data !== undefined ? { d: data } : {}),
    });
}

export function debugCount(key, n = 1) {
    init();
    if (!enabled) return;
    counters.set(key, (counters.get(key) || 0) + n);
}

export function isDebugEnabled() {
    init();
    return !!enabled;
}
