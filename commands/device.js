import { handleProxyAction } from '../lib/proxy.js';
import { connectToDeviceConsole } from '../lib/console.js';
import { getDeviceStatus, formatDeviceStatus } from '../lib/status.js';
import { formatDeviceProperty, getDeviceProperty, getDeviceProperties, formatDeviceProperties } from '../lib/property.js';
import chalk from 'chalk';
import ora from 'ora';
import { configExists } from '../lib/config.js';
import { getDeviceResources, executeDeviceResource, formatDeviceResources } from "../lib/resource.js";


/**
 * Register the device command with all device-related subcommands
 * @param {Command} program - Commander program instance
 */
export function deviceCommand(program) {

    const device = program.command('device').description('Device commands');

    device
        .argument('<deviceId>', 'ID of the device to manage')
        .description('Manage device connections and proxies')
        .allowUnknownOption(true)
        .allowExcessArguments(true)
        .action(async (deviceId, options, command) => {
            // Get additional arguments manually
            const args = command.args.slice(1); // Skip deviceId
            const action = args[0];
            const target = args[1] && !args[1].startsWith('-') ? args[1] : null; // Check if target is provided, skip if it's an option

            // Check if configured
            if (!configExists()) {
                console.error(chalk.red('Error: Not configured. Run thinr without parameters to set up.'));
                process.exit(1);
            }

            // If no action provided, show help
            if (!action) {
                printHelp(deviceId);
                return;
            }

            // Parse options manually from process.argv
            const parsedOptions = {
                port: null,
                json: false,
                openBrowser: true,
                inputs: {},
                field: "",
            };

            const argv = process.argv;
            for (let i = 0; i < argv.length; i++) {
                if (argv[i] === '-p' || argv[i] === '--port') {
                    parsedOptions.port = argv[i + 1];
                    i++; // Skip the value
                } else if (argv[i] === '-j' || argv[i] === '--json') {
                    parsedOptions.json = true;
                } else if (argv[i] === '--no-open') {
                    parsedOptions.open = false;
                } else if (argv[i] === '-i' || argv[i] === '--input') {
                    let inputPair = argv[i + 1].split('=');
                    parsedOptions.inputs[inputPair[0]] = inputPair[1];
                } else if (argv[i] === '-f' || argv[i] === '--field') {
                    parsedOptions.field = argv[i + 1];
                } else if (argv[i] === '-h' || argv[i] === '--help') {
                    printHelp(deviceId);
                    return;
                }
            }

            switch (action.toLowerCase()) {
                case 'tcp':
                    await handleProxyAction(deviceId, 'tcp', target, parsedOptions);
                    break;
                
                case 'tls':
                    await handleProxyAction(deviceId, 'tls', target, parsedOptions);
                    break;
                
                case 'http':
                    await handleProxyAction(deviceId, 'http', target, parsedOptions);
                    break;
                
                case 'console':
                    try {
                        await connectToDeviceConsole(deviceId);
                    } catch (error) {
                        console.error(chalk.red(`Error: ${error.message}`));
                        process.exit(1);
                    }
                    break;
                
                case 'status': {
                    const spinner = ora(`Checking status of ${deviceId}...`).start();
                    try {
                        const status = await getDeviceStatus(deviceId);
                        spinner.succeed(`Device ${deviceId} found`);

                        if (parsedOptions.json) {
                            console.log(JSON.stringify(status, null, 2));
                        } else {
                            console.log(formatDeviceStatus(deviceId, status));
                        }
                    } catch (error) {
                        spinner.fail(`Status check failed`);
                        console.error(chalk.red(`Error: ${error.message}`));
                        process.exit(1);
                    }
                    break;
                }

                case 'property': {

                    if ( !target ) {
                        const spinner = ora(`Getting properties for ${deviceId}...`).start();
                        try {
                            const result = await getDeviceProperties(deviceId);
                            spinner.succeed(`Properties for ${deviceId} retrieved successfully`);
                            if (parsedOptions.json) {
                                console.log(result);
                            } else {
                                console.log(chalk.green(`Resource result for device ${deviceId}:`));
                                console.log(formatDeviceProperties(deviceId, result));
                            }
                        } catch (error) {
                            spinner.fail(`Property retrieval failed`);
                            console.error(chalk.red(`Error: ${error.message}`));
                            process.exit(1);
                        }
                    } else {
                        const spinner = ora(`Retrieving property for ${deviceId}...`).start();
                        try {
                            const property = await getDeviceProperty(deviceId, target);
                            spinner.succeed(`Property ${target} for ${deviceId} found`);

                            if (parsedOptions.json) {
                                if ( parsedOptions.field ) {
                                    console.log(parsedOptions.field.split('.').reduce((obj, key) => obj && obj[key], property));
                                } else {
                                    console.log(JSON.stringify(property, null, 2));
                                }
                            } else {
                                console.log(formatDeviceProperty(deviceId, target, property));
                            }
                        } catch (error) {
                            spinner.fail(`Property retrieval failed`);
                            console.error(chalk.red(`Error: ${error.message}`));
                            process.exit(1);
                        }

                    }

                    break;
                }

                case 'resource': {

                    if (!target) {
                        const spinner = ora(`Getting resources for ${deviceId}...`).start();
                        try {

                            const result = await getDeviceResources(deviceId);
                            spinner.succeed(`Succesfully retrieved resources for ${deviceId}`);

                            if (parsedOptions.json) {
                                console.log(result);
                            } else {
                                //console.log(chalk.green(`Resource ${target} result for device ${deviceId}:`));
                                console.log(chalk.green(`Resource result for device ${deviceId}:`));
                                console.log(formatDeviceResources(deviceId, result));
                            }
                        } catch (error) {
                            spinner.fail(`Resource retrieval failed`);
                            console.error(chalk.red(`Error: ${error.message}`));
                            process.exit(1);
                        }

                    } else {
                        const spinner = ora(`Executing resource ${target} for ${deviceId}...`).start();
                        try {

                            const result = await executeDeviceResource(deviceId, target, parsedOptions.inputs);
                            spinner.succeed(`Resource ${target} executed successfully for ${deviceId}`);

                            if ( parsedOptions.field ) {
                                console.log(parsedOptions.field.split('.').reduce((obj, key) => obj && obj[key], result));
                            } else {
                                console.log(result);
                            }

                        } catch (error) {
                            spinner.fail(`Resource execution failed`);
                            console.error(chalk.red(`Error: ${error.message}`));
                            process.exit(1);
                        }
                    }

                    break;
                }

                default:
                    console.error(chalk.red(`Error: Unknown action '${action}'. Available actions: tcp, tls, http, console, status, property, resource.\n`));
                    printHelp(deviceId);
                    process.exit(1);
            }
        });

}
function printHelp(deviceId) {
    console.log(`Usage: thinr device ${deviceId} <command> [options]

Available commands for device "${deviceId}":

  tcp [target]                  Create a TCP proxy (no TLS)
                                Example: thinr device ${deviceId} tcp 22
  
  tls [target]                  Create a TLS proxy  
                                Example: thinr device ${deviceId} tls 443
  
  http [target]                 Create an HTTP proxy
                                Example: thinr device ${deviceId} http 8080
  
  console                       Open terminal console
                                Example: thinr device ${deviceId} console
  
  status                        Check device status
                                Example: thinr device ${deviceId} status
                            
  property                      Get device properties
                                Example: thinr device ${deviceId} property
                     
  property [propertyId]         Get a specific property of the device
                                Example: thinr device ${deviceId} property uptime
                            
  resource                      Get resources of the device
                                Example: thinr device ${deviceId} resource
                            
  resource [resource]           Execute a specific resource of the device
                                Example: thinr device ${deviceId} resource reboot

Arguments:

  target                        Target for proxy commands (address:port, port, or address)
                                Defaults: tcp=22, tls=443, http=80
                     
  propertyId                    ID of the property to retrieve (for property command)
  
  resource                      Name of the resource to execute (for resource command)

Options (for proxy commands):
  -p, --port <port>  Local port to use (default: random)
  --no-open          Do not open browser (http only)

Options (for status command):
  -j, --json         Output as JSON
  
Options (for property command):
  -j, --json         Output as JSON
  -f, --field <field>          Field to extract from the property (e.g., -f data.value)
    
Options (for resource command):
  -i, --input <input>=<value>  Input for the resource (e.g., -i param1=value1 -i param2=value2)
  -j, --json         Output as JSON
  -f, --field <field>          Field to extract from the property (e.g., -f data.value)

Use "thinr device ${deviceId} <command> --help" for more details on each command.`);

}