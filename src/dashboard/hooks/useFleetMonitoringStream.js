import { useCallback, useEffect, useRef, useState } from 'react';
import { getMonitoringData } from '../../../lib/monitoring.js';
import { debugLog } from '../../../lib/debug-log.js';
import { eventStream } from '../../../lib/dashboard/event-stream.js';

// Fleet-wide monitoring + connection events driven by the user-level
// /v2/.../events websocket. A single persistent socket carries two
// subscriptions:
//   - `bucket_write` filtered by `bucket: monitoring` → per-device sample
//   - `device_state_change` unfiltered → connect/disconnect/sleep events
// A REST snapshot runs at startup so the UI has a baseline before the first
// live frame arrives (the event stream has no backfill semantics).
//
// Frame shapes (observed on thinger.thinr.io):
//   bucket_write:        { event, user, bucket, ts, data: { device, cpu,
//                          memory, disk, load, network, agent, ... } }
//   device_state_change: { event, user, ts, device, product?, state }
//   state ∈ connected | disconnected | resumed | awake | asleep

// Last 30 minutes of per-device CPU history (one point per minute, since
// agents publish at that cadence). Keeps the per-device sparklines and
// the rolling fleet-wide chart on a clean half-hour window.
const HISTORY = 30;
const BUCKET = 'monitoring';
const BASELINE_ITEMS = 500; // cap on devices returned in the one-shot snapshot.
// Fields pulled on baseline. The server drops rows where any of these is
// null, so keep to universal agent metrics — anything richer (temperature,
// network rates, etc.) comes via the WS stream.
const BASELINE_FIELDS = 'cpu.usage,memory.usage,disk.root.usage,uptime,agent.version';
// Bound the baseline to recent samples. Without a time range the Mongo
// `group_by=device` pipeline does a $sort over the whole bucket history
// before $group/$first, which scales linearly with the number of fields
// and trips the 10s gateway timeout once we ask for ~5 fields. Agents
// publish every minute, so a five-minute window guarantees we catch
// every active device while keeping the server-side sort tiny.
const BASELINE_WINDOW_MIN = 5;
const FLUSH_MS = 400; // coalesce bursts of writes before re-rendering.
const MAX_EVENTS = 80;

function tsStr(ts) {
    const d = ts ? new Date(Number(ts)) : new Date();
    return d.toTimeString().slice(0, 8);
}

function mapState(state) {
    if (state === 'connected') return { kind: 'join', msg: 'connected' };
    if (state === 'disconnected') return { kind: 'leave', msg: 'disconnected' };
    if (state === 'resumed') return { kind: 'info', msg: 'resumed' };
    if (state === 'awake') return { kind: 'info', msg: 'awake' };
    if (state === 'asleep') return { kind: 'info', msg: 'asleep' };
    return { kind: 'info', msg: state || 'state' };
}

