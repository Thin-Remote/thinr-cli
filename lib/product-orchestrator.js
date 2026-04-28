// @ts-check
import { getDevices, filterActiveDevices } from './devices.js';
import { runPool } from './concurrency.js';

/**
 * Resolve the target devices of a product (optionally filtered by
 * asset group and active connection), then run `worker(device)` over
 * them with bounded concurrency.
 *
 * The worker is responsible for its own error handling and always
 * returns a fully-populated entry. Any escaping throw is caught and
 * converted via `onInternalError(device, err)` into a normalized
 * failure entry, so the returned `entries` array always has one
 * element per target device in the same order.
 *
 * Fail-fast is "soft": after the first failure (as judged by
 * `isFailure(entry)`) remaining devices receive a `skipped(device,
 * firstFailureDevice)` entry instead of running the worker. That way
 * the per-device report still covers the whole fleet — the caller can
 * show "skipped" in a table column instead of vanishing rows.
 *
 * The shape of `entry` is fully caller-defined: exec returns
 * `{stdout, stderr, exitCode, …}`, push returns `{bytes, …}`,
 * filesystem ops return `{durationMs, …}`. The orchestrator only
 * touches the fields it gets told about via callbacks.
 *
 * @template E
 * @param {{
 *     product: string,
 *     group?: string,
 *     includeOffline?: boolean,
 *     user?: string | null,
 *     concurrency?: number,
 *     failFast?: boolean,
 *     worker: (device: any) => Promise<E>,
 *     skipped: (device: any, firstFailureDevice: string) => E,
 *     isFailure: (entry: E) => boolean,
 *     onInternalError?: (device: any, error: unknown) => E,
 *     onDevicesResolved?: (devices: any[]) => void,
 *     onItemStart?: (device: any) => void,
 *     onItemFinish?: (device: any, entry: E) => void,
 * }} opts
 * @returns {Promise<{
 *     devices: any[],
 *     entries: E[],
 *     durationMs: number,
 * }>}
 */
export async function runProductFanOut(opts) {
    const {
        product,
        group,
        includeOffline = false,
        user,
        concurrency = 10,
        failFast = false,
        worker,
        skipped,
        isFailure,
        onInternalError,
        onDevicesResolved,
        onItemStart,
        onItemFinish,
    } = opts;

    const filter = { product };
    if (group) filter.asset_group = group;
    let devices = await getDevices(filter, user || undefined);
    if (!includeOffline) devices = filterActiveDevices(devices);

    onDevicesResolved?.(devices);

    if (devices.length === 0) {
        return { devices, entries: [], durationMs: 0 };
    }

    const startTs = Date.now();
    let aborted = false;
    /** @type {string | null} */
    let firstFailureDevice = null;

    const poolResults = await runPool(devices, concurrency, async (device) => {
        if (failFast && aborted && firstFailureDevice !== null) {
            return skipped(device, firstFailureDevice);
        }
        onItemStart?.(device);
        /** @type {E} */
        let entry;
        try {
            entry = await worker(device);
        } catch (err) {
            // Workers should own their errors; this branch is the last
            // line of defence for an uncaught throw (OOM, unexpected
            // library bug…). Callers can customize the fallback shape.
            entry =
                onInternalError?.(device, err) ??
                /** @type {E} */ (
                    /** @type {unknown} */ ({
                        device: device.device ?? String(device),
                        ok: false,
                        error: err instanceof Error ? err.message : String(err),
                    })
                );
        }
        onItemFinish?.(device, entry);
        if (failFast && !aborted && isFailure(entry)) {
            aborted = true;
            firstFailureDevice = device.device ?? String(device);
        }
        return entry;
    });

    /** @type {E[]} */
    const entries = poolResults.map((r, i) => {
        if (r?.ok) return r.value;
        // Shouldn't happen — the inner try/catch already normalized
        // every error into an entry. If it does, fall back to the
        // caller's skipped() with a synthetic reason so the array
        // shape stays consistent.
        return skipped(devices[i], 'internal pool error');
    });

    return { devices, entries, durationMs: Date.now() - startTs };
}
