import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterDevicesByMetric } from '../lib/dashboard/metric-filter.js';

const DEVICES = [
    { device: 'a', name: 'alpha' },
    { device: 'b', name: 'beta' },
    { device: 'c', name: 'gamma' },
    { device: 'd', name: 'delta' },
];

const KERNEL_KEY = 'thinger-server:kernel';
const VALUES_BY_DEVICE = {
    [KERNEL_KEY]: {
        a: '5.4.0-1103-aws',
        b: '5.4.0-1103-aws',
        c: '6.5.14',
        // d intentionally absent — never reported.
    },
};

describe('filterDevicesByMetric', () => {
    it('returns the full list (copy) when no filter is set', () => {
        const out = filterDevicesByMetric(DEVICES, VALUES_BY_DEVICE, null);
        assert.deepEqual(out, DEVICES);
        assert.notEqual(out, DEVICES, 'must not return the input array reference');
    });

    it('returns the full list when filter has no bucket', () => {
        const out = filterDevicesByMetric(DEVICES, VALUES_BY_DEVICE, {
            metricKey: KERNEL_KEY,
        });
        assert.deepEqual(out, DEVICES);
    });

    it('keeps devices that report the chosen bucket', () => {
        const out = filterDevicesByMetric(DEVICES, VALUES_BY_DEVICE, {
            metricKey: KERNEL_KEY,
            bucket: '5.4.0-1103-aws',
        });
        assert.deepEqual(
            out.map((d) => d.device),
            ['a', 'b'],
        );
    });

    it('drops devices that have never reported (no sample)', () => {
        const out = filterDevicesByMetric(DEVICES, VALUES_BY_DEVICE, {
            metricKey: KERNEL_KEY,
            bucket: '5.4.0-1103-aws',
        });
        assert.equal(
            out.find((d) => d.device === 'd'),
            undefined,
        );
    });

    it('drops devices whose latest sample is null', () => {
        const map = {
            [KERNEL_KEY]: { a: '6.5.14', b: null, c: '6.5.14' },
        };
        const out = filterDevicesByMetric(DEVICES, map, {
            metricKey: KERNEL_KEY,
            bucket: '6.5.14',
        });
        assert.deepEqual(
            out.map((d) => d.device),
            ['a', 'c'],
        );
    });

    it('returns empty when nothing matches', () => {
        const out = filterDevicesByMetric(DEVICES, VALUES_BY_DEVICE, {
            metricKey: KERNEL_KEY,
            bucket: 'never-seen',
        });
        assert.deepEqual(out, []);
    });

    it('returns empty when the metric was never observed', () => {
        const out = filterDevicesByMetric(DEVICES, VALUES_BY_DEVICE, {
            metricKey: 'unknown:metric',
            bucket: 'whatever',
        });
        assert.deepEqual(out, []);
    });

    it('coerces both sides to string so 1 matches "1"', () => {
        const map = { 'p:m': { a: 1, b: '1', c: 2 } };
        const out = filterDevicesByMetric(DEVICES, map, {
            metricKey: 'p:m',
            bucket: '1',
        });
        assert.deepEqual(
            out.map((d) => d.device),
            ['a', 'b'],
        );
    });

    it('preserves caller-supplied device order', () => {
        const map = {
            'p:m': { d: 'X', a: 'X', c: 'X', b: 'Y' },
        };
        const out = filterDevicesByMetric(DEVICES, map, {
            metricKey: 'p:m',
            bucket: 'X',
        });
        assert.deepEqual(
            out.map((d) => d.device),
            ['a', 'c', 'd'],
        );
    });

    it('handles a missing valuesByDevice safely', () => {
        const out = filterDevicesByMetric(DEVICES, undefined, {
            metricKey: KERNEL_KEY,
            bucket: '6.5.14',
        });
        assert.deepEqual(out, []);
    });
});
