import chalk from 'chalk';
import Table from 'cli-table3';
import { InvalidArgumentError } from 'commander';
import { configExists } from '../lib/config.js';
import { formatDeviceProperty, getDeviceProperty } from '../lib/property.js';
import { callDeviceResource } from '../lib/resource.js';
import { filterActiveDevices, getDevices } from '../lib/devices.js';
import { createDeviceAPI } from '../lib/device-api.js';
import { runPool } from '../lib/concurrency.js';
import { getMonitoringData } from '../lib/monitoring.js';
import { formatUptime, colorPct } from '../lib/format.js';
import {
    setJsonMode,
    isJsonMode,
    printOk,
    printErr,
    createSpinner,
    classifyError,
} from '../lib/output.js';

function ensureConfigured() {
    if (!configExists()) {
        printErr('Not configured. Run thinr without parameters to set up.', {
            code: 'not_configured',
        });
    }
}

function applyJsonFlag(opts) {
    if (opts.json) setJsonMode(true);
}

function getGlobalUser(cmd) {
    let root = cmd;
    while (root.parent) root = root.parent;
    return root.opts().user || null;
}

function collectInput(value, previous = {}) {
    const idx = value.indexOf('=');
    if (idx === -1) throw new InvalidArgumentError('must be key=value');
    return { ...previous, [value.slice(0, idx)]: value.slice(idx + 1) };
}

function parsePositiveInt(label) {
    return (value) => {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
            throw new InvalidArgumentError(`${label} must be a positive integer`);
        }
        return n;
    };
}

async function fetchProductDevices(productId, group, user) {
    const filter = { productId };
    if (group) filter.asset_group = group;
    return getDevices(filter, user);
}

/**
 * `thinr product <subcommand> <productId> …` — fan-out commands across
 * every device that belongs to a product.
 */
