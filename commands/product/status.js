// @ts-check
import Table from 'cli-table3';
import { InvalidArgumentError } from 'commander';
import { runPool } from '../../lib/concurrency.js';
import { getMonitoringData } from '../../lib/monitoring.js';
import {
    formatUptime,
    colorPct,
    label,
    muted,
    hint,
    success,
    error as errorStyle,
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
} from '../_shared.js';
import { fetchProductDevices } from './_shared.js';

export function registerProductStatusCommand(product) {
    product
        .command('status <productId>')
        .helpGroup('Discovery:')
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
                        label(h),
                    ),
                    style: { head: [], border: ['gray'] },
                    colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right'],
                });
                for (const { device, mon } of rows) {
                    const online = !!device.connection?.active;
                    const status = online ? success('online') : muted('offline');
                    if (online && mon) {
                        table.push([
                            device.device,
                            status,
                            colorPct(mon.cpu?.usage),
                            colorPct(mon.memory?.usage),
                            colorPct(mon.disk?.root?.usage),
                            mon.load?.['1m'] != null
                                ? mon.load['1m'].toFixed(2)
                                : muted('—'),
                            formatUptime(mon.uptime),
                        ]);
                    } else {
                        const dim = muted('—');
                        table.push([device.device, status, dim, dim, dim, dim, dim]);
                    }
                }
                const header = watchSeconds
                    ? hint(
                          `${productId} · refreshed ${new Date().toLocaleTimeString()} · every ${watchSeconds}s · Ctrl+C to stop`,
                      )
                    : hint(`${productId} · ${new Date().toLocaleTimeString()}`);
                console.log(header);
                console.log(table.toString());
                const onlineCount = rows.filter((r) => r.device.connection?.active).length;
                console.log(
                    hint(`${rows.length} total · ${onlineCount} online · ${rows.length - onlineCount} offline`),
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
                    console.error(errorStyle(`[watch] ${code}: ${message}`));
                }
            }
        });
}
