// @ts-check
import { getDevices } from '../../lib/devices.js';
import { isJsonMode, printOk } from '../../lib/output.js';
import { success, hint, label } from '../../lib/format.js';
import {
    applyJsonFlag,
    ensureConfigured,
    getGlobalUser,
    runDeviceCommand,
} from './_shared.js';

export function registerListCommand(device) {
    device
        .command('list [pattern]')
        .helpGroup('Discovery:')
        .description(
            'List devices, optionally filtered by name/id pattern (case-insensitive regex)',
        )
        .option('-j, --json', 'Output as JSON')
        .action(async (pattern, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            const filter = pattern ? { name: pattern } : {};
            await runDeviceCommand({
                start: pattern
                    ? `Searching devices matching "${pattern}"...`
                    : 'Fetching devices...',
                fn: () => getDevices(filter, user),
                success: (devices) => `Found ${devices.length} device(s)`,
                failure: 'Failed to list devices',
                onSuccess: (devices) => {
                    if (isJsonMode()) {
                        printOk(devices);
                        return;
                    }
                    // Pad the device id column so trailing names line up
                    // even when ids have very different widths — same
                    // treatment as thinr product list.
                    const idWidth = devices.reduce(
                        (w, d) => Math.max(w, d.device.length),
                        0,
                    );
                    for (const d of devices) {
                        const online = d.connection?.active
                            ? success('online ')
                            : hint('offline');
                        const name = d.name ? hint(`(${d.name})`) : '';
                        const id = label(d.device.padEnd(idWidth));
                        console.log(`  ${online}  ${id}${name ? '  ' + name : ''}`);
                    }
                },
            });
        });
}
