// @ts-check
import { getDevices } from '../../lib/devices.js';
import { isJsonMode, printOk, printErr, createSpinner, classifyError } from '../../lib/output.js';
import { success, hint, label } from '../../lib/format.js';
import { applyJsonFlag, ensureConfigured, getGlobalUser } from './_shared.js';

export function registerListCommand(device) {
    device
        .command('list [pattern]')
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
                    for (const d of devices) {
                        const online = d.connection?.active
                            ? success('online ')
                            : hint('offline');
                        const name = d.name ? hint(` (${d.name})`) : '';
                        console.log(`  ${online}  ${label(d.device)}${name}`);
                    }
                }
            } catch (error) {
                spinner.fail('Failed to list devices');
                const { message, code } = classifyError(error);
                printErr(message, { code });
            }
        });
}
