// @ts-check
import { callDeviceResource } from '../../lib/resource.js';
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
    collectInput,
    ensureConfigured,
    extractField,
    getGlobalUser,
} from '../_shared.js';
import { fetchProductDevices } from './_shared.js';

export function registerProductResourceCommand(product) {
    product
        .command('resource <productId> <resource>')
        .helpGroup('Fan-out:')
        .description('Call a resource on every active device of the product')
        .option('-j, --json', 'Output as JSON')
        .option('-f, --field <field>', 'Extract a sub-field from each result (dot path)')
        .option('-g, --group <group>', 'Filter devices by asset group')
        .option('-i, --input <key=value>', 'Resource input (repeatable)', collectInput, {})
        .action(async (productId, resource, opts, cmd) => {
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
            devices = filterActiveDevices(devices);

            const results = [];
            for (const device of devices) {
                try {
                    const result = await callDeviceResource(device.device, resource, opts.input);
                    const value = extractField(result, opts.field);
                    results.push({ device: device.device, ok: true, data: value });
                    if (!isJsonMode()) {
                        console.log(
                            'Device',
                            info(device.device),
                            'resource',
                            info(resource),
                        );
                        console.log(value);
                    }
                } catch (error) {
                    const { message, code } = classifyError(error);
                    results.push({ device: device.device, ok: false, error: { message, code } });
                    if (!isJsonMode()) {
                        console.error(
                            errorStyle(
                                `Error executing resource ${resource} for device ${device.device}: ${message}`,
                            ),
                        );
                    }
                }
            }
            if (isJsonMode()) printOk({ product: productId, resource, results });
        });
}
