import { useEffect, useState } from 'react';
import {
    fallbackLogsConfig,
    getProductLogs,
    resolveSourcePattern,
} from '../../../lib/product/logs.js';
import { debugLog } from '../../../lib/debug-log.js';

// Resolve the `logs` property of a product: a list of `{name, command}`
// sources the dashboard can stream. When the product has no property
// configured we fall back to the synthetic `system` source (journalctl)
// so the panel keeps working unchanged for products that have not opted
// in. The list rarely changes, so this hook loads it once per productId
// and ignores subsequent edits until the product changes.

// Pre-resolve each source's pattern (literal `pattern` or preset →
// pattern) so the panel never has to know about the preset catalog.
// `resolvedPattern` is `null` when the source carries neither, in
// which case the panel falls back to raw rendering.
function decorate(sources) {
    return sources.map((s) => ({
        ...s,
        resolvedPattern: resolveSourcePattern(s),
    }));
}

const FALLBACK = (() => {
    const cfg = fallbackLogsConfig();
    return { sources: decorate(cfg.sources), default: cfg.default, fallback: true };
})();

export function useProductLogSources(productId) {
    const [state, setState] = useState(() =>
        productId ? { sources: [], default: null, fallback: false, loading: true } : FALLBACK,
    );

    useEffect(() => {
        if (!productId) {
            setState(FALLBACK);
            return;
        }
        let cancelled = false;
        setState({ sources: [], default: null, fallback: false, loading: true });
        (async () => {
            const t0 = Date.now();
            try {
                const cfg = await getProductLogs(productId);
                if (cancelled) return;
                debugLog('http:product-logs', 'end', {
                    duration_ms: Date.now() - t0,
                    product: productId,
                    sources: cfg.sources.length,
                    fallback: !!cfg.__fallback,
                });
                setState({
                    sources: decorate(cfg.sources),
                    default: cfg.default || null,
                    fallback: !!cfg.__fallback,
                    loading: false,
                });
            } catch (err) {
                if (cancelled) return;
                debugLog('http:product-logs', 'error', {
                    product: productId,
                    error: err?.message || String(err),
                });
                setState({ ...FALLBACK, loading: false });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [productId]);

    return state;
}
