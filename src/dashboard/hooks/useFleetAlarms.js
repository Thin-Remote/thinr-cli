import { useEffect, useRef, useState } from 'react';
import { getAlarmInstances, ALARM_STATE } from '../../../lib/alarms.js';
import { eventStream } from '../../../lib/dashboard/event-stream.js';
import { debugLog } from '../../../lib/debug-log.js';

// Live view of server-side alarm instances. One REST call at mount to seed
// the list with every non-cleared instance, then two WS subscriptions on
// the shared /v2/.../events socket for deltas:
//   - alarm_instance_activate   → upsert
//   - alarm_instance_normalize  → drop (instance transitions to CLEARED)
// Both frames carry the full instance document under `frame.data`, mirroring
// what the REST endpoint returns, so we can store them as-is.
//
// Returns { instances, loading, error, refresh } where `instances` is a
// stable array sorted with the same rule the server uses by default
// (state asc, severity desc, created desc) so the UI doesn't reshuffle
// rows on every delta.

const ACTIVE_STATES = [
    ALARM_STATE.NONE,
    ALARM_STATE.ACTIVATED,
    ALARM_STATE.ACKNOWLEDGED,
    ALARM_STATE.LATCHED,
    ALARM_STATE.SHELVED,
];

function instanceKey(inst) {
    return inst?.instance || inst?._id || null;
}

function createdMs(inst) {
    const v = inst?.created;
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    // Server sometimes serialises dates as { $date: ... } via DB_DATE — accept both.
    if (typeof v === 'object') {
        if (typeof v.$date === 'number') return v.$date;
        if (typeof v.$date === 'string') {
            const t = Date.parse(v.$date);
            return Number.isFinite(t) ? t : 0;
        }
    }
    if (typeof v === 'string') {
        const t = Date.parse(v);
        return Number.isFinite(t) ? t : 0;
    }
    return 0;
}

function compareInstances(a, b) {
    const sa = a?.state ?? 0;
    const sb = b?.state ?? 0;
    if (sa !== sb) return sa - sb;
    const va = a?.severity ?? 0;
    const vb = b?.severity ?? 0;
    if (va !== vb) return vb - va;
    return createdMs(b) - createdMs(a);
}

function toSortedArray(map) {
    return [...map.values()].sort(compareInstances);
}

export function useFleetAlarms() {
    const [instances, setInstances] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [reloadToken, setReloadToken] = useState(0);
    const mapRef = useRef(new Map());

    function commit() {
        setInstances(toSortedArray(mapRef.current));
    }

    // REST snapshot. Pulls everything except CLEARED so the WS deltas only
    // need to handle additions/removals. The server's default sort already
    // puts non-confirmed/active first, so a single page is enough for the
    // typical fleet — bump `count` if that stops holding.
    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        (async () => {
            const t0 = Date.now();
            debugLog('http:alarms', 'snapshot-start');
            try {
                const data = await getAlarmInstances({
                    count: 500,
                    state: ACTIVE_STATES,
                });
                debugLog('http:alarms', 'snapshot-end', {
                    duration_ms: Date.now() - t0,
                    rows: data.length,
                });
                if (cancelled) return;
                const next = new Map();
                for (const inst of data) {
                    const k = instanceKey(inst);
                    if (k) next.set(k, inst);
                }
                mapRef.current = next;
                commit();
                setLoading(false);
            } catch (err) {
                debugLog('http:alarms', 'snapshot-error', {
                    duration_ms: Date.now() - t0,
                    error: err?.message || String(err),
                });
                if (cancelled) return;
                setError(err);
                setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [reloadToken]);

    // WS deltas. The shared event-stream is ref-counted; connect/disconnect
    // here just bumps that counter.
    useEffect(() => {
        eventStream.connect();

        const offActivate = eventStream.on('alarm_instance_activate', (frame) => {
            const inst = frame?.data;
            const k = instanceKey(inst);
            if (!k) return;
            mapRef.current.set(k, inst);
            commit();
        });
        const offNormalize = eventStream.on('alarm_instance_normalize', (frame) => {
            const inst = frame?.data;
            const k = instanceKey(inst);
            if (!k) return;
            // Normalize transitions the instance to CLEARED. Drop it from
            // the active list — the AlertsTab only shows what's outstanding.
            if (mapRef.current.delete(k)) commit();
        });

        eventStream.subscribe({ event: 'alarm_instance_activate' });
        eventStream.subscribe({ event: 'alarm_instance_normalize' });
        debugLog('ws:alarms', 'subscribed');

        return () => {
            offActivate();
            offNormalize();
            eventStream.disconnect();
        };
    }, []);

    return {
        instances,
        loading,
        error,
        refresh: () => setReloadToken((n) => n + 1),
    };
}
