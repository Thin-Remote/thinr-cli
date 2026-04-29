import { useEffect, useMemo, useState } from 'react';
import { getProduct } from '../../../lib/product.js';
import { debugLog } from '../../../lib/debug-log.js';

// Resolve product display names for every product present in the fleet.
// One REST call per product, in parallel; cached by id so re-renders don't
// re-fetch. Failures fall back silently to the id.

export function useFleetProducts(productIds) {
    const idsKey = useMemo(() => {
        if (!Array.isArray(productIds)) return '';
        return [...productIds].filter(Boolean).sort().join(',');
    }, [productIds]);
    const ids = useMemo(() => (idsKey ? idsKey.split(',') : []), [idsKey]);

    const [products, setProducts] = useState({});

    useEffect(() => {
        if (ids.length === 0) {
            setProducts({});
            return;
        }
        let cancelled = false;
        (async () => {
            const t0 = Date.now();
            debugLog('http:fleet-products', 'start', { products: ids });
            const entries = await Promise.all(
                ids.map(async (id) => {
                    try {
                        const data = await getProduct(id);
                        return [id, { id, name: data?.name || id }];
                    } catch (e) {
                        debugLog('http:fleet-products', 'error', {
                            product: id,
                            error: e?.message || String(e),
                        });
                        return [id, { id, name: id }];
                    }
                }),
            );
            if (cancelled) return;
            debugLog('http:fleet-products', 'end', {
                duration_ms: Date.now() - t0,
                products: ids,
            });
            setProducts(Object.fromEntries(entries));
        })();
        return () => {
            cancelled = true;
        };
    }, [ids]);

    return products;
}
