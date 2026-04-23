import { useCallback, useRef, useState } from 'react';
import { runFleetUpgrade, summarize } from '../../../lib/fleet-upgrade.js';

const DONE_TOAST_MS = 8000;

// Encapsulates the "upgrade the fleet" state machine so App.jsx and the
// panel stay dumb about it. Phases:
//   idle       → no upgrade running, no confirmation open
//   confirming → modal visible, waiting for user input
//   running    → orchestrator fired; `progress` ticks as devices finish
//   done       → brief post-run summary toast; auto-clears back to idle
export function useUpgradeController({ onEvent } = {}) {
    const [state, setState] = useState({ phase: 'idle' });

    // Cached across renders so `start` can fire without having to re-read
    // React state (which would be stale at call time anyway).
    const pendingRef = useRef(null);
    const abortRef = useRef(null);
    const doneTimerRef = useRef(null);

    const clearDoneTimer = () => {
        if (doneTimerRef.current) {
            clearTimeout(doneTimerRef.current);
            doneTimerRef.current = null;
        }
    };

    const openConfirm = useCallback((target, outdated) => {
        if (!outdated?.length) return;
        clearDoneTimer();
        pendingRef.current = { target, outdated };
        setState({
            phase: 'confirming',
            target,
            outdatedCount: outdated.length,
        });
    }, []);

    const cancelConfirm = useCallback(() => {
        pendingRef.current = null;
        setState({ phase: 'idle' });
    }, []);

    const cancelRunning = useCallback(() => {
        abortRef.current?.abort();
    }, []);

    const start = useCallback(
        async (options) => {
            const pending = pendingRef.current;
            if (!pending) return;
            const { target, outdated } = pending;
            pendingRef.current = null;

            const deviceIds = outdated.map((d) => d.device);
            setState({
                phase: 'running',
                target,
                progress: { done: 0, total: deviceIds.length },
            });

            const controller = new AbortController();
            abortRef.current = controller;

            onEvent?.({
                kind: 'info',
                dev: 'fleet',
                msg: `upgrade start · ${deviceIds.length} device${deviceIds.length === 1 ? '' : 's'} → ${target}`,
            });

            const result = await runFleetUpgrade({
                deviceIds,
                channel: 'latest',
                canary: options.canary,
                abortOnFailure: options.abortOnFailure,
                batchSize: options.batchSize,
                signal: controller.signal,
                onProgress: ({ done, total }) => {
                    setState((prev) =>
                        prev.phase === 'running'
                            ? { ...prev, progress: { done, total } }
                            : prev,
                    );
                },
                onDeviceResult: (r) => {
                    onEvent?.(
                        r.ok
                            ? { kind: 'upd', dev: r.deviceId, msg: 'update applied' }
                            : { kind: 'err', dev: r.deviceId, msg: `update failed: ${r.error}` },
                    );
                },
            });

            const summary = summarize(result.results);
            onEvent?.({
                kind: result.aborted ? 'err' : 'info',
                dev: 'fleet',
                msg: result.aborted
                    ? `upgrade aborted (${result.reason}) · ${summary.ok} ok · ${summary.failed} failed`
                    : `upgrade done · ${summary.ok} ok · ${summary.failed} failed`,
            });

            setState({
                phase: 'done',
                summary,
                aborted: result.aborted,
                reason: result.reason,
                target,
            });

            clearDoneTimer();
            doneTimerRef.current = setTimeout(() => {
                setState({ phase: 'idle' });
                doneTimerRef.current = null;
            }, DONE_TOAST_MS);

            abortRef.current = null;
        },
        [onEvent],
    );

    return {
        state,
        openConfirm,
        cancelConfirm,
        cancelRunning,
        start,
    };
}
