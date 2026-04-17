import { useEffect, useRef, useState } from 'react';
import { getMonitoringData } from '../../../lib/monitoring.js';

const HISTORY = 60;

export function useMonitoring(deviceId, { pollMs = 5000 } = {}) {
    const [latest, setLatest] = useState(null);
    const [history, setHistory] = useState({ cpu: [], mem: [], disk: [] });
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    const historyRef = useRef({ cpu: [], mem: [], disk: [] });

    useEffect(() => {
        if (!deviceId) {
            setLatest(null);
            setHistory({ cpu: [], mem: [], disk: [] });
            historyRef.current = { cpu: [], mem: [], disk: [] };
            return;
        }

        let cancelled = false;
        setLoading(true);
        historyRef.current = { cpu: [], mem: [], disk: [] };
        setHistory(historyRef.current);

        async function load() {
            try {
                const res = await getMonitoringData({
                    device: deviceId,
                    items: 1,
                    sort: 'desc',
                });
                if (cancelled) return;
                const sample = Array.isArray(res) && res.length ? res[0] : null;
                setLatest(sample);
                setError(null);
                if (sample) {
                    const push = (arr, v) => {
                        const next = [...arr, v == null ? null : Number(v)];
                        return next.length > HISTORY ? next.slice(-HISTORY) : next;
                    };
                    historyRef.current = {
                        cpu: push(historyRef.current.cpu, sample.cpu?.usage),
                        mem: push(historyRef.current.mem, sample.memory?.usage),
                        disk: push(historyRef.current.disk, sample.disk?.root?.usage),
                    };
                    setHistory(historyRef.current);
                }
            } catch (e) {
                if (cancelled) return;
                setError(e.message || String(e));
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        load();
        const id = setInterval(load, pollMs);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [deviceId, pollMs]);

    return { latest, history, error, loading };
}
