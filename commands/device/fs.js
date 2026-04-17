// @ts-check
import { createDeviceAPI } from '../../lib/device-api.js';
import { isJsonMode, printOk, printErr, createSpinner, classifyError } from '../../lib/output.js';
import { success, hint, muted, label } from '../../lib/format.js';
import { applyJsonFlag, ensureConfigured, getGlobalUser } from './_shared.js';

/**
 * Plain filesystem operations on a single device, mirroring the
 * six MCP filesystem tools (ls, read/write, mkdir, delete, move)
 * with CLI-native verbs. `push`/`pull` handle file transfer and
 * live in transfer.js; this file keeps the rest of the toolbox
 * together.
 */
export function registerFsCommands(device) {
    device
        .command('ls <deviceId> [path]')
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
        .command('cat <deviceId> <path>')
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
        .command('mkdir <deviceId> <path>')
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
