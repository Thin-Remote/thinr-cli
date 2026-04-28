// @ts-check
import { getDeviceStatus, formatDeviceStatus } from '../../lib/status.js';
import { getMonitoringData } from '../../lib/monitoring.js';
import { isJsonMode, printOk } from '../../lib/output.js';
import { applyJsonFlag, ensureConfigured, runDeviceCommand } from './_shared.js';

export function registerStatusCommand(device) {
    device
        .command('status <deviceId>')
        .helpGroup('Discovery:')
        .description('Check device status, data transfer and the latest monitoring sample')
        .option('-j, --json', 'Output as JSON')
        .action(async (deviceId, opts) => {
            applyJsonFlag(opts);
            ensureConfigured();
            await runDeviceCommand({
                start: `Checking status of ${deviceId}...`,
                // Fetch the server-side stats and the latest monitoring sample
                // in parallel — the monitoring call is best-effort, we still
                // render the stats section if the bucket query fails or the
                // device never published.
                fn: async () => {
                    const [statusResult, monitoringResult] = await Promise.allSettled([
                        getDeviceStatus(deviceId),
                        getMonitoringData({ device: deviceId, items: 1, sort: 'desc' }),
                    ]);
                    if (statusResult.status === 'rejected') throw statusResult.reason;
                    const monitoring =
                        monitoringResult.status === 'fulfilled' &&
                        Array.isArray(monitoringResult.value) &&
                        monitoringResult.value.length > 0
                            ? monitoringResult.value[0]
                            : null;
                    return { status: statusResult.value, monitoring };
                },
                // Skip the success banner: the detail block below speaks
                // for the "found" state and the failure path prints its
                // own clear error.
                success: null,
                failure: 'Status check failed',
                onSuccess: ({ status, monitoring }) => {
                    if (isJsonMode()) printOk({ ...status, monitoring });
                    else console.log(formatDeviceStatus(deviceId, status, monitoring));
                },
            });
        });
}
