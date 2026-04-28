import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaybook } from '../lib/playbook/loader.js';
import { buildDryRunPlan } from '../lib/playbook/runner.js';

describe('buildDryRunPlan', () => {
    it('returns one entry per step, in order, with the action summary', () => {
        const pb = parsePlaybook(`
target:
  product: demo
steps:
  - name: boot check
    action: exec
    command: uptime
  - action: sleep
    seconds: 2
`);
        const plan = buildDryRunPlan(pb);
        assert.equal(plan.length, 2);
        assert.equal(plan[0].index, 0);
        assert.equal(plan[0].name, 'boot check');
        assert.equal(plan[0].action, 'exec');
        assert.match(plan[0].summary, /uptime/);
        assert.equal(plan[1].action, 'sleep');
        assert.match(plan[1].summary, /sleep 2s/);
    });

    it('resolves variables into the summary', () => {
        const pb = parsePlaybook(`
target:
  product: demo
vars:
  svc: nginx
steps:
  - action: exec
    command: "systemctl restart {{ svc }}"
`);
        const plan = buildDryRunPlan(pb);
        assert.match(plan[0].summary, /systemctl restart nginx/);
    });

    it('substitutes the implicit `device` variable with a placeholder', () => {
        const pb = parsePlaybook(`
target:
  product: demo
steps:
  - action: exec
    command: "echo {{ device }}"
`);
        const plan = buildDryRunPlan(pb);
        assert.match(plan[0].summary, /echo <device>/);
    });

    it('carries pause_after through to the plan', () => {
        const pb = parsePlaybook(`
target:
  product: demo
steps:
  - action: exec
    command: hostname
    pause_after: 3
`);
        const plan = buildDryRunPlan(pb);
        assert.equal(plan[0].pause_after, 3);
    });

    it('throws on a reference to a variable that was not declared', () => {
        const pb = parsePlaybook(`
target:
  product: demo
steps:
  - action: exec
    command: "echo {{ ghost }}"
`);
        assert.throws(() => buildDryRunPlan(pb), /Undefined playbook variable: ghost/);
    });

    it('uses declared defaults when overrides are provided but empty', () => {
        const pb = parsePlaybook(`
target:
  product: demo
vars:
  svc: nginx
steps:
  - action: exec
    command: "systemctl restart {{ svc }}"
`);
        const plan = buildDryRunPlan(pb, { overrides: {} });
        assert.match(plan[0].summary, /systemctl restart nginx/);
    });

    it('applies per-run overrides into the resolved summary', () => {
        const pb = parsePlaybook(`
target:
  product: demo
vars:
  svc: nginx
steps:
  - action: exec
    command: "systemctl restart {{ svc }}"
`);
        const plan = buildDryRunPlan(pb, { overrides: { svc: 'redis' } });
        assert.match(plan[0].summary, /systemctl restart redis/);
    });

    it('rejects overrides for variables that do not exist in the playbook', () => {
        const pb = parsePlaybook(`
target:
  product: demo
steps:
  - action: sleep
    seconds: 1
`);
        assert.throws(
            () => buildDryRunPlan(pb, { overrides: { ghost: '1' } }),
            /Unknown playbook variable: ghost/,
        );
    });

    it('fails when a required variable has no default and no override', () => {
        const pb = parsePlaybook(`
target:
  product: demo
vars:
  release:
    type: string
    required: true
steps:
  - action: exec
    command: "deploy {{ release }}"
`);
        assert.throws(
            () => buildDryRunPlan(pb, { overrides: {} }),
            /Required playbook variable "release" has no value/,
        );
    });
});
