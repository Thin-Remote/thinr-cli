// @ts-check
import { filterActiveDevices, getDevices } from '@thinger-io/cli-core/devices';
import { getProduct, getProducts } from '@thinger-io/cli-core/product';
import { runPool } from '@thinger-io/cli-core/concurrency';
import { inputError } from '@thinger-io/cli-core/errors';
import { TIMEOUTS } from '../constants.js';
import { createDeviceAPI } from '../device-api.js';
import { runProductFanOut } from '../product-orchestrator.js';
import { getAPI } from './helpers.js';

/** Products thinr made or adopted: the ones whose devices run the agent. */
export const THINREMOTE_PRODUCT_TYPE = 'thinremote';

const positive = (n, fallback) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback);

/** One device: the output as the shell printed it, then the exit code. */
async function execOne(device, args, timeout) {
    const { api } = getAPI(device, args.user);
    let output = '';
    const { exitCode, timedOut } = await api.execStream(args.command, {
        timeout,
        onStdout: (s) => {
            output += s;
        },
        onStderr: (s) => {
            output += s;
        },
    });
    const trailer = [];
    if (timedOut) trailer.push(`[command timed out after ${timeout}s]`);
    trailer.push(`[exit code: ${exitCode ?? 'unknown'}]`);
    const text = [output.trimEnd(), trailer.join(' ')].filter(Boolean).join('\n');
    return {
        content: [{ type: 'text', text: text || '(no output)' }],
        isError: timedOut || exitCode !== 0,
    };
}

/**
 * The products of the account made for ThinRemote. The product list does
 * not carry `config`, so each one is read.
 */
async function thinremoteProducts(user) {
    const ids = (await getProducts(user)).map((p) => p.product);
    const read = await runPool(ids, 8, (id) => getProduct(id, user));
    return new Set(
        read
            .map((r, i) =>
                r?.ok && r.value?.config?.type === THINREMOTE_PRODUCT_TYPE ? ids[i] : null,
            )
            .filter(Boolean),
    );
}

/**
 * The devices a fleet call reaches: a list, a product (optionally one of
 * its groups), a group, or every device of the ThinRemote products.
 * Offline ones are left out unless asked for, and named when they were
 * asked for by id.
 *
 * @returns {Promise<{ devices: any[], offline: string[] }>}
 */
async function targetsOf(args) {
    let devices;
    let named = false;
    if (Array.isArray(args.devices) && args.devices.length) {
        named = true;
        const wanted = new Set(args.devices.map(String));
        const known = await getDevices({}, args.user);
        devices = known.filter((d) => wanted.has(d.device));
        const missing = [...wanted].filter((id) => !devices.some((d) => d.device === id));
        if (missing.length) throw inputError(`Unknown devices: ${missing.join(', ')}`);
    } else if (args.product || args.group) {
        const filter = {};
        if (args.product) filter.product = args.product;
        if (args.group) filter.asset_group = args.group;
        devices = await getDevices(filter, args.user);
    } else {
        const ids = await thinremoteProducts(args.user);
        devices = (await getDevices({}, args.user)).filter((d) => ids.has(d.product));
    }
    if (args.include_offline) return { devices, offline: [] };
    const active = filterActiveDevices(devices);
    const offline = named ? devices.filter((d) => !active.includes(d)).map((d) => d.device) : [];
    return { devices: active, offline };
}

/**
 * @param {Record<string, any>} args  The body, with `device` (ids.device) and `user`.
 * @param {import('@thinger-io/cli-core/mcp/tools-resource').LocalContext} [ctx]
 */
