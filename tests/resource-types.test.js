import './setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTools } from '@thinger-io/cli-core/mcp/registry';
import { tools as thinrTools } from '../lib/mcp/registry.js';
import { resourceHooks } from '../lib/mcp/resource-hooks.js';
import { resourceActions, resourceTypes } from '../lib/mcp/resource-types.js';

const tools = buildTools(thinrTools, {
    hooks: resourceHooks,
    types: resourceTypes,
    actions: resourceActions,
});
const call = (name, args) => tools.find((t) => t.name === `thinr_${name}`).handler(args);
const textOf = (result) => result.content.map((c) => c.text).join('\n');

const PLAYBOOK = `name: deploy
target:
    product: gateways
steps:
    - name: Write to a temporary file
      action: write
      path: /tmp/app.conf.new
      content: "port=8080"
    - name: Move it into place
      action: move
      source: /tmp/app.conf.new
      destination: /etc/app.conf
      overwrite: true
    - name: Drop the old backup
      action: delete
      path: /etc/app.conf.bak
`;

// What runs without a server: the playbook actions on YAML given inline,
// what resource_describe shows, and the checks of device_exec.
describe('thinr resource types', () => {
    const playbook = { type: 'product_playbook', parent: 'gateways' };

    it('validates an unsaved playbook, with move and delete steps', async () => {
        const ok = await call('resource_call', {
            ...playbook,
            action: 'validate',
            body: { content: PLAYBOOK },
        });
        assert.equal(ok.isError, false);
        const summary = JSON.parse(textOf(ok));
        assert.equal(summary.valid, true);
        assert.deepEqual(
            summary.steps.map((s) => s.action),
            ['write', 'move', 'delete'],
        );
        const bad = await call('resource_call', {
            ...playbook,
            action: 'validate',
            body: { content: PLAYBOOK.replace('action: move', 'action: mv') },
        });
        assert.equal(bad.isError, true);
        assert.match(textOf(bad), /mv/);
    });

    it('plans a run of an unsaved playbook on the product, without contacting devices', async () => {
        const plan = JSON.parse(
            textOf(
                await call('resource_call', {
                    ...playbook,
                    action: 'run',
                    body: { content: PLAYBOOK, device: 'gw_1', dry_run: true },
                }),
            ),
        );
        assert.equal(plan.dry_run, true);
        assert.equal(plan.target.product, 'gateways');
        assert.deepEqual(plan.target.devices, ['gw_1']);
        assert.equal(plan.steps.length, 3);
    });

    it('asks for a playbook to act on', async () => {
        await assert.rejects(
            call('resource_call', { ...playbook, action: 'run', body: { device: 'gw_1' } }),
            /give the playbook/,
        );
        // A run needs exactly one target: never the whole product by omission.
        for (const body of [
            { content: PLAYBOOK },
            { content: PLAYBOOK, device: 'a', group: 'g' },
        ]) {
            await assert.rejects(
                call('resource_call', { ...playbook, action: 'run', body }),
                /give one target in the body/,
            );
        }
        await assert.rejects(
            call('resource_call', { type: 'product_playbook', action: 'validate', body: {} }),
            /parent \(<product>\) is required/,
        );
    });

    it('describes the playbook format and the log presets', async () => {
        const pb = textOf(await call('resource_describe', { type: 'product_playbook' }));
        assert.match(pb, /^playbook_format: \{/m);
        assert.match(pb, /"validate":\{"run":"thinr_resource_call action \\"validate\\""/);
        const logs = textOf(await call('resource_describe', { type: 'product_log_source' }));
        assert.match(logs, /^presets: \{.*"journalctl"/m);
        const fs = textOf(await call('resource_describe', { type: 'device_fs' }));
        assert.match(fs, /^parent: device \(write it as "<device>"\)/m);
        assert.match(fs, /"pull":/);
        const summary = textOf(await call('resource_describe', {}));
        assert.match(summary, /^device: .*\| .*agent_update agent_install\]$/m);
    });

    it('validates unsaved playbook variables before running', async () => {
        const withVars = PLAYBOOK.replace(
            'steps:',
            'vars:\n    port: { default: 8080, type: number, overridable: true }\nsteps:',
        );
        const run = (vars) =>
            call('resource_call', {
                ...playbook,
                action: 'run',
                body: { content: withVars, device: 'gw_1', dry_run: true, vars },
            });
        const plan = JSON.parse(textOf(await run({ port: 9090 })));
        assert.equal(plan.vars.port, 9090);
        await assert.rejects(run({ prot: 9090 }), /prot/);
        await assert.rejects(run({ port: 'x' }), /port/);
    });

    it('device_exec needs exactly one kind of target', async () => {
        await assert.rejects(call('device_exec', { command: 'uptime' }), /give the target/);
        await assert.rejects(
            call('device_exec', { command: 'uptime', device: 'a', product: 'p' }),
            /give one kind of target/,
        );
        await assert.rejects(call('device_exec', { device: 'a' }), /command is required/);
    });
});
