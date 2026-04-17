// @ts-check
import { createDeviceAPI } from '../../lib/device-api.js';
import { isJsonMode, printOk, printErr, createSpinner, classifyError } from '../../lib/output.js';
import { success, hint, muted, label } from '../../lib/format.js';
import { applyJsonFlag, ensureConfigured, getGlobalUser } from './_shared.js';

/**
 * Plain filesystem operations on a single device, mirroring the
 * MCP filesystem tools with CLI-native verbs. Two semantic families:
 *   · read / write — inline content (strings, small files)
 *   · push / pull  — file transfer with progress (in transfer.js)
 * Plus ls, mkdir, rm, mv for directory housekeeping.
 */
export function registerFsCommands(device) {
    device
        .command('ls <deviceId> [path]')
        .helpGroup('Filesystem:')
        .description('List a directory on the device')
        .option('-j, --json', 'Output as JSON')
        .option('-a, --all', 'Include hidden entries (dotfiles)')
        .action(async (deviceId, path, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            const target = path || '/';
            const spinner = createSpinner(`Listing ${deviceId}:${target}...`).start();
            try {
                const api = createDeviceAPI(deviceId, { user });
                const entries = await api.listDir(target, !!opts.all);
                spinner.succeed(`${deviceId}:${target} (${entries.length} entries)`);
                if (isJsonMode()) {
                    printOk(entries);
                    return;
                }
                for (const e of entries) {
                    const kind = e.type === 'directory' ? label('d') : muted('-');
                    const mode = e.mode || 'rwxr-xr-x';
                    const size = (e.size || 0).toString().padStart(10);
                    console.log(`  ${kind}${mode}  ${hint(size)}  ${e.name}`);
                }
            } catch (err) {
                spinner.fail('List failed');
                const { message, code } = classifyError(err);
                printErr(message, { code });
            }
        });

    device
        .command('read <deviceId> <path>')
        .alias('cat')
        .helpGroup('Filesystem:')
        .description('Print the contents of a remote file to stdout')
        .option('-j, --json', 'Output as JSON')
        .action(async (deviceId, path, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            try {
                const api = createDeviceAPI(deviceId, { user });
                const buf = await api.readFile(path);
                const text = buf.toString('utf8');
                if (isJsonMode()) {
                    printOk({ device: deviceId, path, bytes: buf.byteLength, content: text });
                    return;
                }
                process.stdout.write(text);
                if (text && !text.endsWith('\n')) process.stdout.write('\n');
            } catch (err) {
                const { message, code } = classifyError(err);
                printErr(message, { code });
            }
        });

    device
        .command('write <deviceId> <path> [content]')
        .helpGroup('Filesystem:')
        .description(
            'Write inline content to a remote file (use `push` for large local files). Reads from stdin when <content> is omitted.',
        )
        .option('-j, --json', 'Output as JSON')
        .action(async (deviceId, path, content, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            const spinner = createSpinner(`Writing ${deviceId}:${path}...`).start();
            try {
                let payload;
                if (typeof content === 'string') {
                    payload = Buffer.from(content, 'utf8');
                } else if (!process.stdin.isTTY) {
                    payload = await readAllStdin();
                } else {
                    spinner.stop();
                    printErr(
                        'No content given. Pass it as the third argument or pipe it on stdin.',
                        { code: 'input_error' },
                    );
                    return;
                }
                const api = createDeviceAPI(deviceId, { user });
                await api.writeFile(path, payload);
                spinner.succeed(success(`Wrote ${payload.byteLength} bytes to ${deviceId}:${path}`));
                if (isJsonMode()) {
                    printOk({ device: deviceId, path, bytes: payload.byteLength });
                }
            } catch (err) {
                spinner.fail('write failed');
                const { message, code } = classifyError(err);
                printErr(message, { code });
            }
        });

    device
        .command('mkdir <deviceId> <path>')
        .helpGroup('Filesystem:')
        .description('Create a directory on the device')
        .option('-j, --json', 'Output as JSON')
        .action(async (deviceId, path, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            const spinner = createSpinner(`Creating ${deviceId}:${path}...`).start();
            try {
                const api = createDeviceAPI(deviceId, { user });
                await api.mkdir(path);
                spinner.succeed(success(`Created ${deviceId}:${path}`));
                if (isJsonMode()) printOk({ device: deviceId, path });
            } catch (err) {
                spinner.fail('mkdir failed');
                const { message, code } = classifyError(err);
                printErr(message, { code });
            }
        });

    device
        .command('rm <deviceId> <path>')
        .helpGroup('Filesystem:')
        .description(
            'Delete a file or directory on the device (pass --recursive for directories with contents)',
        )
        .option('-j, --json', 'Output as JSON')
        .option('-r, --recursive', 'Recursively delete non-empty directories (default: true)', true)
        .option('--no-recursive', 'Fail on non-empty directories')
        .action(async (deviceId, path, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            const spinner = createSpinner(`Deleting ${deviceId}:${path}...`).start();
            try {
                const api = createDeviceAPI(deviceId, { user });
                await api.delete(path, opts.recursive !== false);
                spinner.succeed(success(`Deleted ${deviceId}:${path}`));
                if (isJsonMode()) printOk({ device: deviceId, path });
            } catch (err) {
                spinner.fail('rm failed');
                const { message, code } = classifyError(err);
                printErr(message, { code });
            }
        });

    device
        .command('mv <deviceId> <source> <destination>')
        .helpGroup('Filesystem:')
        .description('Move or rename a file or directory on the device')
        .option('-j, --json', 'Output as JSON')
        .option('-f, --force', 'Overwrite destination if it already exists')
        .action(async (deviceId, source, destination, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            const spinner = createSpinner(
                `Moving ${deviceId}:${source} → ${destination}...`,
            ).start();
            try {
                const api = createDeviceAPI(deviceId, { user });
                await api.move(source, destination, !!opts.force);
                spinner.succeed(success(`Moved ${deviceId}:${source} → ${destination}`));
                if (isJsonMode()) printOk({ device: deviceId, source, destination });
            } catch (err) {
                spinner.fail('mv failed');
                const { message, code } = classifyError(err);
                printErr(message, { code });
            }
        });
}

async function readAllStdin() {
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}
