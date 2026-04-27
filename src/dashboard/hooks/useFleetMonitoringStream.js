import { useCallback, useEffect, useRef, useState } from 'react';
import WebSocket from 'ws';
import { readConfig } from '../../../lib/config.js';
import { getMonitoringData } from '../../../lib/monitoring.js';
import { debugCount, debugLog } from '../../../lib/debug-log.js';

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

const HISTORY = 40;
const BUCKET = 'monitoring';
const BASELINE_ITEMS = 500; // cap on devices returned in the one-shot snapshot.
// Fields pulled on baseline. The server drops rows where any of these is
// null, so keep to universal agent metrics — anything richer (temperature,
// network rates, etc.) comes via the WS stream.
const BASELINE_FIELDS = 'cpu.usage,memory.usage,disk.root.usage,uptime,agent.version';
const FLUSH_MS = 400; // coalesce bursts of writes before re-rendering.
const MAX_BACKOFF_MS = 30_000;
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
    const wsRef = useRef(null);
    const reconnectAttemptsRef = useRef(0);
    const disposedRef = useRef(false);

    // Key used to avoid re-fetching REST baseline if the device set didn't
    // change — useDevices polls every 15s so the array reference flips often.
    const onlineKey = devices
        .filter((d) => d.connection?.active)
        .map((d) => d.device)
        .sort()
        .join(',');

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

    // Persistent WS to /events with exponential backoff reconnect.
    useEffect(() => {
        disposedRef.current = false;

        function connect() {
            if (disposedRef.current) return;
            const config = readConfig();
            if (!config?.server || !config?.token || !config?.username) {
                setStatus('idle');
                return;
            }
            // Backend only accepts the JWT via `?authorization=` on this
            // endpoint — the Authorization header is rejected with 401 on
            // the WS upgrade.
            const url = `wss://${config.server}/v2/users/${config.username}/events?authorization=${config.token}`;
            setStatus('connecting');
            debugLog('ws:fleet', 'connecting', { url: `wss://${config.server}/v2/users/${config.username}/events` });
            const ws = new WebSocket(url);
            wsRef.current = ws;

            ws.on('open', () => {
                if (disposedRef.current) {
                    ws.close();
                    return;
                }
                reconnectAttemptsRef.current = 0;
                setStatus('open');
                debugLog('ws:fleet', 'open');
                const sub1 = { event: 'bucket_write', filters: { bucket: BUCKET } };
                const sub2 = { event: 'device_state_change' };
                debugLog('ws:fleet', 'subscribe', sub1);
                debugLog('ws:fleet', 'subscribe', sub2);
                ws.send(JSON.stringify(sub1));
                ws.send(JSON.stringify(sub2));
            });

            ws.on('message', (raw) => {
                const bytes = raw?.length ?? 0;
                debugCount('ws:fleet:bytes', bytes);
                debugCount('ws:fleet:frames');
                let frame;
                try {
                    frame = JSON.parse(raw.toString('utf8'));
                } catch {
                    return;
                }
                // Ignore subscribe acks.
                if (frame?.registered || frame?.success === false) {
                    debugLog('ws:fleet', 'ack', frame);
                    return;
                }

                if (frame?.event === 'bucket_write') {
                    debugCount('ws:fleet:bucket_write');
                    const data = frame.data;
                    const id = data?.device;
                    if (!id || !data) return;
                    pendingRef.current[id] = data;
                    if (flushTimerRef.current == null) {
                        flushTimerRef.current = setTimeout(flush, FLUSH_MS);
                    }
                    return;
                }

                if (frame?.event === 'device_state_change') {
                    debugCount('ws:fleet:device_state_change');
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
                    return;
                }
            });

            ws.on('error', (err) => {
                debugLog('ws:fleet', 'error', { error: err?.message || String(err) });
                // Surface via close — ws emits 'close' right after 'error'.
            });

            ws.on('close', (code, reason) => {
                wsRef.current = null;
                debugLog('ws:fleet', 'close', { code, reason: reason?.toString?.() });
                if (disposedRef.current) return;
                setStatus('retrying');
                const attempt = reconnectAttemptsRef.current++;
                const delay = Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS);
                debugLog('ws:fleet', 'reconnect-scheduled', { attempt, delay_ms: delay });
                setTimeout(connect, delay);
            });
        }

        connect();

        return () => {
            disposedRef.current = true;
            if (flushTimerRef.current) {
                clearTimeout(flushTimerRef.current);
                flushTimerRef.current = null;
            }
            if (wsRef.current) {
                try {
                    wsRef.current.close();
                } catch {
                    // ignore
                }
                wsRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
