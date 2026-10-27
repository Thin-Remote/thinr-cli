// @ts-check
import './setup.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import api from '@thinger-io/cli-core/api';
import { buildProgram } from '@thinger-io/cli-core/cli';
import { checkGrammar } from '@thinger-io/cli-core/commands/grammar';
import { setJsonMode } from '@thinger-io/cli-core/output';
import { cliOptions, grammarExceptions } from '../lib/cli.js';

// The grammar and its checker live in cli-core; these check that the tree
// thinr runs (the core's commands plus thinr's own) follows it, with the
// exceptions thinr states, and that the generic commands thinr's used to
// hide (`device update`, `product property`) reach the server.
const build = () => buildProgram({ version: '0.0.0', ...cliOptions, strict: true });

/** A token whose user is `acme`, for the environment profile. */
const jwt = `x.${Buffer.from(JSON.stringify({ usr: 'acme' })).toString('base64url')}.y`;

before(() => {
    process.env.THINR_TOKEN = jwt;
    process.env.THINR_SERVER = 'http://stub';
});
after(() => {
    delete process.env.THINR_TOKEN;
    delete process.env.THINR_SERVER;
});

/** Throw instead of exiting on a parse error, in the whole tree. */
function throwing(cmd) {
    cmd.exitOverride();
    for (const sub of cmd.commands) throwing(sub);
    return cmd;
}

/** Find a command by its path. */
const find = (program, path) =>
    path.split(' ').reduce((cmd, n) => cmd?.commands.find((c) => c.name() === n), program);

/** Run `thinr …` against a stubbed server answering `data`: the requests and stdout. */
async function run(argv, data = {}) {
    const calls = [];
    const out = [];
    const saved = { adapter: api.defaults.adapter, log: console.log, write: process.stdout.write };
    api.defaults.adapter = async (config) => {
        calls.push(config);
        return { data, status: 200, statusText: 'OK', headers: {}, config };
    };
    console.log = (...a) => out.push(a.join(' '));
    // @ts-ignore -- captured for the test
    process.stdout.write = (chunk) => out.push(String(chunk)) || true;
    try {
        await throwing(build()).parseAsync(['node', 'thinr', ...argv]);
    } finally {
        api.defaults.adapter = saved.adapter;
        console.log = saved.log;
        process.stdout.write = saved.write;
        setJsonMode(false);
    }
    return { calls, out: out.join('\n') };
}

describe('thinr command grammar', () => {
    it('follows the grammar of cli-core, with its exceptions', () => {
        assert.deepEqual(checkGrammar(build(), { exceptions: grammarExceptions }), []);
    });

    it('has the commands of 1.6 and none of the old forms', () => {
        const program = build();
        for (const path of [
            'agent check',
            'agent update',
            'product device-property',
            'product device-resource',
            'product metric list',
            'product metric set',
            'product metric delete',
            'product logs create',
            'product logs get',
            'product logs delete',
            'device update',
            'product property list',
        ]) {
            assert.ok(find(program, path), `missing ${path}`);
        }
        for (const path of [
            'fleet',
            'device update check',
            'product metric-list',
            'product metric-set',
            'product resource',
            'product logs add',
            'product logs show',
            'product logs remove',
        ]) {
            assert.equal(find(program, path), undefined, `still there: ${path}`);
        }
        assert.deepEqual(
            find(program, 'product logs')
                ?.commands.find((c) => c.name() === 'delete')
                ?.aliases(),
            [],
        );
        const usage = (path) => find(program, path)?.usage();
        assert.equal(usage('device exec'), '[options] <device> <command...>');
        assert.equal(usage('product status'), '[options] <product>');
    });

    it('reaches the generic commands its own used to hide', async () => {
        const update = await run(['device', 'update', 'gw1', '-s', 'name=Gateway']);
        assert.equal(update.calls.length, 1);
        assert.equal(update.calls[0].method, 'put');
        assert.equal(update.calls[0].url, '/v1/users/acme/devices/gw1');
        assert.deepEqual(JSON.parse(update.calls[0].data), { name: 'Gateway' });

        const props = await run(
            ['product', 'property', 'list', 'rpi', '-j'],
            [{ property: 'logs', value: {} }],
        );
        assert.equal(props.calls[0].method, 'get');
        assert.match(props.calls[0].url, /\/products\/rpi\/properties$/);
        assert.deepEqual(JSON.parse(props.out).data, [{ property: 'logs', value: {} }]);
    });

    it('takes the input of product device-resource from -s, as JSON', async () => {
        const { calls } = await run(
            ['product', 'device-resource', 'rpi', 'reboot', '-s', 'delay=5', '-j'],
            [{ device: 'gw1', connection: { active: true } }],
        );
        // The devices of the product, then the call on each.
        assert.match(calls[0].url, /\/devices\?count=50&product=rpi&index=0$/);
        assert.equal(calls[1].method, 'post');
        assert.match(calls[1].url, /\/devices\/gw1\/resources\/reboot$/);
        assert.deepEqual(JSON.parse(calls[1].data), { delay: 5 });
    });

    it('refuses agent update without a device or --all, and fleet options with a device', async () => {
        const exit = process.exit;
        const codes = [];
        // @ts-ignore -- printErr exits: record it instead
        process.exit = (c) => {
            codes.push(c);
            throw new Error('exit');
        };
        try {
            for (const argv of [
                ['agent', 'update', '-j'],
                ['agent', 'update', 'gw1', '--all', '-j'],
                ['agent', 'update', 'gw1', '-p', 'rpi', '-j'],
            ]) {
                const { calls } = await run(argv).catch(() => ({ calls: [] }));
                assert.equal(calls.length, 0, argv.join(' '));
            }
        } finally {
            process.exit = exit;
        }
        assert.deepEqual(codes, [1, 1, 1]);
    });
});
