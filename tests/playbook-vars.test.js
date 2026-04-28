import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { interpolate } from '../lib/playbook/vars.js';

describe('interpolate', () => {
    it('substitutes a named variable in a string', () => {
        assert.equal(interpolate('hello {{ name }}', { name: 'world' }), 'hello world');
    });

    it('accepts whitespace around the variable name', () => {
        assert.equal(interpolate('{{name}}|{{  name  }}', { name: 'x' }), 'x|x');
    });

    it('walks objects and arrays recursively', () => {
        const scope = { v: '42' };
        assert.deepEqual(interpolate({ a: '{{ v }}', b: ['{{ v }}', 1] }, scope), {
            a: '42',
            b: ['42', 1],
        });
    });

    it('passes non-string values through untouched', () => {
        const scope = { v: '42' };
        assert.deepEqual(interpolate({ n: 10, b: true, s: '{{ v }}' }, scope), {
            n: 10,
            b: true,
            s: '42',
        });
    });

    it('throws when a referenced variable is missing', () => {
        assert.throws(
            () => interpolate('hi {{ who }}', {}),
            /Undefined playbook variable: who/,
        );
    });

    it('supports multiple substitutions in one string', () => {
        assert.equal(
            interpolate('{{ a }}-{{ b }}-{{ a }}', { a: 'x', b: 'y' }),
            'x-y-x',
        );
    });

    it('coerces non-string scope values to strings on substitution', () => {
        assert.equal(interpolate('port={{ p }}', { p: 8080 }), 'port=8080');
    });
});
