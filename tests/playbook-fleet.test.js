import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FAILURE_THRESHOLD, runFleetPlaybook } from '../lib/playbook/fleet.js';

function makeDevices(n) {
    return Array.from({ length: n }, (_, i) => ({
        device: `d${i + 1}`,
        connection: { active: true },
    }));
}

function resultFor(device, ok, extra = {}) {
    return { device: device.device, ok, steps: [], ...extra };
}

describe('runFleetPlaybook — batching', () => {
    it('partitions devices into batches of the requested size and preserves order', async () => {
        const devices = makeDevices(7);
        const batches = [];
        const result = await runFleetPlaybook({ steps: [] }, devices, {
            batchSize: 3,
            runBatch: async (_pb, devs) => {
                batches.push(devs.map((d) => d.device));
                return devs.map((d) => resultFor(d, true));
            },
        });
        assert.deepEqual(batches, [
            ['d1', 'd2', 'd3'],
            ['d4', 'd5', 'd6'],
            ['d7'],
        ]);
        assert.equal(result.attempted, 7);
        assert.equal(result.succeeded, 7);
        assert.equal(result.failed, 0);
        assert.equal(result.aborted, false);
        assert.equal(result.reason, null);
        assert.equal(result.results.length, 7);
        assert.deepEqual(
            result.results.map((r) => r.device),
            devices.map((d) => d.device),
        );
    });

    it('does not start the next batch until the current one finishes', async () => {
        const devices = makeDevices(4);
        let inFlight = 0;
        let maxInFlight = 0;
        await runFleetPlaybook({ steps: [] }, devices, {
            batchSize: 2,
            runBatch: async (_pb, devs) => {
                inFlight += devs.length;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise((r) => setTimeout(r, 5));
                inFlight -= devs.length;
                return devs.map((d) => resultFor(d, true));
            },
        });
        assert.equal(maxInFlight, 2);
    });

    it('treats missing/zero batchSize as at least 1 device per batch', async () => {
        const devices = makeDevices(3);
        const seen = [];
        await runFleetPlaybook({ steps: [] }, devices, {
            batchSize: 0,
            runBatch: async (_pb, devs) => {
                seen.push(devs.length);
                return devs.map((d) => resultFor(d, true));
            },
        });
        assert.deepEqual(seen, [1, 1, 1]);
    });
});

describe('runFleetPlaybook — failure threshold', () => {
    it('aborts after the batch that crosses the threshold and skips the rest', async () => {
        const devices = makeDevices(10);
        const seen = [];
        const result = await runFleetPlaybook({ steps: [] }, devices, {
            batchSize: 2,
            failureThreshold: 50,
            runBatch: async (_pb, devs) => {
                seen.push(devs.map((d) => d.device));
                return devs.map((d) => resultFor(d, false, { error: 'boom' }));
            },
        });
        assert.equal(result.aborted, true);
        assert.equal(result.reason, 'failure-threshold');
        assert.equal(seen.length, 1);
        assert.equal(result.attempted, 2);
        assert.equal(result.failed, 2);
        assert.equal(result.results.filter((r) => r.skipped).length, 8);
        assert.match(result.results.find((r) => r.skipped).error, /aborted/);
    });

    it('uses the default threshold when none is supplied', async () => {
        assert.equal(DEFAULT_FAILURE_THRESHOLD, 10);
        const devices = makeDevices(20);
        const result = await runFleetPlaybook({ steps: [] }, devices, {
            batchSize: 5,
            runBatch: async (_pb, devs, idx) => {
                return devs.map((d, i) => {
                    const abs = (idx?.firstIndex ?? 0) + i;
                    return resultFor(d, false, { error: 'boom' });
                });
            },
        });
        assert.equal(result.aborted, true);
        assert.equal(result.reason, 'failure-threshold');
        assert.equal(result.attempted, 5);
    });

    it('does not abort when the failure rate stays under the threshold', async () => {
        const devices = makeDevices(10);
        let calls = 0;
        const result = await runFleetPlaybook({ steps: [] }, devices, {
            batchSize: 5,
            failureThreshold: 50,
            runBatch: async (_pb, devs) => {
                calls++;
                return devs.map((d, i) => resultFor(d, i !== 0, i === 0 ? { error: 'f' } : {}));
            },
        });
        assert.equal(calls, 2);
        assert.equal(result.aborted, false);
        assert.equal(result.reason, null);
        assert.equal(result.succeeded, 8);
        assert.equal(result.failed, 2);
        assert.equal(result.results.filter((r) => r.skipped).length, 0);
    });

    it('does not abort when there are zero failures, regardless of threshold', async () => {
        const devices = makeDevices(4);
        const result = await runFleetPlaybook({ steps: [] }, devices, {
            batchSize: 2,
            failureThreshold: 0,
            runBatch: async (_pb, devs) => devs.map((d) => resultFor(d, true)),
        });
        assert.equal(result.aborted, false);
        assert.equal(result.succeeded, 4);
    });
});

describe('runFleetPlaybook — progress hooks', () => {
    it('fires onBatchStart / onBatchEnd with per-batch and cumulative stats', async () => {
        const devices = makeDevices(6);
        const starts = [];
        const ends = [];
        await runFleetPlaybook({ steps: [] }, devices, {
            batchSize: 2,
            failureThreshold: 100,
            runBatch: async (_pb, devs) => {
                return devs.map((d, i) => resultFor(d, i !== 1, i === 1 ? { error: 'x' } : {}));
            },
            onBatchStart: (info) => starts.push({ ...info }),
            onBatchEnd: (info) => ends.push({
                index: info.index,
                deviceIds: info.deviceIds,
                cumulative: { ...info.cumulative },
            }),
        });
        assert.equal(starts.length, 3);
        assert.deepEqual(starts[0].deviceIds, ['d1', 'd2']);
        assert.equal(ends.length, 3);
        assert.equal(ends[0].cumulative.attempted, 2);
        assert.equal(ends[0].cumulative.failed, 1);
        assert.equal(ends[2].cumulative.attempted, 6);
        assert.equal(ends[2].cumulative.failed, 3);
        assert.equal(ends[2].cumulative.failureRate, 50);
    });

    it('fires onDeviceResult for every completed device', async () => {
        const devices = makeDevices(3);
        const seen = [];
        await runFleetPlaybook({ steps: [] }, devices, {
            batchSize: 2,
            runBatch: async (_pb, devs) => devs.map((d) => resultFor(d, true)),
            onDeviceResult: (r) => seen.push(r.device),
        });
        assert.deepEqual(seen, ['d1', 'd2', 'd3']);
    });
});

describe('runFleetPlaybook — cancellation', () => {
    it('stops between batches when the signal is aborted', async () => {
        const devices = makeDevices(6);
        const controller = new AbortController();
        const seen = [];
        const result = await runFleetPlaybook({ steps: [] }, devices, {
            batchSize: 2,
            signal: controller.signal,
            runBatch: async (_pb, devs) => {
                seen.push(devs.map((d) => d.device));
                if (seen.length === 1) controller.abort();
                return devs.map((d) => resultFor(d, true));
            },
        });
        assert.equal(seen.length, 1);
        assert.equal(result.aborted, true);
        assert.equal(result.reason, 'cancelled');
        assert.equal(result.results.filter((r) => r.skipped).length, 4);
    });
});
