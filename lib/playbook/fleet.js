// @ts-check
import { runPlaybook } from './runner.js';

export const DEFAULT_FAILURE_THRESHOLD = 10;

/**
 * Roll a product playbook across a fleet in discrete batches. Each
 * batch runs in parallel up to `batchSize`; the next batch only starts
 * once every device in the current one has finished. After every
 * batch the cumulative failure rate is compared against
 * `failureThreshold` (a percentage of the devices attempted so far);
 * crossing it aborts the rollout before any further batch runs.
 *
 * The orchestrator reuses the single-device runner under the hood, so
 * behaviour per device (idempotency, `when` gates, `register`,
 * check/apply modes, variable scope) stays identical to
 * `thinr product playbook run --device <id>`. Fleet-specific concerns
 * live here: partitioning, batch barriers, threshold bookkeeping, and
 * rollout-level progress hooks.
 *
 * Caller shape — the returned `results` array is parallel to `devices`
 * after both the successful and skipped paths fill in. Skipped devices
 * have `ok: false, skipped: true` with the abort reason in `error`.
 *
 * @param {any} pb                            Parsed playbook.
 * @param {Array<{ device: string, connection?: { active: boolean } }>} devices
 * @param {{
 *   user?: string | null,
 *   batchSize?: number,
 *   failureThreshold?: number,
 *   overrides?: Record<string, unknown>,
 *   checkMode?: boolean,
 *   baseDir?: string,
 *   signal?: AbortSignal,
 *   onBatchStart?: (info: { index: number, size: number, firstIndex: number, deviceIds: string[] }) => void,
 *   onBatchEnd?:   (info: { index: number, size: number, firstIndex: number, deviceIds: string[], results: any[], cumulative: { attempted: number, succeeded: number, failed: number, failureRate: number } }) => void,
 *   onDeviceResult?: (result: any) => void,
 *   runBatch?: (pb: any, devices: any[], opts: any) => Promise<any[]>,
 * }} [opts]
 * @returns {Promise<{
 *   results: any[],
 *   aborted: boolean,
 *   reason: 'failure-threshold' | 'cancelled' | null,
 *   attempted: number,
 *   succeeded: number,
 *   failed: number,
 *   failureRate: number,
 *   batches: Array<{ index: number, size: number, firstIndex: number, deviceIds: string[], succeeded: number, failed: number }>,
 * }>}
 */
export async function runFleetPlaybook(pb, devices, opts = {}) {
    const batchSize = Math.max(1, opts.batchSize ?? 5);
    const failureThreshold = clampThreshold(opts.failureThreshold);
    const user = opts.user ?? null;
    const batchRunner = opts.runBatch || runPlaybook;

    /** @type {any[]} */
    const results = new Array(devices.length);
    const batches = [];
    let attempted = 0;
    let succeeded = 0;
    let failed = 0;
    let aborted = false;
    /** @type {'failure-threshold' | 'cancelled' | null} */
    let reason = null;

    for (let start = 0; start < devices.length; start += batchSize) {
        if (opts.signal?.aborted) {
            aborted = true;
            reason = 'cancelled';
            break;
        }

        const batchDevices = devices.slice(start, start + batchSize);
        const batchIndex = batches.length;
        const deviceIds = batchDevices.map((d) => d.device);

        opts.onBatchStart?.({
            index: batchIndex,
            size: batchDevices.length,
            firstIndex: start,
            deviceIds,
        });

        const batchResults = await batchRunner(pb, batchDevices, {
            user,
            concurrency: batchDevices.length,
            failFast: false,
            checkMode: !!opts.checkMode,
            baseDir: opts.baseDir,
            overrides: opts.overrides,
        });

        let batchSucceeded = 0;
        let batchFailed = 0;
        for (let i = 0; i < batchResults.length; i++) {
            const r = batchResults[i];
            const absIndex = start + i;
            results[absIndex] = r;
            attempted += 1;
            if (r && r.ok) {
                succeeded += 1;
                batchSucceeded += 1;
            } else {
                failed += 1;
                batchFailed += 1;
            }
            opts.onDeviceResult?.(r);
        }

        const cumulative = {
            attempted,
            succeeded,
            failed,
            failureRate: attempted === 0 ? 0 : (failed / attempted) * 100,
        };
        batches.push({
            index: batchIndex,
            size: batchDevices.length,
            firstIndex: start,
            deviceIds,
            succeeded: batchSucceeded,
            failed: batchFailed,
        });
        opts.onBatchEnd?.({
            index: batchIndex,
            size: batchDevices.length,
            firstIndex: start,
            deviceIds,
            results: batchResults,
            cumulative,
        });

        if (failed > 0 && cumulative.failureRate >= failureThreshold) {
            aborted = true;
            reason = 'failure-threshold';
            break;
        }
    }

    if (aborted) {
        const skipReason = reason === 'cancelled' ? 'cancelled' : 'aborted (failure threshold reached)';
        for (let i = 0; i < devices.length; i++) {
            if (results[i] === undefined) {
                results[i] = {
                    device: devices[i].device,
                    ok: false,
                    skipped: true,
                    steps: [],
                    error: skipReason,
                };
            }
        }
    }

    return {
        results,
        aborted,
        reason,
        attempted,
        succeeded,
        failed,
        failureRate: attempted === 0 ? 0 : (failed / attempted) * 100,
        batches,
    };
}

function clampThreshold(value) {
    if (value === undefined || value === null) return DEFAULT_FAILURE_THRESHOLD;
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_FAILURE_THRESHOLD;
    if (n < 0) return 0;
    if (n > 100) return 100;
    return n;
}
