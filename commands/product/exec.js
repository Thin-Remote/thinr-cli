// @ts-check
import Table from 'cli-table3';
import { filterActiveDevices } from '../../lib/devices.js';
import { createDeviceAPI } from '../../lib/device-api.js';
import { runPool } from '../../lib/concurrency.js';
import { TIMEOUTS } from '../../lib/constants.js';
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

export function registerProductExecCommand(product) {
    product
        .command('exec <productId> <command...>')
        .helpGroup('Fan-out:')
        .description(
            'Execute a shell command in parallel on every active device of the product',
        )
        .option('-j, --json', 'Output as JSON')
        .option('-g, --group <group>', 'Filter devices by asset group')
        .option(
            '-c, --concurrency <n>',
            'Max parallel executions (default: 10)',
            parsePositiveInt('concurrency'),
            10,
        )
        .option(
            '--timeout <seconds>',
            `Per-device timeout in seconds (default: ${TIMEOUTS.DEFAULT_EXEC_SECONDS})`,
            parsePositiveInt('timeout'),
            TIMEOUTS.DEFAULT_EXEC_SECONDS,
        )
        .option('--fail-fast', 'Stop dequeueing new devices as soon as one fails')
        .option('-a, --all', 'Include offline devices (by default, only active)')
        .action(async (productId, commandParts, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            const commandStr = commandParts.join(' ');

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
                        command: commandStr,
                        summary: { total: 0, ok: 0, failed: 0, durationMs: 0 },
                        results: [],
                    });
                } else {
                    console.log(warning('No devices to run on.'));
                }
                return;
            }

            // Live progress (human mode only): a single spinner that
            // updates with done/in-flight counters as workers finish.
            // Spinner is silenced in JSON mode by createSpinner itself.
            const progress = new ProgressSpinner(
                createSpinner('').start(),
                devices.length,
                ({ done, total, inFlight }) =>
                    `Running \`${commandStr}\` on ${total} device(s) — ` +
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
                    const perDeviceStart = Date.now();
                    let stdout = '';
                    let stderr = '';
                    const { exitCode, timedOut } = await api.execStream(commandStr, {
                        timeout: opts.timeout,
                        onStdout: (s) => {
                            stdout += s;
                        },
                        onStderr: (s) => {
                            stderr += s;
                        },
                    });
                    const durationMs = Date.now() - perDeviceStart;
                    const entry = {
                        device: device.device,
                        ok: !timedOut && exitCode === 0,
                        exitCode: exitCode ?? null,
                        timedOut: !!timedOut,
                        durationMs,
                        stdout,
                        stderr,
                    };
                    progress.finishItem();
                    return entry;
                },
                { failFast: !!opts.failFast },
            ).catch((err) => {
                // fail-fast re-throws the first error; the partial results
                // are still in `results` as it was populated before the throw.
                // We fall through below and normalize with what we have.
                return err;
            });

            // Stop the live spinner now that the pool has settled, regardless
            // of outcome. The final summary below replaces it.
            progress.stop();

            if (poolResults instanceof Error) {
                const { message, code } = classifyError(poolResults);
                if (isJsonMode()) {
                    printErr(message, { code });
                } else {
                    console.error(errorStyle(`fail-fast: ${message}`));
                }
                return;
            }

            const entries = poolResults.map((r, i) => {
                if (r?.ok) return r.value;
                const { message, code } = classifyError(r?.error);
                return {
                    device: devices[i].device,
                    ok: false,
                    exitCode: null,
                    timedOut: false,
                    durationMs: 0,
                    stdout: '',
                    stderr: '',
                    error: { message, code },
                };
            });

            const totalDurationMs = Date.now() - startTs;
            const okCount = entries.filter((e) => e.ok).length;
            const timedOutCount = entries.filter((e) => e.timedOut).length;
            const errorCount = entries.filter((e) => e.error).length;
            const failCount = entries.length - okCount - timedOutCount - errorCount;

            if (isJsonMode()) {
                printOk({
                    product: productId,
                    command: commandStr,
                    summary: {
                        total: entries.length,
                        ok: okCount,
                        failed: failCount + timedOutCount + errorCount,
                        timedOut: timedOutCount,
                        errored: errorCount,
                        durationMs: totalDurationMs,
                    },
                    results: entries,
                });
                return;
            }

            const statusBadge = (e) => {
                if (e.error) return errorStyle('error');
                if (e.timedOut) return warning('timeout');
                if (e.ok) return success('ok');
                return errorStyle('fail');
            };
            const detail = (e) => {
                if (e.error) return e.error.message;
                if (e.timedOut) return `after ${opts.timeout}s`;
                return `exit=${e.exitCode ?? 'null'}`;
            };
            const table = new Table({
                head: ['Device', 'Status', 'Detail', 'Duration'].map((h) => label(h)),
                style: { head: [], border: ['gray'] },
                colAligns: ['left', 'left', 'left', 'right'],
            });
            for (const e of entries) {
                table.push([
                    e.device,
                    statusBadge(e),
                    detail(e),
                    `${e.durationMs}ms`,
                ]);
            }
            console.log(table.toString());

            // Output section: only devices that produced stdout/stderr.
            // Single-line outputs render inline; multi-line ones indent
            // on their own block so grepping and copying still work.
            const withOutput = entries.filter(
                (e) => (e.stdout && e.stdout.trim()) || (e.stderr && e.stderr.trim()),
            );
            if (withOutput.length) {
                console.log(label('\nOutput:'));
                for (const e of withOutput) {
                    const body = [e.stdout, e.stderr]
                        .map((s) => (s ? s.replace(/\s+$/, '') : ''))
                        .filter(Boolean)
                        .join('\n');
                    const lines = body.split('\n');
                    if (lines.length === 1) {
                        console.log(`  ${muted(e.device + ':')}  ${lines[0]}`);
                    } else {
                        console.log(`  ${muted(e.device + ':')}`);
                        for (const line of lines) console.log(`    ${line}`);
                    }
                }
            }

            console.log(
                '\n' +
                    hint(
                        `${entries.length} total — ${okCount} ok, ${failCount} fail, ${timedOutCount} timeout, ${errorCount} error · ${totalDurationMs}ms`,
                    ),
            );
        });
}
