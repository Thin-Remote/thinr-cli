import { configExists } from "../lib/config.js";
import chalk from "chalk";
import ora from "ora";
import { formatDeviceProperty, getDeviceProperty } from "../lib/property.js";
import { callDeviceResource } from "../lib/resource.js";
import { filterActiveDevices, getDevices } from "../lib/device.js";
import { isJsonMode, printOk, printErr, createSpinner, classifyError } from "../lib/output.js";

/**
 * Register the product command with all product related functionality.
 * @param {Command} program - Commander program instance
 */
export function productCommand(program) {

    const product = program.command('product').description('Product commands');

    product
        .argument('<productId>', 'ID of the product to manage')
        .description('Device commands for a specific product')
        .allowUnknownOption(true)
        .allowExcessArguments(true)
        .action( async (productId, options, command) => {

            // Get additional arguments manually
            const args = command.args.slice(1); // Skip productId
            const action = args[0];
            const target = args[1] && !args[1].startsWith('-') ? args[1] : null;

            // Check if configured
            if (!configExists()) {
                printErr('Not configured. Run thinr without parameters to set up.', { code: 'not_configured' });
            }

            // If no action provided, show help
            if (!action) {
                printHelp(productId);
                return;
            }

            // Parse options manually from process.argv
            const parsedOptions = {
                json: false,
                inputs: {},
                field: "",
                allDevices: false,
                group: null // Group option for filtering devices
            };

            const argv = process.argv;
            for (let i = 0; i < argv.length; i++) {
                if (argv[i] === '-j' || argv[i] === '--json') {
                    parsedOptions.json = true;
                } else if (argv[i] === '-i' || argv[i] === '--input') {
                    let inputPair = argv[i + 1].split('=');
                    parsedOptions.inputs[inputPair[0]] = inputPair[1];
                } else if (argv[i] === '-f' || argv[i] === '--field') {
                    parsedOptions.field = argv[i + 1];
                } else if (argv[i] === '-h' || argv[i] === '--help') {
                    printHelp(productId);
                    return;
                } else if (argv[i] === '-a' || argv[i] === '--all') {
                    parsedOptions.allDevices = true;
                } else if (argv[i] === '-g' || argv[i] === '--group') {
                    parsedOptions.group = argv[i + 1];
                }

            }

            let devices = [];
            const spinner = createSpinner(`Retrieving devices for product ${productId}...`).start();
            try {
                let filter = {
                    productId: productId,
                };
                if (parsedOptions.group) {
                    filter.asset_group = parsedOptions.group;
                }
                devices = await getDevices(filter);
                spinner.succeed(`Devices for product ${productId} retrieved successfully`);
            } catch (e) {
                spinner.fail(`Failed to retrieve devices for product ${productId}`);
                const { message, code } = classifyError(e);
                printErr(message, { code });
            }

            switch (action.toLowerCase()) {

                case 'property': {
                    if (!parsedOptions.allDevices) {
                        devices = filterActiveDevices(devices);
                    }
                    const results = [];
                    for (const device of devices) {
                        try {
                            const property = await getDeviceProperty(device.device, target);
                            const value = parsedOptions.field
                                ? parsedOptions.field.split('.').reduce((obj, key) => obj && obj[key], property)
                                : property;
                            results.push({ device: device.device, ok: true, data: value });
                            if (!isJsonMode()) {
                                console.log('Device', chalk.blue(device.device), 'property', chalk.blue(target));
                                if (parsedOptions.field) {
                                    console.log(value);
                                } else {
                                    console.log(formatDeviceProperty(device.device, target, property));
                                }
                            }
                        } catch (e) {
                            const { message, code } = classifyError(e);
                            results.push({ device: device.device, ok: false, error: { message, code } });
                            if (!isJsonMode()) {
                                console.error(chalk.red(`Error retrieving property ${target} for device ${device.device}: ${e.message}`));
                            }
                        }
                    }
                    if (isJsonMode()) {
                        printOk({ product: productId, property: target, results });
                    }
                    break;
                }

                case 'resource': {
                    devices = filterActiveDevices(devices);
                    const results = [];
                    for (const device of devices) {
                        try {
                            const result = await callDeviceResource(device.device, target, parsedOptions.inputs);
                            const value = parsedOptions.field
                                ? parsedOptions.field.split('.').reduce((obj, key) => obj && obj[key], result)
                                : result;
                            results.push({ device: device.device, ok: true, data: value });
                            if (!isJsonMode()) {
                                console.log('Device', chalk.blue(device.device), 'resource', chalk.blue(target));
                                console.log(value);
                            }
                        } catch (e) {
                            const { message, code } = classifyError(e);
                            results.push({ device: device.device, ok: false, error: { message, code } });
                            if (!isJsonMode()) {
                                console.error(chalk.red(`Error executing resource ${target} for device ${device.device}: ${e.message}`));
                            }
                        }
                    }
                    if (isJsonMode()) {
                        printOk({ product: productId, resource: target, results });
                    }
                    break;
                }

                default:
                    if (isJsonMode()) {
                        printErr(`Unknown action '${action}'. Available actions: property, resource.`, { code: 'input_error' });
                    }
                    console.error(chalk.red(`Error: Unknown action '${action}'. Available actions: property, resource.\n`));
                    printHelp(productId);
                    process.exit(1);
            }
        });
}

function printHelp(productId) {
    console.log(`Usage: thinr device product ${productId} <command> [options]

Available commands for device product "${productId}":

  property [propertyId]         Get a specific property of all devices belonging to the product
                                Example: thinr device product ${productId} property uptime

  resource [resource]           Execute a specific resource of all devices belonging to the product
                                Example: thinr device product ${productId} resource reboot

Arguments:

  propertyId                    ID of the property to retrieve (for property command)

  resource                      Name of the resource to execute (for resource command)
  

Options (for all product subcommands):
  -g, --group <group>          Group of devices to filter (e.g., -g group1)

Options (for property command):
  -j, --json                   Output as JSON
  -f, --field <field>          Field to extract from the property (e.g., -f data.value)
  -a, --all                    Include non active devices (default: false)

Options (for resource command):
  -j, --json                   Output as JSON
  -f, --field <field>          Field to extract from the property (e.g., -f data.value)

Use "thinr product device ${productId} <command> --help" for more details on each command.`);

}