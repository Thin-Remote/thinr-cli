// @ts-check
import { getDeviceStatus, formatDeviceStatus } from '../../lib/status.js';
import { isJsonMode, printOk, printErr, createSpinner, classifyError } from '../../lib/output.js';
import { applyJsonFlag, ensureConfigured } from './_shared.js';

export function registerStatusCommand(device) {
    device
        .command('status <deviceId>')
        .description('Check device status and stats')
        .option('-j, --json', 'Output as JSON')
        .action(async (deviceId, opts) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const spinner = createSpinner(`Checking status of ${deviceId}...`).start();
            try {
                const status = await getDeviceStatus(deviceId);
                spinner.succeed(`Device ${deviceId} found`);
                if (isJsonMode()) printOk(status);
                else console.log(formatDeviceStatus(deviceId, status));
            } catch (error) {
                spinner.fail('Status check failed');
                const { message, code } = classifyError(error);
                printErr(message, { code });
            }
        });
}
