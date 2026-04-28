// @ts-check
import { formatDeviceProperty, getDeviceProperty } from '../../lib/property.js';
import { filterActiveDevices } from '../../lib/devices.js';
import { error as errorStyle, info } from '../../lib/format.js';
import {
    isJsonMode,
    printOk,
    printErr,
    createSpinner,
    classifyError,
} from '../../lib/output.js';
import {
    applyJsonFlag,
    ensureConfigured,
    extractField,
    getGlobalUser,
} from '../_shared.js';
import { fetchProductDevices } from './_shared.js';

export function registerProductPropertyCommand(product) {
    product
        .command('property <productId> <propertyId>')
        .helpGroup('Fan-out:')
        .description('Read a property on every device of the product')
        .option('-j, --json', 'Output as JSON')
        .option('-f, --field <field>', 'Extract a sub-field from each property (dot path)')
        .option('-a, --all', 'Include offline devices (default: only active)')
        .option('-g, --group <group>', 'Filter devices by asset group')
        .action(async (productId, propertyId, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            const spinner = createSpinner(`Retrieving devices for product ${productId}...`).start();
            let devices;
            try {
                devices = await fetchProductDevices(productId, opts.group, user);
                spinner.succeed(`Devices for product ${productId} retrieved successfully`);
            } catch (error) {
                spinner.fail(`Failed to retrieve devices for product ${productId}`);
                const { message, code } = classifyError(error);
                printErr(message, { code });
                return;
            }
            if (!opts.all) devices = filterActiveDevices(devices);

            const results = [];
            for (const device of devices) {
                try {
                    const property = await getDeviceProperty(device.device, propertyId);
                    const value = extractField(property, opts.field);
                    results.push({ device: device.device, ok: true, data: value });
                    if (!isJsonMode()) {
                        console.log(
                            'Device',
                            info(device.device),
                            'property',
                            info(propertyId),
                        );
                        if (opts.field) console.log(value);
                        else console.log(formatDeviceProperty(device.device, propertyId, property));
                    }
                } catch (error) {
                    const { message, code } = classifyError(error);
                    results.push({ device: device.device, ok: false, error: { message, code } });
                    if (!isJsonMode()) {
                        console.error(
                            errorStyle(
                                `Error retrieving property ${propertyId} for device ${device.device}: ${message}`,
                            ),
                        );
                    }
                }
            }
            if (isJsonMode()) printOk({ product: productId, property: propertyId, results });
        });
}
