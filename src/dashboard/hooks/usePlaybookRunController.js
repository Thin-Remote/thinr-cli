import { useCallback, useRef, useState } from 'react';
import { runPlaybook } from '../../../lib/playbook/runner.js';
import { DEFAULT_FAILURE_THRESHOLD, runFleetPlaybook } from '../../../lib/playbook/fleet.js';
import { uploadFleetRunReport } from '../../../lib/product.js';
import { readConfig } from '../../../lib/config.js';

const DEFAULT_BATCH_SIZE = 5;

/**
 * State machine wrapping the single-device runner and fleet orchestrator.
 * Phases:
 *   idle                     → nothing in flight
 *   vars   (single | fleet)  → collecting variable overrides / run options
 *   confirming-delete        → destructive op awaiting user confirmation
 *   running                  → runner executing; per-device/step progress updates
 *   done                     → last run's result held until dismissed
 */
export function usePlaybookRunController() {
    const [state, setState] = useState({ phase: 'idle' });
    const abortRef = useRef(null);

    const cancelFlow = useCallback(() => {
        setState({ phase: 'idle' });
    }, []);

    const cancelRunning = useCallback(() => {
        abortRef.current?.abort?.();
    }, []);

    const startSingleVars = useCallback((playbook, parsed, device) => {
        setState({
            phase: 'vars',
            mode: 'single',
            playbook,
            parsed,
            device,
        });
    }, []);

    const startFleetVars = useCallback((playbook, parsed) => {
        setState({
            phase: 'vars',
            mode: 'fleet',
            playbook,
            parsed,
            batchSize: DEFAULT_BATCH_SIZE,
            failureThreshold: DEFAULT_FAILURE_THRESHOLD,
            includeOffline: false,
        });
    }, []);

    const openDeleteConfirm = useCallback((playbook) => {
        setState({ phase: 'confirming-delete', playbook });
    }, []);

    const runSingle = useCallback(
        async ({ productId, playbook, parsed, device, overrides }) => {
            if (!device) {
                return;
            }
            const pb = clonePlaybook(parsed);
            pb.target.devices = [device.device];
            pb.target.product = productId;
            pb.target.group = null;

            const stepCount = pb.steps.length;
            setState({
                phase: 'running',
                mode: 'single',
                playbook,
                device,
                stepCount,
                stepsProgress: new Map(),
                startedAt: Date.now(),
            });

            const controller = new AbortController();
            abortRef.current = controller;

            try {
                const results = await runPlaybook(pb, [device], {
                    concurrency: 1,
                    failFast: true,
                    overrides,
                    onStepStart: ({ stepIndex, step }) => {
                        setState((prev) => {
                            if (prev.phase !== 'running' || prev.mode !== 'single') return prev;
                            const next = new Map(prev.stepsProgress);
                            next.set(stepIndex, {
                                index: stepIndex,
                                name: step.name,
                                status: 'running',
                            });
                            return { ...prev, stepsProgress: next };
                        });
                    },
                    onStepEnd: ({ stepIndex, step, ok, summary, error, durationMs, verdict }) => {
                        setState((prev) => {
                            if (prev.phase !== 'running' || prev.mode !== 'single') return prev;
                            const next = new Map(prev.stepsProgress);
                            next.set(stepIndex, {
                                index: stepIndex,
                                name: step.name,
                                status: ok ? 'ok' : 'failed',
                                summary,
                                error,
                                durationMs,
                                verdict,
                            });
                            return { ...prev, stepsProgress: next };
                        });
                    },
                });
                const result = results[0];
                setState({
                    phase: 'done',
                    mode: 'single',
                    playbook,
                    device,
                    result,
                    finishedAt: Date.now(),
                });
            } catch (err) {
                setState({
                    phase: 'done',
                    mode: 'single',
                    playbook,
                    device,
                    result: {
                        device: device.device,
                        ok: false,
                        steps: [],
                        error: err?.message || String(err),
                    },
                    finishedAt: Date.now(),
                });
            } finally {
                abortRef.current = null;
            }
        },
        [],
    );

    const runFleet = useCallback(
        async ({ productId, playbook, parsed, devices, overrides, batchSize, failureThreshold, includeOffline }) => {
            if (!devices || devices.length === 0) return;

            const pb = clonePlaybook(parsed);
            pb.target.devices = null;
            pb.target.product = productId;

            const startedAt = new Date().toISOString();
            setState({
                phase: 'running',
                mode: 'fleet',
                playbook,
                deviceCount: devices.length,
                batchSize,
                failureThreshold,
                batches: [],
                perDevice: new Map(),
                summary: { attempted: 0, succeeded: 0, failed: 0, failureRate: 0 },
                startedAt,
            });

            const controller = new AbortController();
            abortRef.current = controller;

            let outcome;
            try {
                outcome = await runFleetPlaybook(pb, devices, {
                    batchSize,
                    failureThreshold,
                    overrides,
                    signal: controller.signal,
                    onBatchStart: (info) => {
                        setState((prev) => {
                            if (prev.phase !== 'running' || prev.mode !== 'fleet') return prev;
                            return {
                                ...prev,
                                currentBatch: {
                                    index: info.index,
                                    size: info.size,
                                    firstIndex: info.firstIndex,
                                    deviceIds: info.deviceIds,
                                    status: 'running',
                                },
                            };
                        });
                    },
                    onBatchEnd: ({ index, size, firstIndex, deviceIds, results, cumulative }) => {
                        setState((prev) => {
                            if (prev.phase !== 'running' || prev.mode !== 'fleet') return prev;
                            const ok = results.filter((r) => r?.ok).length;
                            const failed = results.length - ok;
                            const batches = [
                                ...prev.batches,
                                { index, size, firstIndex, deviceIds, ok, failed },
                            ];
                            return {
                                ...prev,
                                currentBatch: { ...prev.currentBatch, status: 'done' },
                                batches,
                                summary: {
                                    attempted: cumulative.attempted,
                                    succeeded: cumulative.succeeded,
                                    failed: cumulative.failed,
                                    failureRate: cumulative.failureRate,
                                },
                            };
                        });
                    },
                    onDeviceResult: (r) => {
                        setState((prev) => {
                            if (prev.phase !== 'running' || prev.mode !== 'fleet') return prev;
                            const next = new Map(prev.perDevice);
                            next.set(r.device, {
                                device: r.device,
                                ok: !!r.ok,
                                skipped: !!r.skipped,
                                error: r.error,
                                stepCount: Array.isArray(r.steps) ? r.steps.length : 0,
                            });
                            return { ...prev, perDevice: next };
                        });
                    },
                });
            } catch (err) {
                setState({
                    phase: 'done',
                    mode: 'fleet',
                    playbook,
                    aborted: true,
                    reason: err?.message || String(err),
                    results: [],
                    summary: { attempted: 0, succeeded: 0, failed: 0, failureRate: 0 },
                    batches: [],
                    finishedAt: Date.now(),
                });
                abortRef.current = null;
                return;
            }
            abortRef.current = null;
            const finishedAt = new Date().toISOString();

            // Persist a run report (best effort).
            let username = null;
            try {
                username = readConfig()?.username || null;
            } catch {
                username = null;
            }
            const report = buildRunReport({
                productId,
                name: playbook.name,
                parsed,
                user: username,
                startedAt,
                finishedAt,
                batchSize,
                failureThreshold,
                includeOffline: !!includeOffline,
                resolvedVars: overrides || {},
                outcome,
                totalDevices: devices.length,
            });
            let reportUpload = null;
            try {
                reportUpload = await uploadFleetRunReport({ product: productId, report });
            } catch (err) {
                reportUpload = { ok: false, reason: err?.message || String(err) };
            }

            setState({
                phase: 'done',
                mode: 'fleet',
                playbook,
                totalDevices: devices.length,
                batchSize,
                failureThreshold,
                results: outcome.results,
                summary: {
                    attempted: outcome.attempted,
                    succeeded: outcome.succeeded,
                    failed: outcome.failed,
                    failureRate: outcome.failureRate,
                },
                batches: outcome.batches,
                aborted: outcome.aborted,
                reason: outcome.reason,
                reportUpload,
                finishedAt: Date.now(),
            });
        },
        [],
    );

    const dismissDone = useCallback(() => {
        setState({ phase: 'idle' });
    }, []);

    return {
        state,
        startSingleVars,
        startFleetVars,
        openDeleteConfirm,
        cancelFlow,
        cancelRunning,
        runSingle,
        runFleet,
        dismissDone,
    };
}

