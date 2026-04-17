import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCondition, evaluateExpression } from '../lib/playbook/expression.js';

describe('expression literals', () => {
    it('handles booleans and null', () => {
        assert.equal(evaluateExpression('true', {}), true);
        assert.equal(evaluateExpression('false', {}), false);
        assert.equal(evaluateExpression('null', {}), null);
    });

    it('handles numbers and strings', () => {
        assert.equal(evaluateExpression('42', {}), 42);
        assert.equal(evaluateExpression('3.5', {}), 3.5);
        assert.equal(evaluateExpression('"hello"', {}), 'hello');
        assert.equal(evaluateExpression("'world'", {}), 'world');
    });
});

describe('expression comparisons', () => {
    it('compares equal values with == and !=', () => {
        assert.equal(evaluateCondition('1 == 1', {}), true);
        assert.equal(evaluateCondition('1 != 2', {}), true);
        assert.equal(evaluateCondition('"a" == "a"', {}), true);
        assert.equal(evaluateCondition('"a" == "b"', {}), false);
    });

    it('treats string-equal primitive values as equal (type-loose ==)', () => {
        assert.equal(evaluateCondition('"1" == 1', {}), true);
    });

    it('orders numbers with > < >= <=', () => {
        assert.equal(evaluateCondition('5 > 3', {}), true);
        assert.equal(evaluateCondition('5 < 3', {}), false);
        assert.equal(evaluateCondition('5 >= 5', {}), true);
        assert.equal(evaluateCondition('5 <= 4', {}), false);
    });
});

describe('expression logicals', () => {
    it('handles and, or, not with the right precedence', () => {
        assert.equal(evaluateCondition('true and true', {}), true);
        assert.equal(evaluateCondition('true and false', {}), false);
        assert.equal(evaluateCondition('false or true', {}), true);
        assert.equal(evaluateCondition('not false', {}), true);
        // `and` binds tighter than `or`
        assert.equal(evaluateCondition('true or false and false', {}), true);
    });

    it('parentheses override precedence', () => {
        assert.equal(evaluateCondition('(true or false) and false', {}), false);
    });
});

describe('expression paths', () => {
    it('resolves a top-level identifier', () => {
        assert.equal(evaluateCondition('enabled', { enabled: true }), true);
        assert.equal(evaluateCondition('not enabled', { enabled: false }), true);
    });

    it('resolves nested dotted paths', () => {
        const scope = { agent: { version: '1.6.0' } };
        assert.equal(evaluateCondition('agent.version == "1.6.0"', scope), true);
        assert.equal(evaluateCondition('agent.version != "1.5.0"', scope), true);
    });

    it('returns undefined for missing nested keys (without throwing)', () => {
        const scope = { a: { b: null } };
        assert.equal(evaluateExpression('a.b.c', scope), undefined);
    });

    it('throws when the top-level variable is missing', () => {
        assert.throws(
            () => evaluateCondition('ghost == 1', {}),
            /Undefined playbook variable: ghost/,
        );
    });
});

describe('expression real-world patterns', () => {
    it('skips an update step when the version already matches', () => {
        const scope = { agent: { version: '1.6.0' }, target_version: '1.6.0' };
        assert.equal(
            evaluateCondition('agent.version != target_version', scope),
            false,
        );
    });

    it('only runs in production with an explicit flag', () => {
        assert.equal(
            evaluateCondition('env == "prod" and not skip', { env: 'prod', skip: false }),
            true,
        );
        assert.equal(
            evaluateCondition('env == "prod" and not skip', { env: 'dev', skip: false }),
            false,
        );
    });

    it('reads the ok flag from a registered previous step', () => {
        const scope = { check: { ok: false, error: 'timeout' } };
        assert.equal(evaluateCondition('not check.ok', scope), true);
    });
});

describe('expression parse errors', () => {
    it('rejects unbalanced parentheses', () => {
        assert.throws(() => evaluateCondition('(1 == 1', {}), /parenthesis|token/i);
    });

    it('rejects unterminated strings', () => {
        assert.throws(() => evaluateCondition('"oops', {}), /Unterminated/);
    });

    it('rejects trailing garbage', () => {
        assert.throws(() => evaluateCondition('1 == 1 foo', {}), /trailing|Undefined/i);
    });
});
