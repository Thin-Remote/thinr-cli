import { useEffect, useState } from 'react';
import { getDevices } from '../../../lib/devices.js';

export function useDevices({ pollMs = 15000 } = {}) {
    const [devices, setDevices] = useState([]);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            try {
                const list = await getDevices({});
                if (cancelled) return;
                setDevices(list);
                setError(null);
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
    }, [pollMs]);

    return { devices, error, loading };
}
