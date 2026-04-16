// @ts-check
import chalk from 'chalk';
import { createDeviceAPI } from '../../lib/device-api.js';
import { isJsonMode, printOk, printErr, classifyError } from '../../lib/output.js';
import { applyJsonFlag, ensureConfigured, getGlobalUser } from './_shared.js';

export function registerExecCommand(device) {
    device
        .command('exec <deviceId> <command...>')
        .description('Execute a shell command on the device')
        .option('-j, --json', 'Buffer stdout/stderr and emit a single JSON envelope')
        .option('--legacy', 'Use the non-streaming one-shot API (older agents)')
        .action(async (deviceId, commandParts, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            const commandStr = commandParts.join(' ');
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
                    printOk({ stdout, stderr, exitCode: exitCode ?? null });
                    process.exit(exitCode ?? 1);
                }
                if (opts.legacy) {
                    const result = await api.exec(commandStr, 120);
                    if (result.stdout) process.stdout.write(result.stdout);
                    if (result.stderr) process.stderr.write(result.stderr);
                    process.exit(result.retcode || 0);
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
                    stdin: process.stdin,
                });
                process.off('SIGINT', onSigint);
                if (timedOut) {
                    console.error(chalk.red('\nError: command timed out on the device.'));
                }
                if (cancelled) {
                    console.error(chalk.yellow('\n[interrupted]'));
                    process.exit(130);
                }
                process.exit(exitCode ?? 1);
            } catch (error) {
                const { message, code } = classifyError(error);
                if (isJsonMode()) printErr(message, { code });
                // Human path: prefix `[code]` matches the MCP error format
                // and the rest of the CLI; the response dump only surfaces
                // when the failure carries an HTTP body.
                console.error(chalk.red(`Error [${code}]: ${message}`));
                if (error.response) {
                    console.error(chalk.red(`Status: ${error.response.status}`));
                    console.error(chalk.red(`Body: ${JSON.stringify(error.response.data)}`));
                }
                process.exit(1);
            }
        });
}