async function toolExec(args, ctx) {
    if (typeof args.command !== 'string' || !args.command.trim()) {
        throw inputError('body.command is required');
    }
    const listed = Array.isArray(args.devices) && args.devices.length > 0;
    const fleet = listed || args.product || args.group;
    const kinds = [args.device, listed, args.product || args.group, args.all].filter(Boolean);
    if (kinds.length > 1) {
        throw inputError(
            'give one kind of target: ids.device, or in the body `devices`, `product` (and `group`) or `group`, or `all`',
        );
    }
    if (!args.device && !fleet && !args.all) {
        throw inputError(
            'give the target: ids.device for one device; body `devices`, `product` or `group` for several; body `all: true` for every device of the ThinRemote products',
        );
    }
    // Default guards against hung commands locking the session; callers
    // override for known-long operations. Knob lives in lib/constants.js.
    const timeout = positive(args.timeout, TIMEOUTS.DEFAULT_EXEC_SECONDS);
    if (args.device && !args.dry_run) return execOne(args.device, args, timeout);

    const { devices, offline } = args.device
        ? { devices: [{ device: args.device }], offline: [] }
        : await targetsOf(args);
    const skipped = offline.length
        ? `\nNot connected, left out (include_offline to try them): ${offline.join(', ')}.`
        : '';
    if (args.dry_run) {
        const ids = devices.map((d) => d.device);
        return {
            content: [
                {
                    type: 'text',
                    text: `Would run \`${args.command}\` on ${ids.length} device(s)${ids.length ? `: ${ids.join(', ')}` : ''}.${skipped}`,
                },
            ],
            isError: false,
        };
    }
    if (devices.length === 0) {
        return {
            content: [{ type: 'text', text: `No connected devices match the target.${skipped}` }],
            isError: offline.length > 0,
        };
    }
    // On several devices it asks first: the plan names every target.
    if (!args.device && ctx?.plan && !ctx.confirmed) {
        const ids = devices.map((d) => d.device);
        return ctx.plan(
            `It would run \`${args.command}\` on ${ids.length} device(s): ${ids.join(', ')}.${skipped}`,
        );
    }

    const concurrency = positive(args.concurrency, 10);
    const { entries, durationMs } = await runProductFanOut({
        devices,
        user: args.user,
        concurrency,
        failFast: !!args.fail_fast,
        worker: async (device) => {
            const perStart = Date.now();
            let stdout = '';
            let stderr = '';
            try {
                const api = createDeviceAPI(device.device, { user: args.user || undefined });
                const { exitCode, timedOut } = await api.execStream(args.command, {
                    timeout,
                    onStdout: (s) => {
                        stdout += s;
                    },
                    onStderr: (s) => {
                        stderr += s;
                    },
                });
                return {
                    device: device.device,
                    ok: !timedOut && exitCode === 0,
                    exitCode: exitCode ?? null,
                    timedOut: !!timedOut,
                    durationMs: Date.now() - perStart,
                    stdout,
                    stderr,
                };
            } catch (err) {
                return {
                    device: device.device,
                    ok: false,
                    exitCode: null,
                    timedOut: false,
                    durationMs: Date.now() - perStart,
                    stdout,
                    stderr,
                    error: err instanceof Error ? err.message : String(err),
                };
            }
        },
        skipped: (device, firstFailure) => ({
            device: device.device,
            ok: false,
            exitCode: null,
            timedOut: false,
            durationMs: 0,
            stdout: '',
            stderr: '',
            error: `skipped (fail-fast after ${firstFailure})`,
        }),
        isFailure: (entry) => !entry.ok,
    });

    const okCount = entries.filter((e) => e.ok).length;
    const timedOutCount = entries.filter((e) => e.timedOut).length;
    const errorCount = entries.filter((e) => e.error).length;
    const failCount = entries.length - okCount - timedOutCount - errorCount;

    const lines = [
        `Ran \`${args.command}\` on ${entries.length} device(s) (concurrency=${concurrency}, timeout=${timeout}s).\n`,
    ];
    for (const e of entries) {
        const status = e.error
            ? `ERROR (${e.error})`
            : e.timedOut
              ? `TIMEOUT after ${timeout}s`
              : e.ok
                ? `OK exit=0`
                : `FAIL exit=${e.exitCode}`;
        lines.push(`--- ${e.device} [${status}] ${e.durationMs}ms ---`);
        if (e.stdout) lines.push(e.stdout.trimEnd());
        if (e.stderr) lines.push(`stderr: ${e.stderr.trimEnd()}`);
    }
    lines.push(
        `\nSummary: ${okCount} ok, ${failCount} failed, ${timedOutCount} timed out, ${errorCount} errored — ${durationMs}ms total${skipped}`,
    );
    return {
        content: [{ type: 'text', text: lines.join('\n') }],
        isError: failCount + timedOutCount + errorCount + offline.length > 0,
    };
}

/**
 * The shell command, as an action of the server's `device` type: on the
 * device of ids.device, or on several (body devices, product, group, all).
 * On several it answers its targets until confirmed.
 *
 * @type {import('@thinger-io/cli-core/mcp/tools-resource').LocalAction}
 */
export const execAction = {
    description:
        'Run a shell command on devices with the ThinRemote agent: on one (ids.device: its output and exit code), or on several in parallel (no ids; body `devices`, a `product` and optionally its `group`, or `all: true` for every device of the ThinRemote products: output, exit code and duration per device plus a summary). Offline devices are skipped unless `include_offline`. `dry_run` says which devices it would reach without running anything. For repeatable, checked changes use a playbook (type "product_playbook").',
    on: 'either',
    bodyRequired: true,
    confirm: true,
    body: {
        type: 'object',
        additionalProperties: false,
        required: ['command'],
        properties: {
            command: { type: 'string', description: 'Shell command to run.' },
            devices: {
                type: 'array',
                items: { type: 'string' },
                description: 'Several devices by id.',
            },
            product: { type: 'string', description: 'Every device of this product.' },
            group: { type: 'string', description: 'Asset group: alone, or narrowing `product`.' },
            all: {
                type: 'boolean',
                description: 'Every device of the ThinRemote products of the account.',
            },
            include_offline: {
                type: 'boolean',
                description: 'Also try devices that are not connected (default false).',
            },
            timeout: {
                type: 'number',
                description: 'Seconds per device before giving up (default 30).',
            },
            concurrency: {
                type: 'number',
                description: 'Devices at a time, on several (default 10).',
            },
            fail_fast: {
                type: 'boolean',
                description: 'On several: start no more devices after one fails.',
            },
            dry_run: { type: 'boolean', description: 'Only list the devices it would run on.' },
        },
    },
    examples: [
        {
            tool: 'resource_call',
            arguments: {
                type: 'device',
                action: 'exec',
                ids: { device: 'gw_1' },
                body: { command: 'uptime' },
            },
            does: 'Run uptime on one device.',
        },
        {
            tool: 'resource_call',
            arguments: {
                type: 'device',
                action: 'exec',
                body: { command: 'df -h /', product: 'gateways', dry_run: true },
            },
            does: 'The connected devices of the product gateways it would run on.',
        },
    ],
    run: (body, ctx) => toolExec({ ...body, device: ctx.id, user: ctx.user }, ctx),
};
