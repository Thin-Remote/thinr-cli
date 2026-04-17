// @ts-check
import { readFile as readLocalFile, writeFile as writeLocalFile } from 'fs/promises';
import { basename } from 'path';
import { createDeviceAPI } from '../../lib/device-api.js';
import { isJsonMode, printOk, printErr, createSpinner, classifyError } from '../../lib/output.js';
import { success, hint } from '../../lib/format.js';
import { applyJsonFlag, ensureConfigured, getGlobalUser } from './_shared.js';

/**
 * Split `push` and `pull` into two plain commands instead of the
 * scp-style single `cp` with `<deviceId>:` prefixes. Intent is obvious
 * from the verb and the argument order is always the same: device id,
 * then source, then destination — no ambiguity about "which side is
 * local".
 */
export function registerTransferCommands(device) {
    device
        .command('push <deviceId> <localPath> <remotePath>')
        .description('Upload a local file to the device (use trailing "/" on remote to keep the source basename)')
        .option('-j, --json', 'Output as JSON')
        .action(async (deviceId, localPath, remotePath, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);

            const finalRemote = remotePath.endsWith('/')
                ? remotePath + basename(localPath)
                : remotePath;

            const spinner = createSpinner(
                `Uploading ${localPath} → ${deviceId}:${finalRemote}...`,
            ).start();
            try {
                const content = await readLocalFile(localPath);
                const api = createDeviceAPI(deviceId, { user });
                await api.writeFile(finalRemote, content);
                spinner.succeed(
                    success(`Uploaded ${localPath} → ${deviceId}:${finalRemote}`) +
                        ' ' +
                        hint(`(${content.byteLength} bytes)`),
                );
                if (isJsonMode()) {
                    printOk({
                        direction: 'push',
                        device: deviceId,
                        local: localPath,
                        remote: finalRemote,
                        bytes: content.byteLength,
                    });
                }
            } catch (err) {
                spinner.fail('Upload failed');
                const { message, code } = classifyError(err);
                printErr(message, { code });
            }
        });

    device
        .command('pull <deviceId> <remotePath> <localPath>')
        .description('Download a remote file from the device to local disk')
        .option('-j, --json', 'Output as JSON')
        .action(async (deviceId, remotePath, localPath, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);

            const finalLocal = localPath.endsWith('/')
                ? localPath + basename(remotePath)
                : localPath;

            const spinner = createSpinner(
                `Downloading ${deviceId}:${remotePath} → ${finalLocal}...`,
            ).start();
            try {
                const api = createDeviceAPI(deviceId, { user });
                const buf = await api.readFile(remotePath);
                await writeLocalFile(finalLocal, buf);
                spinner.succeed(
                    success(`Downloaded ${deviceId}:${remotePath} → ${finalLocal}`) +
                        ' ' +
                        hint(`(${buf.byteLength} bytes)`),
                );
                if (isJsonMode()) {
                    printOk({
                        direction: 'pull',
                        device: deviceId,
                        remote: remotePath,
                        local: finalLocal,
                        bytes: buf.byteLength,
                    });
                }
            } catch (err) {
                spinner.fail('Download failed');
                const { message, code } = classifyError(err);
                printErr(message, { code });
            }
        });
}
