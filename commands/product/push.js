// @ts-check
import { readFile as readLocalFile } from 'fs/promises';
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

export function registerProductPushCommand(product) {
    product
        .command('push <productId> <localPath> <remotePath>')
        .helpGroup('Filesystem:')
        .description('Upload a local file to every active device of a product, in parallel')
        .option('-j, --json', 'Output as JSON')
        .option('-g, --group <group>', 'Filter devices by asset group')
        .option(
            '-c, --concurrency <n>',
            'Max parallel uploads (default: 10)',
            parsePositiveInt('concurrency'),
            10,
        )
        .option('--fail-fast', 'Stop dequeueing new devices on the first failure')
        .option('-a, --all', 'Include offline devices (by default, only active)')
        .action(async (productId, localPath, remotePath, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);

            let content;
            try {
                content = await readLocalFile(localPath);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                printErr(`Cannot read local file: ${msg}`, { code: 'input_error' });
                return;
            }

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
                    printOk({
                        product: productId,
                        local: localPath,
                        remote: remotePath,
                        summary: { total: 0, ok: 0, failed: 0 },
                        results: [],
                    });
                } else {
                    console.log(warning('No devices to upload to.'));
                }
                return;
            }

            const progress = new ProgressSpinner(
                createSpinner('').start(),
                devices.length,
                ({ done, total, inFlight }) =>
                    `Uploading ${localPath} → ${remotePath} on ${total} device(s) — ` +
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
                    const perStart = Date.now();
                    const api = createDeviceAPI(device.device, { user });
                    try {
                        await api.writeFile(remotePath, content);
                        const durationMs = Date.now() - perStart;
                        progress.finishItem();
                        return {
                            device: device.device,
                            ok: true,
                            bytes: content.byteLength,
                            durationMs,
                        };
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        const durationMs = Date.now() - perStart;
                        progress.finishItem();
                        return {
                            device: device.device,
                            ok: false,
                            error: msg,
                            durationMs,
                        };
                    }
                },
                { failFast: !!opts.failFast },
            );

            progress.stop();

            const entries = poolResults.map((r, i) => {
                if (r && r.ok) return r.value;
                return {
                    device: devices[i].device,
                    ok: false,
                    error: 'unknown error',
                    durationMs: 0,
                };
            });
            const totalDurationMs = Date.now() - startTs;
            const okCount = entries.filter((e) => e.ok).length;
            const failCount = entries.length - okCount;

            if (isJsonMode()) {
                printOk({
                    product: productId,
                    local: localPath,
                    remote: remotePath,
                    summary: {
                        total: entries.length,
                        ok: okCount,
                        failed: failCount,
                        bytes: content.byteLength,
                        durationMs: totalDurationMs,
                    },
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
                    e.ok ? muted(`${e.bytes} bytes`) : e.error || '',
                    `${e.durationMs}ms`,
                ]);
            }
            console.log(table.toString());
            console.log(
                hint(
                    `${entries.length} total · ${okCount} ok · ${failCount} failed · ${content.byteLength} bytes · ${totalDurationMs}ms`,
                ),
            );
        });
}