function clonePlaybook(pb) {
    return {
        ...pb,
        target: { ...(pb.target || {}) },
        vars: { ...(pb.vars || {}) },
        variables: Array.isArray(pb.variables) ? pb.variables.map((v) => ({ ...v })) : [],
        steps: Array.isArray(pb.steps) ? pb.steps.map((s) => ({ ...s })) : [],
    };
}

function buildRunReport({
    productId,
    name,
    parsed,
    user,
    startedAt,
    finishedAt,
    batchSize,
    failureThreshold,
    includeOffline,
    resolvedVars,
    outcome,
    totalDevices,
}) {
    return {
        product: productId,
        name,
        user,
        startedAt,
        finishedAt,
        durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
        mode: 'apply',
        playbook: {
            name: parsed?.name || null,
            description: parsed?.description || null,
            steps: parsed?.steps?.length || 0,
        },
        rollout: {
            batchSize,
            failureThreshold,
            filters: null,
            group: null,
            includeOffline: !!includeOffline,
            source: 'dashboard',
        },
        vars: resolvedVars,
        summary: {
            attempted: outcome.attempted,
            succeeded: outcome.succeeded,
            failed: outcome.failed,
            failureRate: outcome.failureRate,
            total: totalDevices,
        },
        aborted: !!outcome.aborted,
        reason: outcome.reason || null,
        batches: outcome.batches,
        devices: outcome.results.map((r) => ({
            device: r?.device,
            ok: !!r?.ok,
            skipped: !!r?.skipped,
            error: r?.error || null,
            steps: Array.isArray(r?.steps)
                ? r.steps.map((s) => ({
                      index: s.index,
                      name: s.name,
                      ok: !!s.ok,
                      skipped: !!s.skipped,
                      verdict: s.verdict || null,
                      summary: s.summary,
                      durationMs: s.durationMs,
                      error: s.error || null,
                  }))
                : [],
        })),
    };
}
