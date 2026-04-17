// @ts-check
import {
    formatDeviceProperty,
    getDeviceProperty,
    getDeviceProperties,
    formatDeviceProperties,
} from '../../lib/property.js';
import { isJsonMode, printOk, printErr, createSpinner, classifyError } from '../../lib/output.js';
import { applyJsonFlag, ensureConfigured } from './_shared.js';

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
                const spinner = createSpinner(`Getting properties for ${deviceId}...`).start();
                try {
                    const result = await getDeviceProperties(deviceId);
                    spinner.succeed(`Properties for ${deviceId} retrieved successfully`);
                    if (isJsonMode()) printOk(result);
                    else console.log(formatDeviceProperties(deviceId, result));
                } catch (error) {
                    spinner.fail('Property retrieval failed');
                    const { message, code } = classifyError(error);
                    printErr(message, { code });
                }
                return;
            }
            const spinner = createSpinner(`Retrieving property for ${deviceId}...`).start();
            try {
                const property = await getDeviceProperty(deviceId, propertyId);
                spinner.succeed(`Property ${propertyId} for ${deviceId} found`);
                const value = opts.field
                    ? opts.field.split('.').reduce((obj, key) => obj && obj[key], property)
                    : property;
                if (isJsonMode()) printOk(value);
                else if (opts.field) console.log(value);
                else console.log(formatDeviceProperty(deviceId, propertyId, property));
            } catch (error) {
                spinner.fail('Property retrieval failed');
                const { message, code } = classifyError(error);
                printErr(message, { code });
            }
        });
}