export function productCommand(program) {
    const product = program
        .command('product')
        .description('Product commands (subcommand-first: thinr product <action> <productId>)');

    product
        .command('property <productId> <propertyId>')
        .description('Read a property on every device of the product')
        .option('-j, --json', 'Output as JSON')
        .option('-f, --field <field>', 'Extract a sub-field from each property (dot path)')
        .option('-a, --all', 'Include offline devices (default: only active)')
        .option('-g, --group <group>', 'Filter devices by asset group')
        .action(async (productId, propertyId, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            const spinner = createSpinner(`Retrieving devices for product ${productId}...`).start();
            let devices;
            try {
                devices = await fetchProductDevices(productId, opts.group, user);
                spinner.succeed(`Devices for product ${productId} retrieved successfully`);
            } catch (error) {
                spinner.fail(`Failed to retrieve devices for product ${productId}`);
                const { message, code } = classifyError(error);
                printErr(message, { code });
                return;
            }
            if (!opts.all) devices = filterActiveDevices(devices);

            const results = [];
            for (const device of devices) {
                try {
                    const property = await getDeviceProperty(device.device, propertyId);
                    const value = opts.field
                        ? opts.field.split('.').reduce((obj, key) => obj && obj[key], property)
                        : property;
                    results.push({ device: device.device, ok: true, data: value });
                    if (!isJsonMode()) {
                        console.log(
                            'Device',
                            chalk.blue(device.device),
                            'property',
                            chalk.blue(propertyId),
                        );
                        if (opts.field) console.log(value);
                        else console.log(formatDeviceProperty(device.device, propertyId, property));
                    }
                } catch (error) {
                    const { message, code } = classifyError(error);
                    results.push({ device: device.device, ok: false, error: { message, code } });
                    if (!isJsonMode()) {
                        console.error(
                            chalk.red(
                                `Error retrieving property ${propertyId} for device ${device.device}: ${message}`,
                            ),
                        );
                    }
                }
            }
            if (isJsonMode()) printOk({ product: productId, property: propertyId, results });
        });

    product
        .command('resource <productId> <resource>')
        .description('Call a resource on every active device of the product')
        .option('-j, --json', 'Output as JSON')
        .option('-f, --field <field>', 'Extract a sub-field from each result (dot path)')
        .option('-g, --group <group>', 'Filter devices by asset group')
        .option('-i, --input <key=value>', 'Resource input (repeatable)', collectInput, {})
        .action(async (productId, resource, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            const spinner = createSpinner(`Retrieving devices for product ${productId}...`).start();
            let devices;
            try {
                devices = await fetchProductDevices(productId, opts.group, user);
                spinner.succeed(`Devices for product ${productId} retrieved successfully`);
            } catch (error) {
                spinner.fail(`Failed to retrieve devices for product ${productId}`);
                const { message, code } = classifyError(error);
                printErr(message, { code });
                return;
            }
            devices = filterActiveDevices(devices);

            const results = [];
            for (const device of devices) {
                try {
                    const result = await callDeviceResource(device.device, resource, opts.input);
                    const value = opts.field
                        ? opts.field.split('.').reduce((obj, key) => obj && obj[key], result)
                        : result;
                    results.push({ device: device.device, ok: true, data: value });
                    if (!isJsonMode()) {
                        console.log(
                            'Device',
                            chalk.blue(device.device),
                            'resource',
                            chalk.blue(resource),
                        );
                        console.log(value);
                    }
                } catch (error) {
                    const { message, code } = classifyError(error);
                    results.push({ device: device.device, ok: false, error: { message, code } });
                    if (!isJsonMode()) {
                        console.error(
                            chalk.red(
                                `Error executing resource ${resource} for device ${device.device}: ${message}`,
                            ),
                        );
                    }
                }
            }
            if (isJsonMode()) printOk({ product: productId, resource, results });
        });

    product
        .command('exec <productId> <command...>')
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
            'Per-device timeout in seconds (default: 30)',
            parsePositiveInt('timeout'),
            30,
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
                    console.log(chalk.yellow('No devices to run on.'));
                }
                return;
            }

            // Live progress (human mode only): a single spinner that
            // updates with done/in-flight counters as workers finish.
            // Spinner is silenced in JSON mode by createSpinner itself.
            const runSpinner = createSpinner('').start();
            let doneCount = 0;
            let inFlight = 0;
            const updateSpinnerText = () => {
                runSpinner.text =
                    `Running \`${commandStr}\` on ${devices.length} device(s) — ` +
                    `${doneCount}/${devices.length} done · ${inFlight} in flight` +
                    (opts.failFast ? ' · fail-fast' : '');
            };
            updateSpinnerText();

            const startTs = Date.now();
            const poolResults = await runPool(
                devices,
                opts.concurrency,
                async (device) => {
                    inFlight++;
                    updateSpinnerText();
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
                    inFlight--;
                    doneCount++;
                    updateSpinnerText();
                    return entry;
                },
                { failFast: !!opts.failFast },
            ).catch((err) => {
                // fail-fast re-throws the first error; the partial results
                // are still in `results` as it was populated before the throw.
                // We fall through below and normalize with what we have.
                return err;
            });

            // poolResults is either the array (success path) or the rethrown
            // error from fail-fast. When it's an error, the pool still filled
            // `results[i]` for what finished; but we lost that handle. Easy
            // workaround: when fail-fast throws, re-run with failFast=false on
            // nothing — or simpler, just catch inside runPool and not throw.
            // For now, if it's an Error instance, surface it as a top-level
            // failure and abort.
            // Stop the live spinner now that the pool has settled, regardless
            // of outcome. The final summary below replaces it.
            runSpinner.stop();

            if (poolResults instanceof Error) {
                const { message, code } = classifyError(poolResults);
                if (isJsonMode()) {
                    printErr(message, { code });
                } else {
                    console.error(chalk.red(`fail-fast: ${message}`));
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
                if (e.error) return chalk.red('error');
                if (e.timedOut) return chalk.yellow('timeout');
                if (e.ok) return chalk.green('ok');
                return chalk.red('fail');
            };
            const detail = (e) => {
                if (e.error) return e.error.message;
                if (e.timedOut) return `after ${opts.timeout}s`;
                return `exit=${e.exitCode ?? 'null'}`;
            };
            const table = new Table({
                head: ['Device', 'Status', 'Detail', 'Duration'].map((h) => chalk.bold(h)),
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
                console.log(chalk.bold('\nOutput:'));
                for (const e of withOutput) {
                    const body = [e.stdout, e.stderr]
                        .map((s) => (s ? s.replace(/\s+$/, '') : ''))
                        .filter(Boolean)
                        .join('\n');
                    const lines = body.split('\n');
                    if (lines.length === 1) {
                        console.log(`  ${chalk.dim(e.device + ':')}  ${lines[0]}`);
                    } else {
                        console.log(`  ${chalk.dim(e.device + ':')}`);
                        for (const line of lines) console.log(`    ${line}`);
                    }
                }
            }

            console.log(
                '\n' +
                    chalk.gray(
                        `${entries.length} total — ${okCount} ok, ${failCount} fail, ${timedOutCount} timeout, ${errorCount} error · ${totalDurationMs}ms`,
                    ),
            );
        });

    product
        .command('status <productId>')
        .description('Snapshot of every device in the product (status + monitoring)')
        .option('-j, --json', 'Output as JSON')
        .option('-g, --group <group>', 'Filter devices by asset group')
        .option(
            '-c, --concurrency <n>',
            'Max parallel monitoring queries (default: 10)',
            parsePositiveInt('concurrency'),
            10,
        )
        .option(
            '-w, --watch [seconds]',
            'Refresh continuously every N seconds (default: 5)',
        )
        .action(async (productId, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);

            // Parse the optional value of --watch. Commander delivers `true`
            // when the flag is present without a value, the string value
            // when one is given, and `undefined` when absent.
            let watchSeconds = 0;
            if (opts.watch !== undefined) {
                if (opts.watch === true) watchSeconds = 5;
                else {
                    const n = Number(opts.watch);
                    if (!Number.isInteger(n) || n <= 0) {
                        throw new InvalidArgumentError(
                            'watch interval must be a positive integer (seconds)',
                        );
                    }
                    watchSeconds = n;
                }
            }

            // Snapshot a single pass: fetch devices, pull latest monitoring
            // for each, and return parallel arrays the renderer can consume.
            const collect = async () => {
                const devices = await fetchProductDevices(productId, opts.group, user);
                const monResults = await runPool(devices, opts.concurrency, async (device) => {
                    if (!device.connection?.active) return null;
                    try {
                        const data = await getMonitoringData({
                            device: device.device,
                            user,
                            items: 1,
                            sort: 'desc',
                        });
                        return Array.isArray(data) && data.length > 0 ? data[0] : null;
                    } catch {
                        return null;
                    }
                });
                return devices.map((device, i) => {
                    const mon = monResults[i] && monResults[i].ok ? monResults[i].value : null;
                    return { device, mon };
                });
            };

            const render = (rows) => {
                if (isJsonMode()) {
                    printOk({
                        product: productId,
                        ts: Date.now(),
                        devices: rows.map(({ device, mon }) => ({
                            device: device.device,
                            name: device.name || null,
                            online: !!device.connection?.active,
                            ip: device.connection?.ip_address || null,
                            monitoring: mon,
                        })),
                    });
                    return;
                }
                const table = new Table({
                    head: ['Device', 'Status', 'CPU', 'Mem', 'Disk', 'Load', 'Uptime'].map((h) =>
                        chalk.bold(h),
                    ),
                    style: { head: [], border: ['gray'] },
                    colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right'],
                });
                for (const { device, mon } of rows) {
                    const online = !!device.connection?.active;
                    const status = online ? chalk.green('online') : chalk.dim('offline');
                    if (online && mon) {
                        table.push([
                            device.device,
                            status,
                            colorPct(mon.cpu?.usage),
                            colorPct(mon.memory?.usage),
                            colorPct(mon.disk?.root?.usage),
                            mon.load?.['1m'] != null
                                ? mon.load['1m'].toFixed(2)
                                : chalk.dim('—'),
                            formatUptime(mon.uptime),
                        ]);
                    } else {
                        const dim = chalk.dim('—');
                        table.push([device.device, status, dim, dim, dim, dim, dim]);
                    }
                }
                const header = watchSeconds
                    ? chalk.gray(
                          `${productId} · refreshed ${new Date().toLocaleTimeString()} · every ${watchSeconds}s · Ctrl+C to stop`,
                      )
                    : chalk.gray(`${productId} · ${new Date().toLocaleTimeString()}`);
                console.log(header);
                console.log(table.toString());
                const onlineCount = rows.filter((r) => r.device.connection?.active).length;
                console.log(
                    chalk.gray(`${rows.length} total · ${onlineCount} online · ${rows.length - onlineCount} offline`),
                );
            };

            // In watch mode + TTY, switch to the terminal's alternate
            // screen buffer (`\x1b[?1049h`) so updates redraw in place
            // without piling up in the scrollback. On exit we restore
            // the main buffer (`\x1b[?1049l`) and the user's prompt
            // reappears with their previous history intact — same
            // pattern `htop`, `vim` and `less` use.
            const isTty = !!process.stdout.isTTY;
            const useAltScreen = !!watchSeconds && isTty && !isJsonMode();
            const enterAltScreen = () => process.stdout.write('\x1b[?1049h\x1b[H');
            const exitAltScreen = () => process.stdout.write('\x1b[?1049l');
            const clearScreen = () => process.stdout.write('\x1b[H\x1b[2J');

            // First pass — always. The spinner runs in the main buffer so
            // the user sees progress while we fetch devices + monitoring
            // in parallel; once data is ready, we (optionally) switch to
            // the alternate screen and draw the table from there.
            let rows;
            const spinner = createSpinner(
                `Fetching status for devices in product ${productId}...`,
            ).start();
            try {
                rows = await collect();
                spinner.stop();
            } catch (error) {
                spinner.fail(`Failed to fetch status for product ${productId}`);
                const { message, code } = classifyError(error);
                printErr(message, { code });
                return;
            }

            if (useAltScreen) {
                enterAltScreen();
                // Restore the main screen on any path out, including
                // uncaught errors. `once` avoids double-emitting the
                // escape sequence if the process exits multiple times.
                process.once('exit', exitAltScreen);
            }

            render(rows);

            if (!watchSeconds) return;

            // Watch loop. Redraw on each tick; clear in-buffer when
            // we're on the alternate screen, and just append when
            // stdout isn't a TTY (piped) — useful for logging.
            let stopped = false;
            process.on('SIGINT', () => {
                stopped = true;
                if (useAltScreen) exitAltScreen();
                console.log('Watch stopped.');
                process.exit(0);
            });
            while (!stopped) {
                await new Promise((r) => setTimeout(r, watchSeconds * 1000));
                if (stopped) break;
                try {
                    const rows = await collect();
                    if (useAltScreen) clearScreen();
                    render(rows);
                } catch (error) {
                    const { message, code } = classifyError(error);
                    console.error(chalk.red(`[watch] ${code}: ${message}`));
                }
            }
        });
}
