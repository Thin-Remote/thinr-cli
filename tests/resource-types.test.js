import './setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import api from '@thinger-io/cli-core/api';
import { buildTools } from '@thinger-io/cli-core/mcp/registry';
import { resourceHooks } from '../lib/mcp/resource-hooks.js';
import { resourceActions, resourceTypes } from '../lib/mcp/resource-types.js';

const tools = buildTools({
    hooks: resourceHooks,
    types: resourceTypes,
    actions: resourceActions,
});
const call = (name, args, extra) =>
    tools.find((t) => t.name === `thinr_${name}`).handler(args, extra);
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

/** A token whose user is `acme`, for the environment profile. */
const jwt = `x.${Buffer.from(JSON.stringify({ usr: 'acme' })).toString('base64url')}.y`;

/** Run `fn` against a stubbed server: `route(method, url, data)` answers. */
async function withServer(route, fn) {
    const calls = [];
    const saved = api.defaults.adapter;
    process.env.THINR_TOKEN = jwt;
    process.env.THINR_SERVER = 'http://stub';
    api.defaults.adapter = async (config) => {
        const data = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
        calls.push({ method: config.method, url: config.url, data });
        return {
            data: await route(config.method, config.url, data),
            status: 200,
            headers: {},
            config,
        };
    };
    try {
        await fn(calls);
    } finally {
        api.defaults.adapter = saved;
        delete process.env.THINR_TOKEN;
        delete process.env.THINR_SERVER;
    }
}

// What runs without a server: the playbook actions on YAML given inline,
// what resource_describe shows, and the checks of the exec action.
describe('thinr resource types', () => {
    const playbook = { type: 'product_playbook', ids: { product: 'gateways' } };

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
            /missing product/,
        );
    });

    it('describes the playbook format, the ids and the checked product properties', async () => {
        const pb = textOf(await call('resource_describe', { type: 'product_playbook' }));
        assert.match(pb, /^playbook_format: \{/m);
        assert.match(pb, /^ids: \{"product": <product id>, "playbook": <its own id>\}$/m);
        assert.match(
            pb,
            /"validate":\{"run":"thinr_resource_call type \\"product_playbook\\" action \\"validate\\""/,
        );
        const props = textOf(await call('resource_describe', { type: 'product_property' }));
        assert.match(props, /^cli: \{"logs":.*"presets":\{.*"journalctl"/m);
        assert.match(props, /"dashboard_metrics":\{.*"element":/);
        const fs = textOf(await call('resource_describe', { type: 'device_fs' }));
        assert.match(fs, /^ids: \{"device": <device id>, "path": <its own id>\}$/m);
        assert.match(fs, /"pull":/);
        const script = textOf(await call('resource_describe', { type: 'device_script' }));
        assert.match(script, /^own_id: required: in ids.script, or the body field "name"$/m);
        const summary = textOf(await call('resource_describe', {}));
        assert.match(summary, /^device: .*\| .*exec agent_update agent_install\]$/m);
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

    it('exec needs a command and exactly one kind of target', async () => {
        const exec = (args) => call('resource_call', { type: 'device', action: 'exec', ...args });
        await assert.rejects(exec({ body: { command: 'uptime' } }), /give the target/);
        await assert.rejects(
            exec({ ids: { device: 'a' }, body: { command: 'uptime', product: 'p' } }),
            /give one kind of target/,
        );
        await assert.rejects(exec({ ids: { device: 'a' }, body: {} }), /needs command/);
        await assert.rejects(exec({ ids: { device: 'a' } }), /device.exec needs a body/);
        await assert.rejects(
            exec({ body: { command: 'uptime', device: 'a' } }),
            /pass the device in ids \(\{"device": "a"\}\)/,
        );
    });

    it('exec on several devices answers its targets until confirmed', async () => {
        const devices = [
            { device: 'gw_1', product: 'gateways', connection: { active: true } },
            { device: 'gw_2', product: 'gateways', connection: { active: true } },
        ];
        await withServer(
            (method, url) => (method === 'get' && /\/devices/.test(url) ? devices : {}),
            async (calls) => {
                const result = await call('resource_call', {
                    type: 'device',
                    action: 'exec',
                    body: { command: 'reboot', product: 'gateways' },
                });
                const text = textOf(result);
                assert.match(text, /It would run `reboot` on 2 device\(s\): gw_1, gw_2\./);
                assert.match(text, /Nothing was done\. Run again with confirm: true/);
                assert.ok(calls.every((c) => c.method === 'get'));
                // Asked through the client, which says no: still nothing runs.
                const declined = await call(
                    'resource_call',
                    {
                        type: 'device',
                        action: 'exec',
                        body: { command: 'reboot', product: 'gateways' },
                    },
                    { elicit: async () => false },
                );
                assert.match(textOf(declined), /The user did not confirm it: nothing was done/);
                assert.ok(calls.every((c) => c.method === 'get'));
            },
        );
    });

    it('a playbook rollout or a run on several devices answers its plan until confirmed', async () => {
        const devices = [{ device: 'gw_1', product: 'gateways', connection: { active: true } }];
        await withServer(
            (method, url) => (method === 'get' && /\/devices/.test(url) ? devices : {}),
            async () => {
                const run = await call('resource_call', {
                    ...playbook,
                    action: 'run',
                    body: { content: PLAYBOOK, all: true },
                });
                assert.match(
                    textOf(run),
                    /It would run the playbook given in body.content now on every device of product "gateways" \(1: gw_1\), all at once\./,
                );
            },
        );
    });
});

describe('product properties thinr reads', () => {
    it('are checked whole before they reach the server', async () => {
        await withServer(
            () => ({}),
            async (calls) => {
                const create = (body) =>
                    call('resource_create', {
                        type: 'product_property',
                        ids: { product: 'gateways' },
                        body,
                    });
                await assert.rejects(
                    create({
                        property: 'logs',
                        value: { sources: [{ name: 'a b', command: 'x' }] },
                    }),
                    /logs.sources\[0\].name must be a slug/,
                );
                await assert.rejects(
                    create({
                        property: 'dashboard_metrics',
                        value: [{ name: 'cpu', resource: 'cpu', aggregation: 'median' }],
                    }),
                    /dashboard_metrics\[0\]: metric.aggregation must be one of/,
                );
                await assert.rejects(
                    create({
                        property: 'dashboard_metrics',
                        value: [
                            { name: 'cpu', resource: 'cpu' },
                            { name: 'cpu', resource: 'load' },
                        ],
                    }),
                    /dashboard_metrics\[1\].name "cpu" is duplicated/,
                );
                await assert.rejects(
                    call('resource_update', {
                        type: 'product_property',
                        ids: { product: 'gateways', property: 'logs' },
                        merge: true,
                        body: { value: { default: 'app' } },
                    }),
                    /logs is written whole: update it without merge/,
                );
                assert.equal(calls.length, 0);
                await create({
                    property: 'logs',
                    value: { sources: [{ name: 'app', command: 'journalctl -f -u app' }] },
                });
                await create({ property: 'other', value: { anything: true } });
                assert.equal(calls.length, 2);
                assert.deepEqual(calls[0].data.value, {
                    sources: [{ name: 'app', command: 'journalctl -f -u app' }],
                });
            },
        );
    });
});
