// @ts-check
import {
    formatDeviceProperty,
    getDeviceProperty,
    getDeviceProperties,
    formatDeviceProperties,
} from '../../lib/property.js';
import { isJsonMode, printOk } from '../../lib/output.js';
import {
    applyJsonFlag,
    ensureConfigured,
    extractField,
    runDeviceCommand,
} from './_shared.js';

export function registerPropertyCommand(device) {
    device
        .command('property <deviceId> [propertyId]')
        .helpGroup('State & resources:')
        .description('List device properties, or read one by ID')
        .option('-j, --json', 'Output as JSON')
        .option('-f, --field <field>', 'Extract a sub-field (dot path, e.g. data.value)')
        .action(async (deviceId, propertyId, opts) => {
            applyJsonFlag(opts);
            ensureConfigured();
            if (!propertyId) {
                await runDeviceCommand({
                    start: `Getting properties for ${deviceId}...`,
                    fn: () => getDeviceProperties(deviceId),
                    success: `Properties for ${deviceId} retrieved successfully`,
                    failure: 'Property retrieval failed',
                    onSuccess: (result) => {
                        if (isJsonMode()) printOk(result);
                        else console.log(formatDeviceProperties(deviceId, result));
                    },
                });
                return;
            }
            await runDeviceCommand({
                start: `Retrieving property for ${deviceId}...`,
                fn: () => getDeviceProperty(deviceId, propertyId),
                success: `Property ${propertyId} for ${deviceId} found`,
                failure: 'Property retrieval failed',
                onSuccess: (property) => {
                    const value = extractField(property, opts.field);
                    if (isJsonMode()) printOk(value);
                    else if (opts.field) console.log(value);
                    else console.log(formatDeviceProperty(deviceId, propertyId, property));
                },
            });
        });
}
