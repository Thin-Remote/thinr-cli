import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaybook } from '../lib/playbook/loader.js';

const minimal = `
target:
  product: demo
steps:
  - name: ping
    action: exec
    command: hostname
`;

describe('parsePlaybook — happy path', () => {
    it('parses a minimal playbook', () => {
        const pb = parsePlaybook(minimal);
        assert.equal(pb.target.product, 'demo');
        assert.equal(pb.target.concurrency, 10);
        assert.equal(pb.target.fail_fast, false);
        assert.equal(pb.steps.length, 1);
        assert.equal(pb.steps[0].action, 'exec');
        assert.equal(pb.steps[0].name, 'ping');
        assert.equal(pb.steps[0].params.command, 'hostname');
        assert.equal(pb.steps[0].pause_after, 0);
    });

    it('accepts target.devices as an alternative to target.product', () => {
        const pb = parsePlaybook(`
target:
  devices: [d1, d2]
steps:
  - action: sleep
    seconds: 1
`);
        assert.deepEqual(pb.target.devices, ['d1', 'd2']);
        assert.equal(pb.target.product, null);
    });

    it('falls back to the action summary when a step name is missing', () => {
        const pb = parsePlaybook(`
target:
  product: demo
steps:
  - action: exec
    command: hostname
`);
        assert.equal(pb.steps[0].name, 'exec: hostname');
    });

    it('propagates vars as a plain object', () => {
        const pb = parsePlaybook(`
target:
  product: demo
vars:
  version: "1.2.3"
  port: 8080
steps:
  - action: sleep
    seconds: 1
`);
        assert.deepEqual(pb.vars, { version: '1.2.3', port: 8080 });
    });
});

describe('parsePlaybook — validation errors', () => {
    it('rejects invalid YAML with a descriptive message', () => {
        assert.throws(
            () => parsePlaybook('target: product: [unterminated'),
            /Invalid YAML/,
        );
    });

    it('rejects a root that is not a mapping', () => {
        assert.throws(() => parsePlaybook('- a\n- b\n'), /root must be a YAML mapping/);
    });

    it('requires target.product or target.devices', () => {
        assert.throws(
            () => parsePlaybook(`target: {}\nsteps:\n  - action: sleep\n    seconds: 1`),
            /`target.product` or `target.devices` must be provided/,
        );
    });

    it('rejects an unknown action and names it in the error', () => {
        assert.throws(
            () =>
                parsePlaybook(`
target:
  product: demo
steps:
  - action: teleport
    destination: mars
`),
            /unknown action "teleport"/,
        );
    });

    it('rejects a step missing a required parameter', () => {
        assert.throws(
            () =>
                parsePlaybook(`
target:
  product: demo
steps:
  - action: exec
`),
            /`command` is required for action "exec"/,
        );
    });

    it('rejects an empty steps list', () => {
        assert.throws(
            () => parsePlaybook(`target:\n  product: demo\nsteps: []\n`),
            /`steps` must be a non-empty list/,
        );
    });

    it('rejects a non-positive concurrency', () => {
        assert.throws(
            () =>
                parsePlaybook(`
target:
  product: demo
  concurrency: 0
steps:
  - action: sleep
    seconds: 1
`),
            /`target.concurrency` must be a positive integer/,
        );
    });

    it('rejects a negative pause_after', () => {
        assert.throws(
            () =>
                parsePlaybook(`
target:
  product: demo
steps:
  - action: sleep
    seconds: 1
    pause_after: -5
`),
            /`pause_after` must be a non-negative number/,
        );
    });

    it('accumulates multiple validation errors into a single message', () => {
        try {
            parsePlaybook(`
target: {}
steps:
  - action: fake
`);
            assert.fail('expected parsePlaybook to throw');
        } catch (err) {
            assert.match(err.message, /target\.product.*or.*target\.devices/);
            assert.match(err.message, /unknown action "fake"/);
        }
    });
});
