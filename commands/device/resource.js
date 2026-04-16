// @ts-check
import {
    callDeviceResource,
    listDeviceResourcesWithSchemas,
    formatDeviceResourcesWithSchemas,
} from '../../lib/resource.js';
import { isJsonMode, printOk, printErr, createSpinner, classifyError } from '../../lib/output.js';
import { applyJsonFlag, collectInput, ensureConfigured } from './_shared.js';

export function registerResourceCommand(device) {
    device
        .command('resource <deviceId> [resource]')
        .description('List device resources, or call one by name')
        .option('-j, --json', 'Output as JSON')
        .option('-f, --field <field>', 'Extract a sub-field from the result (dot path)')
        .option('-i, --input <key=value>', 'Resource input (repeatable)', collectInput, {})
        .action(async (deviceId, resource, opts) => {
            applyJsonFlag(opts);
            ensureConfigured();
            if (!resource) {
                const spinner = createSpinner(`Getting resources for ${deviceId}...`).start();
                try {
                    const entries = await listDeviceResourcesWithSchemas(deviceId);
                    spinner.succeed(`Successfully retrieved resources for ${deviceId}`);
                    if (isJsonMode()) printOk(entries);
                    else console.log(formatDeviceResourcesWithSchemas(deviceId, entries));
                } catch (error) {
                    spinner.fail('Resource retrieval failed');
                    const { message, code } = classifyError(error);
                    printErr(message, { code });
                }
                return;
            }
            const spinner = createSpinner(
                `Calling resource ${resource} for ${deviceId}...`,
            ).start();
            try {
                const result = await callDeviceResource(deviceId, resource, opts.input);
                spinner.succeed(`Resource ${resource} returned successfully for ${deviceId}`);
                const value = opts.field
                    ? opts.field.split('.').reduce((obj, key) => obj && obj[key], result)
                    : result;
                if (isJsonMode()) printOk(value);
                else console.log(value);
            } catch (error) {
                spinner.fail('Resource call failed');
                const { message, code } = classifyError(error);
                printErr(message, { code });
            }
        });
}
