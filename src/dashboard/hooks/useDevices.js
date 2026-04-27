import { useEffect, useState } from 'react';
import { getDevices } from '../../../lib/devices.js';
import { debugCount, debugLog } from '../../../lib/debug-log.js';

export function useDevices({ pollMs = 15000 } = {}) {
    const [devices, setDevices] = useState([]);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            const t0 = Date.now();
            debugCount('http:devices');
            try {
                const list = await getDevices({});
                debugLog('http:devices', 'end', {
                    duration_ms: Date.now() - t0,
                    count: list?.length ?? 0,
                });
                if (cancelled) return;
                setDevices(list);
                setError(null);
            } catch (e) {
                debugLog('http:devices', 'error', {
                    duration_ms: Date.now() - t0,
                    error: e?.message || String(e),
                });
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
    }, [pollMs]);

    return { devices, error, loading };
}
