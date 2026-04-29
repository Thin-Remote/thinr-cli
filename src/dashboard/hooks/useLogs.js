import { useCallback, useEffect, useRef, useState } from 'react';
import { createDeviceAPI } from '../../../lib/device-api.js';
import { FALLBACK_LOGS_COMMAND } from '../../../lib/product/logs.js';

const MAX_LINES = 500;

export function useLogs({ deviceId, online, paused, command }) {
    const [lines, setLines] = useState([]);
    const [status, setStatus] = useState('idle'); // idle | connecting | streaming | ended | error
    const [error, setError] = useState(null);
    const bufferRef = useRef([]);
    const remainderRef = useRef('');

    const clear = useCallback(() => {
        bufferRef.current = [];
        remainderRef.current = '';
        setLines([]);
    }, []);

    const effectiveCmd = command || FALLBACK_LOGS_COMMAND;

    useEffect(() => {
        bufferRef.current = [];
        remainderRef.current = '';
        setLines([]);
        setError(null);

        if (!deviceId) {
            setStatus('idle');
            return;
        }
        if (!online) {
            setStatus('idle');
            return;
        }
        if (paused) {
            setStatus('idle');
            return;
        }

        let cancelFn = null;
        let cancelled = false;
        setStatus('connecting');

        function pushChunk(chunk, streamLabel) {
            const text = remainderRef.current + chunk;
            const parts = text.split('\n');
            remainderRef.current = parts.pop() ?? '';
            if (parts.length === 0) return;
            const next = [...bufferRef.current];
            for (const ln of parts) {
                next.push({ text: ln, stream: streamLabel });
            }
            if (next.length > MAX_LINES) next.splice(0, next.length - MAX_LINES);
            bufferRef.current = next;
            setLines(next);
            setStatus('streaming');
        }

        (async () => {
            try {
                const api = createDeviceAPI(deviceId);
                const result = await api.execStream(effectiveCmd, {
                    onStdout: (s) => !cancelled && pushChunk(s, 'out'),
                    onStderr: (s) => !cancelled && pushChunk(s, 'err'),
                    onCancel: (fn) => {
                        cancelFn = fn;
                    },
                });
                if (cancelled) return;
                if (result.timedOut) setError('log stream timed out');
                else if (result.exitCode != null && result.exitCode !== 0)
                    setError(`log stream exited with code ${result.exitCode}`);
                setStatus('ended');
            } catch (e) {
                if (cancelled) return;
                setError(e.message || String(e));
                setStatus('error');
            }
        })();

        return () => {
            cancelled = true;
            if (cancelFn) {
                try {
                    cancelFn();
                } catch {
                    // ignore
                }
            }
        };
    }, [deviceId, online, paused, effectiveCmd]);

    return { lines, status, error, clear };
}
