// @ts-check
import { filterActiveDevices, getDevices } from '@thinger-io/cli-core/devices';
import { getProducts } from '@thinger-io/cli-core/product';
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
 * The devices a fleet call reaches: a list, a product (optionally one of
 * its groups), a group, or every device of the ThinRemote products.
 * Offline ones are left out unless asked for.
 */
async function targetsOf(args) {
    let devices;
    if (Array.isArray(args.devices) && args.devices.length) {
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
        const products = (await getProducts(args.user)).filter(
            (p) => p?.config?.type === THINREMOTE_PRODUCT_TYPE,
        );
        const ids = new Set(products.map((p) => p.product));
        devices = (await getDevices({}, args.user)).filter((d) => ids.has(d.product));
    }
    return args.include_offline ? devices : filterActiveDevices(devices);
}

async function toolExec(args) {
    if (typeof args.command !== 'string' || !args.command.trim()) {
        throw inputError('command is required');
    }
    const fleet =
        (Array.isArray(args.devices) && args.devices.length) || args.product || args.group;
    if (args.device && (fleet || args.all)) {
        throw inputError('give `device` for one device, or devices / product / group / all');
    }
    if (!args.device && !fleet && !args.all) {
        throw inputError(
            'give the target: `device` for one device; `devices`, `product` or `group` for several; `all: true` for every device of the ThinRemote products',
        );
    }
    // Default guards against hung commands locking the session; callers
    // override for known-long operations. Knob lives in lib/constants.js.
    const timeout = positive(args.timeout, TIMEOUTS.DEFAULT_EXEC_SECONDS);
    if (args.device && !args.dry_run) return execOne(args.device, args, timeout);

    const devices = args.device ? [{ device: args.device }] : await targetsOf(args);
    if (args.dry_run) {
        const ids = devices.map((d) => d.device);
        return {
            content: [
                {
                    type: 'text',
                    text: `Would run \`${args.command}\` on ${ids.length} device(s)${ids.length ? `: ${ids.join(', ')}` : ''}.`,
                },
            ],
            isError: false,
        };
    }
    if (devices.length === 0) {
        return {
            content: [{ type: 'text', text: 'No connected devices match the target.' }],
            isError: false,
        };
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
        `\nSummary: ${okCount} ok, ${failCount} failed, ${timedOutCount} timed out, ${errorCount} errored — ${durationMs}ms total`,
    );
    return {
        content: [{ type: 'text', text: lines.join('\n') }],
        isError: failCount + timedOutCount + errorCount > 0,
    };
}

export const tools = [
    {
        name: 'device_exec',
        description:
            'Run a shell command on devices with the ThinRemote agent: on one (`device`: its output and exit code), or on several in parallel (`devices`, a `product` and optionally its `group`, or `all: true` for every device of the ThinRemote products: output, exit code and duration per device plus a summary). Offline devices are skipped unless `include_offline`. `dry_run` says which devices it would reach without running anything. On several devices it acts at once: confirm with the user first; for repeatable, checked changes use a playbook (type "product_playbook").',
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command to run.' },
                device: {
                    type: 'string',
                    description: 'One device (from {tool:resource_list} type "device").',
                },
                devices: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Several devices by id.',
                },
                product: { type: 'string', description: 'Every device of this product.' },
                group: {
                    type: 'string',
                    description: 'Asset group: alone, or narrowing `product`.',
                },
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
                dry_run: {
                    type: 'boolean',
                    description: 'Only list the devices it would run on.',
                },
                user: { type: 'string', description: 'Account to act on (admin only).' },
            },
            required: ['command'],
        },
        handler: toolExec,
    },
];
