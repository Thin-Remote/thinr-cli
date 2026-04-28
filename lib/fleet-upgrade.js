import { createDeviceAPI } from './device-api.js';
import { TIMEOUTS } from './constants.js';

/**
 * Roll a fleet-wide agent upgrade. Strategy:
 *   1. If `canary` is set and there's more than one device, upgrade one
 *      device in isolation first. A canary failure always aborts — the
 *      point of the canary is to catch arch / channel / connectivity
 *      mistakes before we touch the rest.
 *   2. The remainder is upgraded in parallel batches of `batchSize`. If
 *      `abortOnFailure` is set, any failure inside a batch stops the run
 *      after that batch completes (we never leave requests dangling).
 *   3. Results come back as { ok, failed, aborted } plus the per-device
 *      records. Progress is reported through `onProgress` so the UI can
 *      show `updating N/M…` live.
 *
 * We intentionally treat any HTTP rejection as a failure and any resolved
 * call as success. The agent's `update` resource doesn't expose a stable
 * machine-readable status across every "nothing to do" case, so finer
 * classification would be fragile here — a resolved call means the agent
 * accepted the request; whether it then swapped binaries is visible in
 * the next sample's version field.
 */
export async function runFleetUpgrade({
    deviceIds,
    channel = 'latest',
    user,
    canary = true,
    abortOnFailure = true,
    batchSize = 5,
    onProgress,
    onDeviceResult,
    signal,
}) {
    const queue = [...deviceIds];
    const total = queue.length;
    const results = [];
    let done = 0;

    const emitProgress = (phase) => {
        onProgress?.({ done, total, phase });
    };

    async function upgradeOne(id) {
        if (signal?.aborted) {
            const r = { deviceId: id, ok: false, error: 'cancelled' };
            results.push(r);
            onDeviceResult?.(r);
            return r;
        }
        let r;
        try {
            const api = createDeviceAPI(id, user ? { user } : {});
            const result = await api.callResource(
                'update',
                { action: 'apply', channel },
                { timeout: TIMEOUTS.DEVICE_UPDATE_APPLY_MS },
            );
            r = { deviceId: id, ok: true, result };
        } catch (e) {
            r = {
                deviceId: id,
                ok: false,
                error: e?.message || String(e),
            };
        }
        results.push(r);
        done += 1;
        onDeviceResult?.(r);
        emitProgress('running');
        return r;
    }

    emitProgress('running');

    // Canary first — a single device, synchronously. Treat failure as
    // terminal regardless of `abortOnFailure`: if the canary fails we have
    // no signal that a wider rollout would succeed, and blindly firing at
    // 95 more devices would only amplify whatever went wrong.
    if (canary && queue.length > 1) {
        const canaryId = queue.shift();
        const r = await upgradeOne(canaryId);
        if (!r.ok) {
            return { results, aborted: true, reason: 'canary-failed' };
        }
    }

    while (queue.length > 0) {
        if (signal?.aborted) {
            return { results, aborted: true, reason: 'cancelled' };
        }
        const batch = queue.splice(0, batchSize);
        const batchResults = await Promise.all(batch.map(upgradeOne));
        if (abortOnFailure && batchResults.some((r) => !r.ok)) {
            return { results, aborted: true, reason: 'batch-failed' };
        }
    }

    return { results, aborted: false };
}

export function summarize(results) {
    const ok = results.filter((r) => r.ok).length;
    const failed = results.length - ok;
    return { ok, failed, total: results.length };
}
