// @ts-check
import { confirm } from '@inquirer/prompts';
import { deleteDevice } from '../../lib/devices.js';
import { isJsonMode, printOk, printErr, classifyError } from '../../lib/output.js';
import { hint, info } from '../../lib/format.js';
import { applyJsonFlag, ensureConfigured, getGlobalUser } from './_shared.js';

export function registerDeleteCommand(device) {
    device
        .command('delete <deviceId>')
        .helpGroup('State & resources:')
        .description('Delete a device record from the platform (irreversible)')
        .option('-y, --yes', 'Skip the interactive confirmation prompt')
        .option('-j, --json', 'Output as JSON')
        .action(async (deviceId, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);

            if (!opts.yes && !isJsonMode()) {
                if (!process.stdin.isTTY) {
                    printErr('Refusing to delete without --yes in a non-interactive shell', {
                        code: 'needs_confirm',
                    });
                    return;
                }
                const ok = await confirm({
                    message: `Delete device ${deviceId}? This cannot be undone.`,
                    default: false,
                });
                if (!ok) {
                    console.log(hint('Cancelled.'));
                    return;
                }
            }

            try {
                const removed = await deleteDevice(deviceId, user);
                if (isJsonMode()) {
                    printOk({ device: deviceId, removed });
                    return;
                }
                console.log(
                    removed
                        ? `Deleted ${info(deviceId)}`
                        : `Device ${info(deviceId)} did not exist`,
                );
            } catch (error) {
                const { message, code } = classifyError(error);
                printErr(message, { code });
            }
        });
}