export function useFleetMonitoringStream(devices) {
    const [samples, setSamples] = useState({});
    const [history, setHistory] = useState({ cpu: [], mem: [], disk: [] });
    const [cpuHistory, setCpuHistory] = useState({});
    const [events, setEvents] = useState([]);
    const [status, setStatus] = useState('idle');

    const samplesRef = useRef({});
    const historyRef = useRef({ cpu: [], mem: [], disk: [] });
    const cpuHistoryRef = useRef({});
    const pendingRef = useRef({});
    const flushTimerRef = useRef(null);

    // Key used to avoid re-fetching REST baseline if the device set didn't
    // change — useDevices polls every 15s so the array reference flips often.
    const onlineKey = devices
        .filter((d) => d.connection?.active)
        .map((d) => d.device)
        .sort()
        .join(',');

    // History pre-fill — per-minute averages over the last 40 minutes so
    // the per-device CPU sparklines have shape on dashboard open instead
    // of starting empty. The server's `agg + group_by` path skips the
    // pre-group sort entirely, so it stays fast (~900ms for 99 devices)
    // even though the time range is 40 min wide. WS frames take over on
    // top once they start arriving.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const t0 = Date.now();
            debugLog('http:fleet-history', 'start', { window_min: HISTORY });
            try {
                const data = await getMonitoringData({
                    minutes: HISTORY,
                    group_by: 'device',
                    agg: '1m',
                    agg_type: 'avg',
                    fields: 'cpu.usage',
                });
                debugLog('http:fleet-history', 'end', {
                    duration_ms: Date.now() - t0,
                    rows: Array.isArray(data) ? data.length : 0,
                });
                if (cancelled || !Array.isArray(data) || data.length === 0) return;
                const byDevice = new Map();
                for (const r of data) {
                    const id = r.device;
                    if (!id) continue;
                    const v = r?.cpu?.usage;
                    if (!Number.isFinite(Number(v))) continue;
                    if (!byDevice.has(id)) byDevice.set(id, []);
                    byDevice.get(id).push({ ts: Number(r.ts), v: Number(v) });
                }
                const next = { ...cpuHistoryRef.current };
                for (const [id, rows] of byDevice.entries()) {
                    rows.sort((a, b) => a.ts - b.ts);
                    const series = rows.slice(-HISTORY).map((r) => r.v);
                    // Don't clobber a series the WS already populated past
                    // what the baseline can offer.
                    if (!next[id] || next[id].length < series.length) {
                        next[id] = series;
                    }
                }
                cpuHistoryRef.current = next;
                setCpuHistory(next);
            } catch (err) {
                debugLog('http:fleet-history', 'error', {
                    duration_ms: Date.now() - t0,
                    error: err?.message || String(err),
                });
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // REST baseline — one sample per online device on first appearance.
    // Single multi-device call: with no `device` the helper defaults to
    // group_by=device and the server returns the latest sample per device.
    useEffect(() => {
        const ids = onlineKey ? onlineKey.split(',') : [];
        const missing = ids.filter((id) => !samplesRef.current[id]);
        if (missing.length === 0) return;
        let cancelled = false;
        (async () => {
            const t0 = Date.now();
            debugLog('http:fleet-baseline', 'start', { missing: missing.length });
            try {
                const data = await getMonitoringData({
                    items: BASELINE_ITEMS,
                    sort: 'desc',
                    fields: BASELINE_FIELDS,
                    minutes: BASELINE_WINDOW_MIN,
                });
                debugLog('http:fleet-baseline', 'end', {
                    duration_ms: Date.now() - t0,
                    rows: Array.isArray(data) ? data.length : 0,
                });
                if (cancelled || !Array.isArray(data)) return;
                const missingSet = new Set(missing);
                const updates = {};
                for (const sample of data) {
                    const id = sample?.device;
                    if (!id || !missingSet.has(id)) continue;
                    updates[id] = sample;
                }
                if (Object.keys(updates).length === 0) return;
                applyUpdates(updates);
            } catch (err) {
                debugLog('http:fleet-baseline', 'error', {
                    duration_ms: Date.now() - t0,
                    error: err?.message || String(err),
                });
                // Baseline is best-effort; the WS stream will fill samples in.
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onlineKey]);

    // Subscribe via the shared event stream. We don't own the socket;
    // the singleton multiplexes fleet monitoring with product metrics
    // so dashboard load = 1 WS, not N.
    useEffect(() => {
        eventStream.connect();
        setStatus('connecting');

        const offBucket = eventStream.on('bucket_write', (frame) => {
            const data = frame.data;
            const id = data?.device;
            if (!id || !data) return;
            pendingRef.current[id] = data;
            if (flushTimerRef.current == null) {
                flushTimerRef.current = setTimeout(flush, FLUSH_MS);
            }
        });
        const offState = eventStream.on('device_state_change', (frame) => {
            const id = frame.device;
            if (!id) return;
            const mapped = mapState(frame.state);
            const ev = {
                t: tsStr(frame.ts),
                kind: mapped.kind,
                dev: id,
                msg: mapped.msg,
            };
            setEvents((cur) => [ev, ...cur].slice(0, MAX_EVENTS));
        });

        eventStream.subscribe({ event: 'bucket_write', filters: { bucket: BUCKET } });
        eventStream.subscribe({ event: 'device_state_change' });
        // Surface a coarse status — the singleton handles the
        // open/close/retry lifecycle internally.
        setStatus('open');
        debugLog('ws:fleet', 'subscribed-via-shared-stream');

        return () => {
            offBucket();
            offState();
            if (flushTimerRef.current) {
                clearTimeout(flushTimerRef.current);
                flushTimerRef.current = null;
            }
            eventStream.disconnect();
        };
    }, []);

    function flush() {
        flushTimerRef.current = null;
        const updates = pendingRef.current;
        pendingRef.current = {};
        if (Object.keys(updates).length === 0) return;
        applyUpdates(updates);
    }

    function applyUpdates(updates) {
        const next = { ...samplesRef.current, ...updates };
        samplesRef.current = next;
        setSamples(next);
        pushDeviceCpu(updates);
        pushHistory();
    }

    function pushDeviceCpu(updates) {
        const next = { ...cpuHistoryRef.current };
        let changed = false;
        for (const [id, s] of Object.entries(updates)) {
            const v = s?.cpu?.usage;
            if (v == null || !Number.isFinite(Number(v))) continue;
            const arr = next[id] ? next[id].slice() : [];
            arr.push(Number(v));
            if (arr.length > HISTORY) arr.splice(0, arr.length - HISTORY);
            next[id] = arr;
            changed = true;
        }
        if (!changed) return;
        cpuHistoryRef.current = next;
        setCpuHistory(next);
    }

    function pushHistory() {
        let cpu = 0,
            mem = 0,
            disk = 0;
        let cn = 0,
            mn = 0,
            dn = 0;
        for (const s of Object.values(samplesRef.current)) {
            if (s.cpu?.usage != null) {
                cpu += Number(s.cpu.usage);
                cn++;
            }
            if (s.memory?.usage != null) {
                mem += Number(s.memory.usage);
                mn++;
            }
            if (s.disk?.root?.usage != null) {
                disk += Number(s.disk.root.usage);
                dn++;
            }
        }
        const push = (arr, v) => {
            const out = [...arr, v];
            return out.length > HISTORY ? out.slice(-HISTORY) : out;
        };
        const next = {
            cpu: push(historyRef.current.cpu, cn ? cpu / cn : null),
            mem: push(historyRef.current.mem, mn ? mem / mn : null),
            disk: push(historyRef.current.disk, dn ? disk / dn : null),
        };
        historyRef.current = next;
        setHistory(next);
    }

    // Push a synthetic event into the same stream the WS uses. The EVENTS
    // panel doesn't care where a row came from — this lets the upgrade
    // controller surface progress and failures next to connect/disconnect
    // events without keeping a separate panel.
    const pushEvent = useCallback((ev) => {
        const frame = {
            t: tsStr(ev.ts || Date.now()),
            kind: ev.kind || 'info',
            dev: ev.dev || '',
            msg: ev.msg || '',
        };
        setEvents((cur) => [frame, ...cur].slice(0, MAX_EVENTS));
    }, []);

    return { samples, history, cpuHistory, events, status, pushEvent };
}
