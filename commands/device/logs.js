// @ts-check
import { createDeviceAPI } from '../../lib/device-api.js';
import { isJsonMode, printOk, printErr, classifyError } from '../../lib/output.js';
import { error as errorStyle, warning } from '../../lib/format.js';
import { applyJsonFlag, ensureConfigured, getGlobalUser } from './_shared.js';

// Single-quote for /bin/sh: wrap in '…' and escape embedded single quotes.
function shq(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildCommand({ follow, tail, unit, since, path }) {
    const n = Number.isFinite(tail) && tail >= 0 ? tail : 100;
    if (path) {
        const follower = follow ? '-F' : '';
        return `tail -n ${n} ${follower} -- ${shq(path)}`.trim();
    }
    const parts = ['journalctl', '--no-pager', '--output=short', `-n ${n}`];
    if (follow) parts.push('-f');
    if (unit) parts.push(`-u ${shq(unit)}`);
    if (since) parts.push(`--since ${shq(since)}`);
    return parts.join(' ');
}

export function registerLogsCommand(device) {
    device
        .command('logs <deviceId>')
        .helpGroup('Observability:')
        .description('Stream or tail device logs (journalctl by default, or a file path)')
        .option('-f, --follow', 'Keep streaming until interrupted (Ctrl+C)')
        .option('-n, --tail <n>', 'Number of initial lines to show', (v) => parseInt(v, 10), 100)
        .option('--unit <name>', 'Filter by systemd unit (journalctl only)')
        .option('--since <when>', 'Show entries since a time expression (journalctl only)')
        .option('--path <file>', 'Follow a file instead of journalctl')
        .option('-j, --json', 'Buffer output and emit a single JSON envelope (not allowed with --follow)')
        .action(async (deviceId, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();

            if (opts.follow && opts.json) {
                printErr('--json and --follow cannot be combined', { code: 'invalid_args', exitCode: 2 });
            }
            if (opts.path && (opts.unit || opts.since)) {
                printErr('--unit and --since only apply to journalctl mode', { code: 'invalid_args', exitCode: 2 });
            }

            const user = getGlobalUser(cmd);
            const commandStr = buildCommand({
                follow: !!opts.follow,
                tail: opts.tail,
                unit: opts.unit,
                since: opts.since,
                path: opts.path,
            });

            try {
                const api = createDeviceAPI(deviceId, { user });
                if (isJsonMode()) {
                    let stdout = '';
                    let stderr = '';
                    const { exitCode, timedOut, cancelled } = await api.execStream(commandStr, {
                        onStdout: (s) => {
                            stdout += s;
                        },
                        onStderr: (s) => {
                            stderr += s;
                        },
                    });
                    if (cancelled) printErr('Interrupted', { code: 'cancelled', exitCode: 130 });
                    if (timedOut) printErr('Command timed out on the device', { code: 'timeout' });
                    printOk({ command: commandStr, stdout, stderr, exitCode: exitCode ?? null });
                    process.exit(exitCode ?? 1);
                }
                let cancelFn = null;
                const onSigint = () => cancelFn?.();
                process.on('SIGINT', onSigint);
                const { exitCode, timedOut, cancelled } = await api.execStream(commandStr, {
                    onStdout: (s) => process.stdout.write(s),
                    onStderr: (s) => process.stderr.write(s),
                    onCancel: (fn) => {
                        cancelFn = fn;
                    },
                });
                process.off('SIGINT', onSigint);
                if (timedOut) {
                    console.error(errorStyle('\nError: log stream timed out on the device.'));
                }
                if (cancelled) {
                    // Follow mode always ends via Ctrl+C — suppress the
                    // noisy [interrupted] banner in that case.
                    if (!opts.follow) console.error(warning('\n[interrupted]'));
                    process.exit(130);
                }
                process.exit(exitCode ?? 0);
            } catch (error) {
                const { message, code } = classifyError(error);
                if (isJsonMode()) printErr(message, { code });
                console.error(errorStyle(`Error [${code}]: ${message}`));
                if (error.response) {
                    console.error(errorStyle(`Status: ${error.response.status}`));
                    console.error(errorStyle(`Body: ${JSON.stringify(error.response.data)}`));
                }
                process.exit(1);
            }
        });
}
