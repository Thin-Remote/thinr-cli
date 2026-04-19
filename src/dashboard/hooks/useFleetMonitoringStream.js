import { useEffect, useRef, useState } from 'react';
import WebSocket from 'ws';
import { readConfig } from '../../../lib/config.js';
import { getMonitoringData } from '../../../lib/monitoring.js';
import { runPool } from '../../../lib/concurrency.js';

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
const CONCURRENCY = 8;
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
    const [events, setEvents] = useState([]);
    const [status, setStatus] = useState('idle');

    const samplesRef = useRef({});
    const historyRef = useRef({ cpu: [], mem: [], disk: [] });
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
    useEffect(() => {
        const ids = onlineKey ? onlineKey.split(',') : [];
        const missing = ids.filter((id) => !samplesRef.current[id]);
        if (missing.length === 0) return;
        let cancelled = false;
        (async () => {
            const results = await runPool(missing, CONCURRENCY, async (id) => {
                try {
                    const data = await getMonitoringData({
                        device: id,
                        items: 1,
                        sort: 'desc',
                    });
                    return Array.isArray(data) && data.length ? data[0] : null;
                } catch {
                    return null;
                }
            });
            if (cancelled) return;
            const updates = {};
            missing.forEach((id, i) => {
                const r = results[i];
                const s = r && r.ok ? r.value : null;
                if (s) updates[id] = s;
            });
            if (Object.keys(updates).length === 0) return;
            applyUpdates(updates);
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
            const ws = new WebSocket(url);
            wsRef.current = ws;

            ws.on('open', () => {
                if (disposedRef.current) {
                    ws.close();
                    return;
                }
                reconnectAttemptsRef.current = 0;
                setStatus('open');
                ws.send(
                    JSON.stringify({
                        event: 'bucket_write',
                        filters: { bucket: BUCKET },
                    }),
                );
                ws.send(
                    JSON.stringify({
                        event: 'device_state_change',
                    }),
                );
            });

            ws.on('message', (raw) => {
                let frame;
                try {
                    frame = JSON.parse(raw.toString('utf8'));
                } catch {
                    return;
                }
                // Ignore subscribe acks.
                if (frame?.registered || frame?.success === false) return;

                if (frame?.event === 'bucket_write') {
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

            ws.on('error', () => {
                // Surface via close — ws emits 'close' right after 'error'.
            });

            ws.on('close', () => {
                wsRef.current = null;
                if (disposedRef.current) return;
                setStatus('retrying');
                const attempt = reconnectAttemptsRef.current++;
                const delay = Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS);
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
        pushHistory();
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

    return { samples, history, events, status };
}
