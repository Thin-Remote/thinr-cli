import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    FALLBACK_LOGS_COMMAND,
    FALLBACK_LOGS_SOURCE_NAME,
    LOGS_PROPERTY,
    LOG_SOURCE_NAME_RE,
    MAX_LOG_SOURCES,
    fallbackLogsConfig,
    resolveDefaultLogSource,
    validateLogsConfig,
} from '../lib/product/logs.js';

describe('LOG_SOURCE_NAME_RE', () => {
    it('accepts slug-ish names up to 32 chars', () => {
        for (const name of ['thinger', 'system', 'auth-svc', 'app_1', 'A', '_', '-', 'a'.repeat(32)]) {
            assert.ok(LOG_SOURCE_NAME_RE.test(name), `expected "${name}" to be accepted`);
        }
    });

    it('rejects empty, too long, or non-slug names', () => {
        for (const name of ['', 'a'.repeat(33), 'has space', 'dots.bad', 'slash/bad', 'á']) {
            assert.equal(
                LOG_SOURCE_NAME_RE.test(name),
                false,
                `expected "${name}" to be rejected`,
            );
        }
    });
});

describe('validateLogsConfig — happy path', () => {
    it('returns a normalized clone of a valid config', () => {
        const input = {
            sources: [
                { name: 'thinger', command: 'docker logs -f thinger' },
                { name: 'system', command: 'journalctl -f' },
            ],
            default: 'thinger',
        };
        const out = validateLogsConfig(input);
        assert.deepEqual(out, input);
        assert.notEqual(out, input, 'should not return the same reference');
        assert.notEqual(out.sources, input.sources, 'should not return the same array');
    });

    it('omits default when not provided', () => {
        const out = validateLogsConfig({
            sources: [{ name: 'system', command: 'journalctl -f' }],
        });
        assert.deepEqual(out, { sources: [{ name: 'system', command: 'journalctl -f' }] });
        assert.equal('default' in out, false);
    });

    it('strips unknown keys at the source level by rejecting them', () => {
        // The validator is strict — extras should not be silently dropped, they
        // should fail loudly so the operator catches typos like "cmd" vs "command".
        assert.throws(
            () =>
                validateLogsConfig({
                    sources: [{ name: 'system', command: 'journalctl -f', kind: 'journal' }],
                }),
            /unknown key "kind"/,
        );
    });
});

describe('validateLogsConfig — error cases', () => {
    it('rejects non-objects at the root', () => {
        for (const v of [null, undefined, 'no', 42, true, []]) {
            assert.throws(() => validateLogsConfig(v), /logs must be an object/);
        }
    });

    it('rejects unknown keys at the root', () => {
        assert.throws(
            () => validateLogsConfig({ sources: [{ name: 's', command: 'x' }], extra: 1 }),
            /unknown key "extra"/,
        );
    });

    it('rejects missing or non-array sources', () => {
        assert.throws(
            () => validateLogsConfig({}),
            /sources is required/,
        );
        assert.throws(
            () => validateLogsConfig({ sources: 'no' }),
            /sources is required/,
        );
    });

    it('rejects an empty sources array', () => {
        assert.throws(
            () => validateLogsConfig({ sources: [] }),
            /at least one source/,
        );
    });

    it('rejects more than MAX_LOG_SOURCES sources', () => {
        const sources = Array.from({ length: MAX_LOG_SOURCES + 1 }, (_, i) => ({
            name: `s${i}`,
            command: 'x',
        }));
        assert.throws(
            () => validateLogsConfig({ sources }),
            /at most/,
        );
    });

    it('rejects a duplicate source name', () => {
        assert.throws(
            () =>
                validateLogsConfig({
                    sources: [
                        { name: 'system', command: 'a' },
                        { name: 'system', command: 'b' },
                    ],
                }),
            /"system" is duplicated/,
        );
    });

    it('rejects an invalid source name', () => {
        assert.throws(
            () =>
                validateLogsConfig({
                    sources: [{ name: 'has space', command: 'x' }],
                }),
            /must be a slug/,
        );
    });

    it('rejects an empty or non-string command', () => {
        assert.throws(
            () => validateLogsConfig({ sources: [{ name: 's', command: '' }] }),
            /command must be a non-empty string/,
        );
        assert.throws(
            () => validateLogsConfig({ sources: [{ name: 's', command: '   ' }] }),
            /command must be a non-empty string/,
        );
        assert.throws(
            () => validateLogsConfig({ sources: [{ name: 's', command: 42 }] }),
            /command must be a non-empty string/,
        );
    });

    it('rejects a non-object source entry', () => {
        assert.throws(
            () => validateLogsConfig({ sources: ['no'] }),
            /must be an object/,
        );
    });

    it('rejects a default that does not match any source', () => {
        assert.throws(
            () =>
                validateLogsConfig({
                    sources: [{ name: 'system', command: 'x' }],
                    default: 'thinger',
                }),
            /does not match any source/,
        );
    });

    it('rejects a non-string default', () => {
        assert.throws(
            () =>
                validateLogsConfig({
                    sources: [{ name: 's', command: 'x' }],
                    default: 1,
                }),
            /must be a string/,
        );
    });
});

describe('resolveDefaultLogSource', () => {
    it('returns the entry matching `default`', () => {
        const cfg = validateLogsConfig({
            sources: [
                { name: 'a', command: 'x' },
                { name: 'b', command: 'y' },
            ],
            default: 'b',
        });
        assert.deepEqual(resolveDefaultLogSource(cfg), { name: 'b', command: 'y' });
    });

    it('falls back to the first source when no default is set', () => {
        const cfg = validateLogsConfig({
            sources: [
                { name: 'a', command: 'x' },
                { name: 'b', command: 'y' },
            ],
        });
        assert.deepEqual(resolveDefaultLogSource(cfg), { name: 'a', command: 'x' });
    });
});

describe('fallbackLogsConfig', () => {
    it('builds a single-source config with the journalctl fallback command', () => {
        const cfg = fallbackLogsConfig();
        assert.deepEqual(cfg, {
            sources: [{ name: FALLBACK_LOGS_SOURCE_NAME, command: FALLBACK_LOGS_COMMAND }],
            default: FALLBACK_LOGS_SOURCE_NAME,
        });
        // The fallback must itself satisfy the validator so consumers can
        // treat configured and synthetic configs uniformly.
        assert.deepEqual(validateLogsConfig(cfg), cfg);
    });
});

describe('LOGS_PROPERTY', () => {
    it('is the literal string "logs"', () => {
        assert.equal(LOGS_PROPERTY, 'logs');
    });
});
