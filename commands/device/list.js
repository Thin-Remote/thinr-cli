// @ts-check
import { getDevices } from '../../lib/devices.js';
import { isJsonMode, printOk, printErr, createSpinner, classifyError } from '../../lib/output.js';
import { success, hint, label } from '../../lib/format.js';
import { applyJsonFlag, ensureConfigured, getGlobalUser } from './_shared.js';

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
            const spinnerLabel = pattern
                ? `Searching devices matching "${pattern}"...`
                : 'Fetching devices...';
            const spinner = createSpinner(spinnerLabel).start();
            try {
                const devices = await getDevices(filter, user);
                spinner.succeed(`Found ${devices.length} device(s)`);
                if (isJsonMode()) {
                    printOk(devices);
                } else {
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
                }
            } catch (error) {
                spinner.fail('Failed to list devices');
                const { message, code } = classifyError(error);
                printErr(message, { code });
            }
        });
}
