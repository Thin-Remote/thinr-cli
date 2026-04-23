import { useEffect, useState } from 'react';

// CDN endpoint that the agent itself polls for self-updates. Single source of
// truth for "what's the current stable release?" — same file agents see,
// which keeps the dashboard honest (we're not comparing against a different
// release source than the one the agents will actually pull from).
const LATEST_URL = 'https://get.thinremote.io/latest.json';

// 5 min matches the agent's self-update poll cadence — no point checking more
// often than that, and less often makes the dashboard feel stale after a
// release is cut.
const POLL_MS = 5 * 60 * 1000;

export function useLatestAgentVersion({ url = LATEST_URL, pollMs = POLL_MS } = {}) {
    const [latest, setLatest] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        let cancelled = false;
        const controller = new AbortController();

        async function load() {
            try {
                const res = await fetch(url, { signal: controller.signal });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                if (cancelled) return;
                setLatest(data?.version || null);
                setError(null);
            } catch (e) {
                if (cancelled || e.name === 'AbortError') return;
                setError(e.message || String(e));
            }
        }

        load();
        const id = setInterval(load, pollMs);
        return () => {
            cancelled = true;
            controller.abort();
            clearInterval(id);
        };
    }, [url, pollMs]);

    return { latest, error };
}
