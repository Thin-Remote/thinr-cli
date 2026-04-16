import chalk from 'chalk';
import { InvalidArgumentError } from 'commander';
import { configExists } from '../lib/config.js';
import { formatDeviceProperty, getDeviceProperty } from '../lib/property.js';
import { callDeviceResource } from '../lib/resource.js';
import { filterActiveDevices, getDevices } from '../lib/device.js';
import {
    setJsonMode,
    isJsonMode,
    printOk,
    printErr,
    createSpinner,
    classifyError,
} from '../lib/output.js';

function ensureConfigured() {
    if (!configExists()) {
        printErr('Not configured. Run thinr without parameters to set up.', { code: 'not_configured' });
    }
}

function applyJsonFlag(opts) {
    if (opts.json) setJsonMode(true);
}

function getGlobalUser(cmd) {
    let root = cmd;
    while (root.parent) root = root.parent;
    return root.opts().user || null;
}

function collectInput(value, previous = {}) {
    const idx = value.indexOf('=');
    if (idx === -1) throw new InvalidArgumentError('must be key=value');
    return { ...previous, [value.slice(0, idx)]: value.slice(idx + 1) };
}

async function fetchProductDevices(productId, group, user) {
    const filter = { productId };
    if (group) filter.asset_group = group;
    return getDevices(filter, user);
}

/**
 * `thinr product <subcommand> <productId> …` — fan-out commands across
 * every device that belongs to a product.
 */
export function productCommand(program) {
    const product = program
        .command('product')
        .description('Product commands (subcommand-first: thinr product <action> <productId>)');

    product
        .command('property <productId> <propertyId>')
        .description("Read a property on every device of the product")
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
                    const value = opts.field
                        ? opts.field.split('.').reduce((obj, key) => obj && obj[key], property)
                        : property;
                    results.push({ device: device.device, ok: true, data: value });
                    if (!isJsonMode()) {
                        console.log('Device', chalk.blue(device.device), 'property', chalk.blue(propertyId));
                        if (opts.field) console.log(value);
                        else console.log(formatDeviceProperty(device.device, propertyId, property));
                    }
                } catch (error) {
                    const { message, code } = classifyError(error);
                    results.push({ device: device.device, ok: false, error: { message, code } });
                    if (!isJsonMode()) {
                        console.error(chalk.red(`Error retrieving property ${propertyId} for device ${device.device}: ${message}`));
                    }
                }
            }
            if (isJsonMode()) printOk({ product: productId, property: propertyId, results });
        });

    product
        .command('resource <productId> <resource>')
        .description("Call a resource on every active device of the product")
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
                    const value = opts.field
                        ? opts.field.split('.').reduce((obj, key) => obj && obj[key], result)
                        : result;
                    results.push({ device: device.device, ok: true, data: value });
                    if (!isJsonMode()) {
                        console.log('Device', chalk.blue(device.device), 'resource', chalk.blue(resource));
                        console.log(value);
                    }
                } catch (error) {
                    const { message, code } = classifyError(error);
                    results.push({ device: device.device, ok: false, error: { message, code } });
                    if (!isJsonMode()) {
                        console.error(chalk.red(`Error executing resource ${resource} for device ${device.device}: ${message}`));
                    }
                }
            }
            if (isJsonMode()) printOk({ product: productId, resource, results });
        });
}
