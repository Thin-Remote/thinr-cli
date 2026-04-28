// @ts-check
import {
    callDeviceResource,
    listDeviceResourcesWithSchemas,
    formatDeviceResourcesWithSchemas,
} from '../../lib/resource.js';
import { isJsonMode, printOk } from '../../lib/output.js';
import {
    applyJsonFlag,
    collectInput,
    ensureConfigured,
    extractField,
    runDeviceCommand,
} from './_shared.js';

export function registerResourceCommand(device) {
    device
        .command('resource <deviceId> [resource]')
        .helpGroup('State & resources:')
        .description('List device resources, or call one by name')
        .option('-j, --json', 'Output as JSON')
        .option('-f, --field <field>', 'Extract a sub-field from the result (dot path)')
        .option('-i, --input <key=value>', 'Resource input (repeatable)', collectInput, {})
        .action(async (deviceId, resource, opts) => {
            applyJsonFlag(opts);
            ensureConfigured();
            if (!resource) {
                await runDeviceCommand({
                    start: `Getting resources for ${deviceId}...`,
                    fn: () => listDeviceResourcesWithSchemas(deviceId),
                    success: `Successfully retrieved resources for ${deviceId}`,
                    failure: 'Resource retrieval failed',
                    onSuccess: (entries) => {
                        if (isJsonMode()) printOk(entries);
                        else console.log(formatDeviceResourcesWithSchemas(deviceId, entries));
                    },
                });
                return;
            }
            await runDeviceCommand({
                start: `Calling resource ${resource} for ${deviceId}...`,
                fn: () => callDeviceResource(deviceId, resource, opts.input),
                success: `Resource ${resource} returned successfully for ${deviceId}`,
                failure: 'Resource call failed',
                onSuccess: (result) => {
                    const value = extractField(result, opts.field);
                    if (isJsonMode()) printOk(value);
                    else console.log(value);
                },
            });
        });
}
