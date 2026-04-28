// @ts-check
import Table from 'cli-table3';
import { createDeviceAPI } from '../../lib/device-api.js';
import { TIMEOUTS } from '../../lib/constants.js';
import { runProductFanOut } from '../../lib/product-orchestrator.js';
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

            const fetchSpinner = createSpinner(
                `Retrieving devices for product ${productId}...`,
            ).start();
            /** @type {ProgressSpinner | null} */
            let progress = null;

            let result;
            try {
                result = await runProductFanOut({
                    product: productId,
                    group: opts.group,
                    includeOffline: !!opts.all,
                    user,
                    concurrency: opts.concurrency,
                    failFast: !!opts.failFast,
                    worker: async (device) => {
                        const api = createDeviceAPI(device.device, { user });
                        const perStart = Date.now();
                        let stdout = '';
                        let stderr = '';
                        try {
                            const { exitCode, timedOut } = await api.execStream(commandStr, {
                                timeout: opts.timeout,
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
                            const msg = err instanceof Error ? err.message : String(err);
                            return {
                                device: device.device,
                                ok: false,
                                exitCode: null,
                                timedOut: false,
                                durationMs: Date.now() - perStart,
                                stdout,
                                stderr,
                                error: msg,
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
                    onDevicesResolved: (devices) => {
                        fetchSpinner.succeed(
                            `Found ${devices.length} device(s) in product ${productId}`,
                        );
                        if (devices.length > 0 && !isJsonMode()) {
                            progress = new ProgressSpinner(
                                createSpinner('').start(),
                                devices.length,
                                ({ done, total, inFlight }) =>
                                    `Running \`${commandStr}\` on ${total} device(s) — ` +
                                    `${done}/${total} done · ${inFlight} in flight` +
                                    (opts.failFast ? ' · fail-fast' : ''),
                            );
                            progress.render();
                        }
                    },
                    onItemStart: () => progress?.startItem(),
                    onItemFinish: () => progress?.finishItem(),
                });
            } catch (error) {
                fetchSpinner.fail(`Failed to retrieve devices for product ${productId}`);
                const { message, code } = classifyError(error);
                printErr(message, { code });
                return;
            }
            progress?.stop();

            const { devices, entries, durationMs } = result;

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
                        durationMs,
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
                if (e.error) return e.error;
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
                        `${entries.length} total — ${okCount} ok, ${failCount} fail, ${timedOutCount} timeout, ${errorCount} error · ${durationMs}ms`,
                    ),
            );
        });
}
