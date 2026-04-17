// @ts-check
import { readFile as readLocalFile, writeFile as writeLocalFile } from 'fs/promises';
import { basename } from 'path';
import { createDeviceAPI } from '../../lib/device-api.js';
import { isJsonMode, printOk, printErr, createSpinner, classifyError } from '../../lib/output.js';
import { success, hint } from '../../lib/format.js';
import { applyJsonFlag, ensureConfigured, getGlobalUser } from './_shared.js';

/**
 * Parse a `cp` positional argument. Device-side paths carry a
 * `<deviceId>:<path>` prefix (same convention `scp` and `kubectl cp`
 * use). Anything without a `:` is treated as a local path.
 *
 * Returns `{ kind: 'local' | 'remote', deviceId?: string, path: string }`.
 */
function parseCpArg(arg) {
    // Absolute local paths on unix and windows drive letters shouldn't
    // be mistaken for a device prefix.
    if (arg.startsWith('/') || arg.startsWith('./') || arg.startsWith('../')) {
        return { kind: 'local', path: arg };
    }
    const idx = arg.indexOf(':');
    if (idx <= 0) return { kind: 'local', path: arg };
    return {
        kind: 'remote',
        deviceId: arg.slice(0, idx),
        path: arg.slice(idx + 1) || '/',
    };
}

export function registerCpCommand(device) {
    device
        .command('cp <source> <destination>')
        .description(
            'Copy a file between local disk and a device. Prefix the device side with "<deviceId>:".',
        )
        .option('-j, --json', 'Output as JSON')
        .action(async (source, destination, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);

            const src = parseCpArg(source);
            const dst = parseCpArg(destination);

            if (src.kind === 'remote' && dst.kind === 'remote') {
                printErr('Copying between two devices is not supported yet.', {
                    code: 'input_error',
                });
                return;
            }
            if (src.kind === 'local' && dst.kind === 'local') {
                printErr(
                    'At least one side must be a device path prefixed with "<deviceId>:".',
                    { code: 'input_error' },
                );
                return;
            }

            // If destination path ends in "/" or equals a bare "/",
            // auto-append the source basename — matches `scp` / `cp`.
            const resolvedDst = dst.path.endsWith('/')
                ? { ...dst, path: dst.path + basename(src.path) }
                : dst;

            const direction = src.kind === 'local' ? 'upload' : 'download';
            const deviceId = direction === 'upload' ? resolvedDst.deviceId : src.deviceId;
            const spinner = createSpinner(
                direction === 'upload'
                    ? `Uploading ${src.path} → ${deviceId}:${resolvedDst.path}...`
                    : `Downloading ${deviceId}:${src.path} → ${resolvedDst.path}...`,
            ).start();

            try {
                const api = createDeviceAPI(deviceId, { user });
                if (direction === 'upload') {
                    const content = await readLocalFile(src.path);
                    await api.writeFile(resolvedDst.path, content);
                    spinner.succeed(
                        success(`Uploaded ${src.path} → ${deviceId}:${resolvedDst.path}`) +
                            ' ' +
                            hint(`(${content.byteLength} bytes)`),
                    );
                    if (isJsonMode())
                        printOk({
                            direction,
                            device: deviceId,
                            local: src.path,
                            remote: resolvedDst.path,
                            bytes: content.byteLength,
                        });
                } else {
                    const buf = await api.readFile(src.path);
                    await writeLocalFile(resolvedDst.path, buf);
                    spinner.succeed(
                        success(
                            `Downloaded ${deviceId}:${src.path} → ${resolvedDst.path}`,
                        ) +
                            ' ' +
                            hint(`(${buf.byteLength} bytes)`),
                    );
                    if (isJsonMode())
                        printOk({
                            direction,
                            device: deviceId,
                            remote: src.path,
                            local: resolvedDst.path,
                            bytes: buf.byteLength,
                        });
                }
            } catch (err) {
                spinner.fail(`${direction === 'upload' ? 'Upload' : 'Download'} failed`);
                const { message, code } = classifyError(err);
                printErr(message, { code });
            }
        });
}
