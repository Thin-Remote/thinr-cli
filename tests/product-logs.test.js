import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    FALLBACK_LOGS_COMMAND,
    FALLBACK_LOGS_SOURCE_NAME,
    LOGS_PROPERTY,
    LOG_SOURCE_NAME_RE,
    MAX_LOG_SOURCES,
    addLogSource,
    compileLogPattern,
    fallbackLogsConfig,
    removeLogSource,
    resolveDefaultLogSource,
    resolveSourcePattern,
    setDefaultLogSource,
    validateLogsConfig,
} from '../lib/product/logs.js';
import { getPreset, listPresets } from '../lib/product/log-presets.js';

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

describe('addLogSource — pre-network validation', () => {
    it('rejects an invalid source name before touching the network', async () => {
        await assert.rejects(
            addLogSource('p', { name: 'has space', command: 'x' }),
            (err) => err.code === 'input_error' && /must be a slug/.test(err.message),
        );
    });

    it('rejects an empty / non-string command before touching the network', async () => {
        await assert.rejects(
            addLogSource('p', { name: 'sys', command: '' }),
            (err) =>
                err.code === 'input_error' && /command must be a non-empty string/.test(err.message),
        );
        await assert.rejects(
            addLogSource('p', { name: 'sys', command: 42 }),
            (err) =>
                err.code === 'input_error' && /command must be a non-empty string/.test(err.message),
        );
    });
});

describe('removeLogSource — pre-network validation', () => {
    it('requires a name', async () => {
        await assert.rejects(
            removeLogSource('p', ''),
            (err) => err.code === 'input_error' && /name is required/.test(err.message),
        );
        await assert.rejects(
            removeLogSource('p'),
            (err) => err.code === 'input_error' && /name is required/.test(err.message),
        );
    });
});

describe('setDefaultLogSource — pre-network validation', () => {
    it('rejects a non-string default before touching the network', async () => {
        await assert.rejects(
            setDefaultLogSource('p', 42),
            (err) => err.code === 'input_error' && /must be a string/.test(err.message),
        );
    });
});

describe('validateLogsConfig — pattern and preset', () => {
    it('accepts a source with a custom pattern', () => {
        const cfg = validateLogsConfig({
            sources: [
                {
                    name: 'custom',
                    command: 'tail -F /var/log/app.log',
                    pattern: '^(?<time>\\S+)\\s+(?<level>\\w+)\\s+(?<msg>.*)$',
                },
            ],
        });
        assert.equal(cfg.sources[0].pattern, '^(?<time>\\S+)\\s+(?<level>\\w+)\\s+(?<msg>.*)$');
    });

    it('accepts a source with a known preset', () => {
        const cfg = validateLogsConfig({
            sources: [
                { name: 'thinger', command: 'docker logs -f thinger', preset: 'spdlog' },
            ],
        });
        assert.equal(cfg.sources[0].preset, 'spdlog');
    });

    it('rejects a source with both pattern and preset', () => {
        assert.throws(
            () =>
                validateLogsConfig({
                    sources: [
                        {
                            name: 'x',
                            command: 'cat',
                            pattern: '^(?<msg>.*)$',
                            preset: 'spdlog',
                        },
                    ],
                }),
            /mutually exclusive/,
        );
    });

    it('rejects an unknown preset name', () => {
        assert.throws(
            () =>
                validateLogsConfig({
                    sources: [{ name: 'x', command: 'cat', preset: 'logfmt' }],
                }),
            /preset "logfmt" is unknown/,
        );
    });

    it('rejects a regex that does not compile', () => {
        assert.throws(
            () =>
                validateLogsConfig({
                    sources: [{ name: 'x', command: 'cat', pattern: '(?<unclosed>' }],
                }),
            /not a valid regular expression/,
        );
    });

    it('rejects an empty pattern string', () => {
        assert.throws(
            () =>
                validateLogsConfig({
                    sources: [{ name: 'x', command: 'cat', pattern: '' }],
                }),
            /pattern must be a non-empty regex/,
        );
    });

    it('rejects an empty preset string', () => {
        assert.throws(
            () =>
                validateLogsConfig({
                    sources: [{ name: 'x', command: 'cat', preset: '' }],
                }),
            /preset must be a non-empty preset name/,
        );
    });
});

describe('compileLogPattern', () => {
    it('returns a RegExp for a valid pattern', () => {
        const re = compileLogPattern('^(?<level>\\w+)$');
        assert.ok(re instanceof RegExp);
        assert.equal(re.exec('INFO').groups.level, 'INFO');
    });

    it('throws inputError for an invalid pattern', () => {
        assert.throws(
            () => compileLogPattern('('),
            (err) => err.code === 'input_error' && /not a valid regular expression/.test(err.message),
        );
    });
});

describe('resolveSourcePattern', () => {
    it('returns the literal pattern when set', () => {
        const out = resolveSourcePattern({ name: 'x', command: 'c', pattern: '^abc$' });
        assert.equal(out, '^abc$');
    });

    it('returns the preset pattern when preset is set', () => {
        const out = resolveSourcePattern({ name: 'x', command: 'c', preset: 'journalctl' });
        assert.equal(out, getPreset('journalctl').pattern);
    });

    it('returns null when neither is set', () => {
        assert.equal(resolveSourcePattern({ name: 'x', command: 'c' }), null);
    });

    it('returns null for an unknown preset', () => {
        assert.equal(
            resolveSourcePattern({ name: 'x', command: 'c', preset: 'nope' }),
            null,
        );
    });
});

describe('addLogSource — pattern/preset validation', () => {
    it('rejects pattern + preset together before touching the network', async () => {
        await assert.rejects(
            addLogSource('p', {
                name: 'x',
                command: 'cat',
                pattern: '^(?<msg>.*)$',
                preset: 'spdlog',
            }),
            (err) => err.code === 'input_error' && /mutually exclusive/.test(err.message),
        );
    });

    it('rejects an unknown preset before touching the network', async () => {
        await assert.rejects(
            addLogSource('p', { name: 'x', command: 'cat', preset: 'logfmt' }),
            (err) => err.code === 'input_error' && /unknown/.test(err.message),
        );
    });

    it('rejects an invalid pattern before touching the network', async () => {
        await assert.rejects(
            addLogSource('p', { name: 'x', command: 'cat', pattern: '(' }),
            (err) =>
                err.code === 'input_error' &&
                /not a valid regular expression/.test(err.message),
        );
    });
});

describe('listPresets', () => {
    it('exposes journalctl, spdlog, nginx-error, nginx-access', () => {
        const names = listPresets().map((p) => p.name);
        for (const wanted of ['journalctl', 'spdlog', 'nginx-error', 'nginx-access']) {
            assert.ok(names.includes(wanted), `expected preset "${wanted}" to be listed`);
        }
    });

    it('returns presets sorted by name', () => {
        const names = listPresets().map((p) => p.name);
        const sorted = [...names].sort((a, b) => a.localeCompare(b));
        assert.deepEqual(names, sorted);
    });

    it('returns shallow clones, not references to the catalog', () => {
        const a = listPresets();
        const b = listPresets();
        assert.notEqual(a, b);
        assert.notEqual(a[0], b[0]);
    });
});
