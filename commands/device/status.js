// @ts-check
import { getDeviceStatus, formatDeviceStatus } from '../../lib/status.js';
import { getMonitoringData } from '../../lib/monitoring.js';
import { isJsonMode, printOk, printErr, createSpinner, classifyError } from '../../lib/output.js';
import { applyJsonFlag, ensureConfigured } from './_shared.js';

export function registerStatusCommand(device) {
    device
        .command('status <deviceId>')
        .description('Check device status, data transfer and the latest monitoring sample')
        .option('-j, --json', 'Output as JSON')
        .action(async (deviceId, opts) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const spinner = createSpinner(`Checking status of ${deviceId}...`).start();
            try {
                // Fetch the server-side stats and the latest monitoring sample
                // in parallel — the monitoring call is best-effort, we still
                // render the stats section if the bucket query fails or the
                // device never published.
                const [statusResult, monitoringResult] = await Promise.allSettled([
                    getDeviceStatus(deviceId),
                    getMonitoringData({ device: deviceId, items: 1, sort: 'desc' }),
                ]);
                if (statusResult.status === 'rejected') throw statusResult.reason;
                const status = statusResult.value;
                const monitoring =
                    monitoringResult.status === 'fulfilled' &&
                    Array.isArray(monitoringResult.value) &&
                    monitoringResult.value.length > 0
                        ? monitoringResult.value[0]
                        : null;
                spinner.succeed(`Device ${deviceId} found`);
                if (isJsonMode()) printOk({ ...status, monitoring });
                else console.log(formatDeviceStatus(deviceId, status, monitoring));
            } catch (error) {
                spinner.fail('Status check failed');
                const { message, code } = classifyError(error);
                printErr(message, { code });
            }
        });
}
