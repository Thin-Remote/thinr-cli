import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, getPath } from '../lib/dashboard/metric-aggregate.js';

describe('aggregate — numeric reducers', () => {
    it('sums numeric values', () => {
        assert.equal(aggregate([1, 2, 3], 'sum'), 6);
    });

    it('averages numeric values', () => {
        assert.equal(aggregate([2, 4, 6], 'avg'), 4);
    });

    it('returns max / min', () => {
        assert.equal(aggregate([3, 1, 7, 4], 'max'), 7);
        assert.equal(aggregate([3, 1, 7, 4], 'min'), 1);
    });

    it('returns null when there are no numeric samples', () => {
        assert.equal(aggregate([], 'sum'), null);
        assert.equal(aggregate([undefined, 'x'], 'avg'), null);
    });

    it('coerces stringified numbers and ignores non-numeric ones', () => {
        assert.equal(aggregate(['1', '2', 'nope', null], 'sum'), 3);
    });
});

describe('aggregate — non-numeric reducers', () => {
    it('count reports the number of non-null samples', () => {
        assert.equal(aggregate(['a', null, 'b', undefined, 0], 'count'), 3);
    });

    it('count returns 0 on an empty input', () => {
        assert.equal(aggregate([], 'count'), 0);
    });

    it('none returns the raw array untouched', () => {
        const xs = [1, null, 'x'];
        assert.deepEqual(aggregate(xs, 'none'), [1, null, 'x']);
    });
});

describe('aggregate — distribution', () => {
    it('counts distinct values, coercing keys to string', () => {
        const out = aggregate(
            ['6.5.14', '6.5.14', '7.3.0', '7.3.0', '7.3.0', '6.2.5'],
            'distribution',
        );
        assert.deepEqual(out, { '6.5.14': 2, '7.3.0': 3, '6.2.5': 1 });
    });

    it('ignores null, undefined and empty strings', () => {
        const out = aggregate(['a', null, undefined, '', 'a', 'b'], 'distribution');
        assert.deepEqual(out, { a: 2, b: 1 });
    });

    it('collapses every device into one bucket when all report the same value', () => {
        const out = aggregate(['master', 'master', 'master'], 'distribution');
        assert.deepEqual(out, { master: 3 });
    });

    it('produces N buckets of 1 when every device reports a distinct value', () => {
        const out = aggregate(['a', 'b', 'c', 'd'], 'distribution');
        assert.deepEqual(out, { a: 1, b: 1, c: 1, d: 1 });
    });

    it('returns an empty object when no usable samples are present', () => {
        assert.deepEqual(aggregate([], 'distribution'), {});
        assert.deepEqual(aggregate([null, undefined, ''], 'distribution'), {});
    });

    it('coerces numbers to string keys so 1 and "1" land in the same bucket', () => {
        const out = aggregate([1, '1', 1, 2], 'distribution');
        assert.deepEqual(out, { '1': 3, '2': 1 });
    });
});

describe('getPath', () => {
    it('returns the object itself when no path is given', () => {
        const obj = { a: 1 };
        assert.equal(getPath(obj, undefined), obj);
        assert.equal(getPath(obj, ''), obj);
    });

    it('walks dotted paths', () => {
        assert.equal(getPath({ a: { b: { c: 42 } } }, 'a.b.c'), 42);
    });

    it('returns undefined when an intermediate hop is missing', () => {
        assert.equal(getPath({ a: null }, 'a.b'), null);
        assert.equal(getPath({}, 'a.b'), undefined);
    });
});
