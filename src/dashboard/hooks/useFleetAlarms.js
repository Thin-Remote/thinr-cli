import { useEffect, useRef, useState } from 'react';
import { getAlarmInstances, ALARM_STATE } from '../../../lib/alarms.js';
import { eventStream } from '../../../lib/dashboard/event-stream.js';
import { debugLog } from '../../../lib/debug-log.js';

// Live view of server-side alarm instances. One REST call at mount to seed
// the list with every non-cleared instance, then four WS subscriptions on
// the shared /v2/.../events socket for deltas:
//   - alarm_instance_activate   → upsert (rule fired, new instance)
//   - alarm_instance_normalize  → drop (instance auto-cleared by the rule)
//   - alarm_instance_update     → upsert, or drop if the new state is CLEARED
//                                 (covers manual ack/shelve/latch and manual
//                                 clears via the user_resource update event)
//   - alarm_instance_delete     → drop (instance purged from history)
// The backend merges the instance fields (instance, alarm, state, …) into
// the top-level frame instead of wrapping them under a `.data` envelope
// (compare buckets.cpp::get_write_event_data, which does wrap). So the
// frame itself is the instance document — we just strip the meta fields
// (event, ts, user) the events_pool injects before storing it.
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

// Strip the meta fields events_pool injects (event/ts/user) so the rest
// of the hook treats WS frames identically to REST snapshot rows.
function frameToInstance(frame) {
    if (!frame || typeof frame !== 'object') return null;
    const { event: _e, ts: _ts, user: _u, ...inst } = frame;
    return inst;
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
            const inst = frameToInstance(frame);
            const k = instanceKey(inst);
            if (!k) return;
            mapRef.current.set(k, inst);
            commit();
        });
        const offNormalize = eventStream.on('alarm_instance_normalize', (frame) => {
            const inst = frameToInstance(frame);
            const k = instanceKey(inst);
            if (!k) return;
            // Normalize transitions the instance to CLEARED. Drop it from
            // the active list — the AlertsTab only shows what's outstanding.
            if (mapRef.current.delete(k)) commit();
        });
        const offUpdate = eventStream.on('alarm_instance_update', (frame) => {
            const inst = frameToInstance(frame);
            const k = instanceKey(inst);
            if (!k) return;
            // Manual transitions (ack, shelve, latch, annotate, reactivation
            // change) come through here. A manual clear lands here too — the
            // AlertsTab only tracks outstanding alarms, so drop those.
            if (inst?.state === ALARM_STATE.CLEARED) {
                if (mapRef.current.delete(k)) commit();
            } else {
                mapRef.current.set(k, inst);
                commit();
            }
        });
        const offDelete = eventStream.on('alarm_instance_delete', (frame) => {
            const inst = frameToInstance(frame);
            const k = instanceKey(inst);
            if (!k) return;
            if (mapRef.current.delete(k)) commit();
        });

        eventStream.subscribe({ event: 'alarm_instance_activate' });
        eventStream.subscribe({ event: 'alarm_instance_normalize' });
        eventStream.subscribe({ event: 'alarm_instance_update' });
        eventStream.subscribe({ event: 'alarm_instance_delete' });
        debugLog('ws:alarms', 'subscribed');

        // If the socket drops and reopens we may have missed events. Pull a
        // fresh snapshot to recover authoritative state — bumping the reload
        // token is enough; the snapshot effect handles the rest.
        const offReconnect = eventStream.onReconnect(() => {
            debugLog('ws:alarms', 'resync-on-reconnect');
            setReloadToken((n) => n + 1);
        });

        return () => {
            offActivate();
            offNormalize();
            offUpdate();
            offDelete();
            offReconnect();
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
