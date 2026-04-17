// @ts-check
import Table from 'cli-table3';
import { filterActiveDevices } from '../../lib/devices.js';
import { createDeviceAPI } from '../../lib/device-api.js';
import { runPool } from '../../lib/concurrency.js';
import {
    label,
    muted,
    hint,
    success,
    error as errorStyle,
    warning,
} from '../../lib/format.js';
import {
    isJsonMode,
    printOk,
    printErr,
    createSpinner,
    classifyError,
} from '../../lib/output.js';
import {
    applyJsonFlag,
    ensureConfigured,
    getGlobalUser,
    parsePositiveInt,
    ProgressSpinner,
} from '../_shared.js';
import { fetchProductDevices } from './_shared.js';

/**
 * Factory for product-level fan-out filesystem subcommands.
 * Captures the repetitive boilerplate (fetch product devices,
 * optionally filter offline, spin up runPool, render the same
 * cli-table3 summary) so each verb only has to describe its
 * per-device operation.
 */
function registerProductFsCommand(product, { name, description, args, build, perDeviceLabel }) {
    const cmd = product
        .command(`${name} ${args}`)
        .helpGroup('Filesystem:')
        .description(description)
        .option('-j, --json', 'Output as JSON')
        .option('-g, --group <group>', 'Filter devices by asset group')
        .option(
            '-c, --concurrency <n>',
            'Max parallel operations (default: 10)',
            parsePositiveInt('concurrency'),
            10,
        )
        .option('--fail-fast', 'Stop dequeueing new devices on the first failure')
        .option('-a, --all', 'Include offline devices (by default, only active)');

    cmd.action(async (...commandArgs) => {
        const opts = commandArgs[commandArgs.length - 2];
        const commanderCmd = commandArgs[commandArgs.length - 1];
        const positionalArgs = commandArgs.slice(0, -2);
        const [productId, ...rest] = positionalArgs;

        applyJsonFlag(opts);
        ensureConfigured();
        const user = getGlobalUser(commanderCmd);

        const spinner = createSpinner(`Retrieving devices for product ${productId}...`).start();
        let devices;
        try {
            devices = await fetchProductDevices(productId, opts.group, user);
            spinner.succeed(`Found ${devices.length} device(s) in product ${productId}`);
        } catch (error) {
            spinner.fail(`Failed to retrieve devices for product ${productId}`);
            const { message, code } = classifyError(error);
            printErr(message, { code });
            return;
        }
        if (!opts.all) devices = filterActiveDevices(devices);

        if (devices.length === 0) {
            if (isJsonMode()) {
                printOk({ product: productId, summary: { total: 0, ok: 0, failed: 0 }, results: [] });
            } else {
                console.log(warning('No devices to target.'));
            }
            return;
        }

        const progress = new ProgressSpinner(
            createSpinner('').start(),
            devices.length,
            ({ done, total, inFlight }) =>
                `${perDeviceLabel(rest)} on ${total} device(s) — ` +
                `${done}/${total} done · ${inFlight} in flight` +
                (opts.failFast ? ' · fail-fast' : ''),
        );
        progress.render();

        const startTs = Date.now();
        const poolResults = await runPool(
            devices,
            opts.concurrency,
            async (device) => {
                progress.startItem();
                const api = createDeviceAPI(device.device, { user });
                const perStart = Date.now();
                try {
                    await build(api, rest, opts);
                    const durationMs = Date.now() - perStart;
                    progress.finishItem();
                    return { device: device.device, ok: true, durationMs };
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    const durationMs = Date.now() - perStart;
                    progress.finishItem();
                    return { device: device.device, ok: false, error: msg, durationMs };
                }
            },
            { failFast: !!opts.failFast },
        );
        progress.stop();

        const entries = poolResults.map((r, i) => {
            if (r && r.ok) return r.value;
            return { device: devices[i].device, ok: false, error: 'unknown error', durationMs: 0 };
        });
        const totalDurationMs = Date.now() - startTs;
        const okCount = entries.filter((e) => e.ok).length;
        const failCount = entries.length - okCount;

        if (isJsonMode()) {
            printOk({
                product: productId,
                summary: { total: entries.length, ok: okCount, failed: failCount, durationMs: totalDurationMs },
                results: entries,
            });
            return;
        }

        const table = new Table({
            head: ['Device', 'Status', 'Detail', 'Duration'].map((h) => label(h)),
            style: { head: [], border: ['gray'] },
            colAligns: ['left', 'left', 'left', 'right'],
        });
        for (const e of entries) {
            table.push([
                e.device,
                e.ok ? success('ok') : errorStyle('fail'),
                e.ok ? muted('—') : e.error || '',
                `${e.durationMs}ms`,
            ]);
        }
        console.log(table.toString());
        console.log(
            hint(`${entries.length} total · ${okCount} ok · ${failCount} failed · ${totalDurationMs}ms`),
        );
    });

    return cmd;
}

export function registerProductFsCommands(product) {
    registerProductFsCommand(product, {
        name: 'mkdir',
        description: 'Create a directory on every active device of the product',
        args: '<productId> <path>',
        perDeviceLabel: ([path]) => `mkdir ${path}`,
        build: async (api, [path]) => {
            await api.mkdir(path);
        },
    });

    registerProductFsCommand(product, {
        name: 'rm',
        description:
            'Delete a file or directory on every active device of the product (DESTRUCTIVE — double-check the path).',
        args: '<productId> <path>',
        perDeviceLabel: ([path]) => `rm ${path}`,
        build: async (api, [path], opts) => {
            await api.delete(path, opts.recursive !== false);
        },
    }).option(
        '-r, --recursive',
        'Recursively delete non-empty directories (default: true)',
        true,
    ).option('--no-recursive', 'Fail on non-empty directories');

    registerProductFsCommand(product, {
        name: 'mv',
        description: 'Move or rename a path on every active device of the product',
        args: '<productId> <source> <destination>',
        perDeviceLabel: ([src, dst]) => `mv ${src} → ${dst}`,
        build: async (api, [src, dst], opts) => {
            await api.move(src, dst, !!opts.force);
        },
    }).option('-f, --force', 'Overwrite destination if it already exists');
}
