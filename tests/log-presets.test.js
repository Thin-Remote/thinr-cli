import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    LEVEL_SEVERITY,
    getPreset,
    levelPassesThreshold,
    parseLogLine,
} from '../lib/product/log-presets.js';

function compile(presetName) {
    const p = getPreset(presetName);
    assert.ok(p, `expected preset "${presetName}" to be registered`);
    return new RegExp(p.pattern);
}

describe('parseLogLine', () => {
    it('returns null when the line does not match', () => {
        const re = /^(?<level>\w+)\| (?<msg>.*)$/;
        assert.equal(parseLogLine('no match here', re), null);
    });

    it('returns null when regex is null (caller convenience)', () => {
        assert.equal(parseLogLine('anything', null), null);
    });

    it('extracts time / level / msg with named groups', () => {
        const re = /^(?<time>\S+)\s+(?<level>\w+)\s+(?<msg>.*)$/;
        const out = parseLogLine('12:00:01 INFO booting', re);
        assert.deepEqual(out, {
            time: '12:00:01',
            level: 'INFO',
            level_norm: 'info',
            msg: 'booting',
        });
    });

    it('omits absent groups but still returns the match', () => {
        const re = /^(?<time>\S+)\s+(?<msg>.*)$/;
        const out = parseLogLine('12:00:01 booting', re);
        assert.equal(out.time, '12:00:01');
        assert.equal(out.msg, 'booting');
        assert.equal(out.level, undefined);
        assert.equal(out.level_norm, undefined);
    });
});

describe('preset: journalctl', () => {
    it('parses a typical journalctl --output=short line', () => {
        const re = compile('journalctl');
        const out = parseLogLine(
            'Jan 02 12:34:56 host systemd[1]: Started Some Unit.',
            re,
        );
        assert.ok(out, 'expected the line to match');
        assert.equal(out.time, 'Jan 02 12:34:56');
        // No level captured for journalctl short.
        assert.equal(out.level, undefined);
        assert.match(out.msg, /Started Some Unit/);
    });
});

describe('preset: spdlog (thinger flavour)', () => {
    it('parses a thinger-style spdlog line and captures the level', () => {
        const re = compile('spdlog');
        const out = parseLogLine(
            '2025-04-29 15:03:12.456 (   1234) [worker thread 1] thinger.cpp:42  INFO| connecting to broker',
            re,
        );
        assert.ok(out, 'expected the line to match');
        assert.equal(out.time, '2025-04-29 15:03:12.456');
        assert.equal(out.level, 'INFO');
        assert.equal(out.level_norm, 'info');
        assert.equal(out.msg, 'connecting to broker');
    });

    it('captures WARN and ERROR levels too', () => {
        const re = compile('spdlog');
        const warn = parseLogLine(
            '2025-04-29 15:03:12.456 (   1234) [worker thread 1] thinger.cpp:42  WARN| slow query',
            re,
        );
        assert.equal(warn.level_norm, 'warn');
        const err = parseLogLine(
            '2025-04-29 15:03:12.456 (   1234) [worker thread 1] thinger.cpp:42  ERROR| boom',
            re,
        );
        assert.equal(err.level_norm, 'error');
    });

    it('does not match an unrelated line', () => {
        const re = compile('spdlog');
        assert.equal(parseLogLine('not a spdlog line', re), null);
    });
});

describe('preset: spdlog-bracket', () => {
    it('parses default spdlog "[time] [logger] [level] msg" lines', () => {
        const re = compile('spdlog-bracket');
        const out = parseLogLine(
            '[2025-04-29 15:03:12.456] [main] [info] booting up',
            re,
        );
        assert.ok(out, 'expected the line to match');
        assert.equal(out.level_norm, 'info');
        assert.equal(out.msg, 'booting up');
    });
});

describe('preset: nginx-error', () => {
    it('parses an nginx error log line', () => {
        const re = compile('nginx-error');
        const out = parseLogLine(
            '2025/04/29 15:03:12 [error] 1234#0: *1 connect() failed',
            re,
        );
        assert.ok(out, 'expected the line to match');
        assert.equal(out.time, '2025/04/29 15:03:12');
        assert.equal(out.level_norm, 'error');
        assert.match(out.msg, /connect\(\) failed/);
    });
});

describe('preset: nginx-access', () => {
    it('parses an nginx CLF-style line and captures time inside brackets', () => {
        const re = compile('nginx-access');
        const out = parseLogLine(
            '127.0.0.1 - - [29/Apr/2025:15:03:12 +0000] "GET / HTTP/1.1" 200 12 "-" "curl"',
            re,
        );
        assert.ok(out, 'expected the line to match');
        assert.equal(out.time, '29/Apr/2025:15:03:12 +0000');
        // Access logs do not carry a level.
        assert.equal(out.level, undefined);
    });
});

describe('LEVEL_SEVERITY', () => {
    it('orders levels from least to most severe', () => {
        assert.ok(LEVEL_SEVERITY.trace <= LEVEL_SEVERITY.debug);
        assert.ok(LEVEL_SEVERITY.debug < LEVEL_SEVERITY.info);
        assert.ok(LEVEL_SEVERITY.info < LEVEL_SEVERITY.warn);
        assert.ok(LEVEL_SEVERITY.warn < LEVEL_SEVERITY.error);
        assert.ok(LEVEL_SEVERITY.error < LEVEL_SEVERITY.fatal);
    });
});

describe('levelPassesThreshold', () => {
    it('passes everything at threshold "all"', () => {
        for (const lvl of ['trace', 'debug', 'info', 'warn', 'error', 'fatal', undefined]) {
            assert.equal(levelPassesThreshold(lvl, 'all'), true);
        }
    });

    it('drops debug at threshold "info" but keeps info+', () => {
        assert.equal(levelPassesThreshold('debug', 'info'), false);
        assert.equal(levelPassesThreshold('info', 'info'), true);
        assert.equal(levelPassesThreshold('warn', 'info'), true);
    });

    it('drops info at threshold "warn"', () => {
        assert.equal(levelPassesThreshold('info', 'warn'), false);
        assert.equal(levelPassesThreshold('warn', 'warn'), true);
        assert.equal(levelPassesThreshold('error', 'warn'), true);
    });

    it('drops warn at threshold "error" but keeps fatal', () => {
        assert.equal(levelPassesThreshold('warn', 'error'), false);
        assert.equal(levelPassesThreshold('error', 'error'), true);
        assert.equal(levelPassesThreshold('fatal', 'error'), true);
    });

    it('passes lines without a captured level (cannot classify)', () => {
        assert.equal(levelPassesThreshold(undefined, 'warn'), true);
        assert.equal(levelPassesThreshold(null, 'error'), true);
    });

    it('treats an unknown level as info', () => {
        assert.equal(levelPassesThreshold('verbose', 'warn'), false);
        assert.equal(levelPassesThreshold('verbose', 'info'), true);
    });
});
