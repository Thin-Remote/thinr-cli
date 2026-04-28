import { useCallback, useEffect, useRef, useState } from 'react';
import {
    deleteProductPlaybook,
    listProductPlaybooks,
    readProductPlaybook,
} from '../../../lib/product.js';
import {
    listStorageFiles,
    readStorageFile,
} from '../../../lib/storage.js';
import { parsePlaybook } from '../../../lib/playbook/loader.js';
import { debugCount, debugLog } from '../../../lib/debug-log.js';

const RUNS_PREFIX = 'playbooks/runs/';

function isRunFile(f, name) {
    if (!f || f.type !== 'file') return false;
    if (!f.path?.startsWith(RUNS_PREFIX)) return false;
    if (!name) return true;
    return f.name?.includes(`-${name}-`) || f.name?.startsWith(`${name}-`);
}

/**
 * Reads the playbook index of a product. The list rarely changes (only
 * when a human or assistant uploads/deletes one), so we don't poll —
 * the index loads once on mount and on demand via `refresh()`. The
 * tab's `R` shortcut and any local action that mutates the index
 * (upload/delete/rollout) call refresh themselves.
 *
 * Also exposes parsed-on-demand detail (YAML text + parsed structure)
 * and a list of run reports, both populated when a playbook is selected.
 */
export function useProductPlaybooks(productId) {
    const [playbooks, setPlaybooks] = useState([]);
    const [listError, setListError] = useState(null);
    const [loading, setLoading] = useState(true);
    const [detail, setDetail] = useState(null);
    const [reports, setReports] = useState([]);
    const [reportsError, setReportsError] = useState(null);
    const [reportDetail, setReportDetail] = useState(null);
    const [reloadToken, setReloadToken] = useState(0);
    const detailReq = useRef(0);
    const reportsReq = useRef(0);
    const reportReq = useRef(0);

    const refresh = useCallback(() => setReloadToken((t) => t + 1), []);

    useEffect(() => {
        if (!productId) {
            setPlaybooks([]);
            setListError(null);
            setLoading(false);
            return;
        }
        let cancelled = false;
        setLoading(true);
        async function load() {
            const t0 = Date.now();
            debugCount('http:playbook-index');
            try {
                const list = await listProductPlaybooks(productId);
                debugLog('http:playbook-index', 'end', {
                    duration_ms: Date.now() - t0,
                    product: productId,
                    count: list?.length ?? 0,
                });
                if (cancelled) return;
                setPlaybooks(list);
                setListError(null);
            } catch (err) {
                debugLog('http:playbook-index', 'error', {
                    duration_ms: Date.now() - t0,
                    product: productId,
                    error: err?.message || String(err),
                });
                if (cancelled) return;
                setListError(err?.message || String(err));
            } finally {
                if (!cancelled) setLoading(false);
            }
        }
        load();
        return () => {
            cancelled = true;
        };
    }, [productId, reloadToken]);

    const loadDetail = useCallback(async (name) => {
        if (!productId || !name) {
            setDetail(null);
            return;
        }
        const reqId = ++detailReq.current;
        setDetail({ name, loading: true, error: null, yaml: null, parsed: null });
        try {
            const yaml = await readProductPlaybook(productId, name);
            if (detailReq.current !== reqId) return;
            let parsed = null;
            let parseError = null;
            try {
                parsed = parsePlaybook(yaml, { sourcePath: `${name}.yaml` });
            } catch (err) {
                parseError = err?.message || String(err);
            }
            if (detailReq.current !== reqId) return;
            setDetail({
                name,
                loading: false,
                yaml,
                parsed,
                error: null,
                parseError,
            });
        } catch (err) {
            if (detailReq.current !== reqId) return;
            setDetail({
                name,
                loading: false,
                yaml: null,
                parsed: null,
                error: err?.message || String(err),
                parseError: null,
            });
        }
    }, [productId]);

    const clearDetail = useCallback(() => {
        detailReq.current++;
        setDetail(null);
    }, []);

    const loadReports = useCallback(
        async (name) => {
            if (!productId) {
                setReports([]);
                setReportsError(null);
                return;
            }
            const reqId = ++reportsReq.current;
            try {
                const files = await listStorageFiles(productId);
                if (reportsReq.current !== reqId) return;
                const filtered = (files || [])
                    .filter((f) => isRunFile(f, name))
                    .map((f) => ({ name: f.name, path: f.path, size: f.size }))
                    .sort((a, b) => b.name.localeCompare(a.name));
                setReports(filtered);
                setReportsError(null);
            } catch (err) {
                if (reportsReq.current !== reqId) return;
                if (/not found|404/i.test(err?.message || '')) {
                    setReports([]);
                    setReportsError(null);
                } else {
                    setReports([]);
                    setReportsError(err?.message || String(err));
                }
            }
        },
        [productId],
    );

    const loadReport = useCallback(
        async (path) => {
            if (!productId || !path) {
                setReportDetail(null);
                return;
            }
            const reqId = ++reportReq.current;
            setReportDetail({ path, loading: true, report: null, error: null });
            try {
                const text = await readStorageFile(productId, path);
                if (reportReq.current !== reqId) return;
                let parsed = null;
                let parseError = null;
                try {
                    parsed = JSON.parse(text);
                } catch (err) {
                    parseError = err?.message || String(err);
                }
                setReportDetail({
                    path,
                    loading: false,
                    report: parsed,
                    raw: text,
                    error: parseError,
                });
            } catch (err) {
                if (reportReq.current !== reqId) return;
                setReportDetail({
                    path,
                    loading: false,
                    report: null,
                    error: err?.message || String(err),
                });
            }
        },
        [productId],
    );

    const clearReport = useCallback(() => {
        reportReq.current++;
        setReportDetail(null);
    }, []);

    const remove = useCallback(
        async (name) => {
            if (!productId || !name) return { ok: false, error: 'missing-input' };
            try {
                const res = await deleteProductPlaybook({ product: productId, name });
                setPlaybooks((prev) => prev.filter((p) => p.name !== name));
                detailReq.current++;
                setDetail(null);
                return { ok: true, result: res };
            } catch (err) {
                return { ok: false, error: err?.message || String(err) };
            }
        },
        [productId],
    );

    return {
        playbooks,
        listError,
        loading,
        detail,
        reports,
        reportsError,
        reportDetail,
        loadDetail,
        clearDetail,
        loadReports,
        loadReport,
        clearReport,
        remove,
        refresh,
    };
}
