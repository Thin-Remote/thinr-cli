import { handleProxyAction } from '../lib/proxy.js';
import { connectToDeviceConsole } from '../lib/console.js';
import { getDeviceStatus, formatDeviceStatus } from '../lib/status.js';
import { formatDeviceProperty, getDeviceProperty, getDeviceProperties, formatDeviceProperties } from '../lib/property.js';
import { createDeviceAPI } from '../lib/device-api.js';
import { launchEnv } from '../lib/env.js';
import { startMCPServer } from '../lib/mcp-server.js';
import chalk from 'chalk';
import ora from 'ora';
import { configExists } from '../lib/config.js';
import { callDeviceResource, listDeviceResourcesWithSchemas, formatDeviceResourcesWithSchemas } from "../lib/resource.js";
import { getDevices } from '../lib/device.js';
import { setJsonMode, isJsonMode, printOk, printErr, createSpinner, classifyError } from '../lib/output.js';


/**
 * Register the devices list command
 * @param {Command} program - Commander program instance
 */
export function devicesCommand(program) {
    program
        .command('devices')
        .description('List all devices')
        .option('-j, --json', 'Output as JSON')
        .action(async (options) => {
            if (options.json) setJsonMode(true);
            if (!configExists()) {
                printErr('Not configured. Run thinr without parameters to set up.', { code: 'not_configured' });
            }

            const globalOpts = program.opts();
            const spinner = createSpinner('Fetching devices...').start();
            try {
                const devices = await getDevices({}, globalOpts.user);
                spinner.succeed(`Found ${devices.length} device(s)`);

                if (isJsonMode()) {
                    printOk(devices);
                } else {
                    for (const d of devices) {
                        const online = d.connection?.active ? chalk.green('online ') : chalk.gray('offline');
                        const name = d.name ? chalk.gray(` (${d.name})`) : '';
                        console.log(`  ${online}  ${chalk.bold(d.device)}${name}`);
                    }
                }
            } catch (error) {
                spinner.fail('Failed to list devices');
                const { message, code } = classifyError(error);
                printErr(message, { code });
            }
        });
}

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
            const target = args[1] && !args[1].startsWith('-') ? args[1] : null;

            if (!configExists()) {
                printErr('Not configured. Run thinr without parameters to set up.', { code: 'not_configured' });
            }

            if (!action) {
                printHelp(deviceId);
                return;
            }

            // Get global --user option
            const globalUser = program.opts().user || null;

            // Parse options manually from process.argv
            const parsedOptions = {
                port: null,
                json: false,
                openBrowser: true,
                inputs: {},
                field: "",
                user: globalUser,
                legacy: false,
                channel: null,
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
                } else if (argv[i] === '-u' || argv[i] === '--user') {
                    parsedOptions.user = argv[i + 1];
                    i++;
                } else if (argv[i] === '--legacy') {
                    parsedOptions.legacy = true;
                } else if (argv[i] === '--channel') {
                    parsedOptions.channel = argv[i + 1];
                    i++;
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
                    const spinner = createSpinner(`Checking status of ${deviceId}...`).start();
                    try {
                        const status = await getDeviceStatus(deviceId);
                        spinner.succeed(`Device ${deviceId} found`);
                        if (isJsonMode()) {
                            printOk(status);
                        } else {
                            console.log(formatDeviceStatus(deviceId, status));
                        }
                    } catch (error) {
                        spinner.fail(`Status check failed`);
                        const { message, code } = classifyError(error);
                        printErr(message, { code });
                    }
                    break;
                }

                case 'property': {
                    if (!target) {
                        const spinner = createSpinner(`Getting properties for ${deviceId}...`).start();
                        try {
                            const result = await getDeviceProperties(deviceId);
                            spinner.succeed(`Properties for ${deviceId} retrieved successfully`);
                            if (isJsonMode()) {
                                printOk(result);
                            } else {
                                console.log(chalk.green(`Resource result for device ${deviceId}:`));
                                console.log(formatDeviceProperties(deviceId, result));
                            }
                        } catch (error) {
                            spinner.fail(`Property retrieval failed`);
                            const { message, code } = classifyError(error);
                            printErr(message, { code });
                        }
                    } else {
                        const spinner = createSpinner(`Retrieving property for ${deviceId}...`).start();
                        try {
                            const property = await getDeviceProperty(deviceId, target);
                            spinner.succeed(`Property ${target} for ${deviceId} found`);
                            const value = parsedOptions.field
                                ? parsedOptions.field.split('.').reduce((obj, key) => obj && obj[key], property)
                                : property;
                            if (isJsonMode()) {
                                printOk(value);
                            } else if (parsedOptions.field) {
                                console.log(value);
                            } else {
                                console.log(formatDeviceProperty(deviceId, target, property));
                            }
                        } catch (error) {
                            spinner.fail(`Property retrieval failed`);
                            const { message, code } = classifyError(error);
                            printErr(message, { code });
                        }
                    }
                    break;
                }

                case 'resource': {
                    if (!target) {
                        const spinner = createSpinner(`Getting resources for ${deviceId}...`).start();
                        try {
                            const entries = await listDeviceResourcesWithSchemas(deviceId);
                            spinner.succeed(`Succesfully retrieved resources for ${deviceId}`);
                            if (isJsonMode()) {
                                printOk(entries);
                            } else {
                                console.log(formatDeviceResourcesWithSchemas(deviceId, entries));
                            }
                        } catch (error) {
                            spinner.fail(`Resource retrieval failed`);
                            const { message, code } = classifyError(error);
                            printErr(message, { code });
                        }
                    } else {
                        const spinner = createSpinner(`Calling resource ${target} for ${deviceId}...`).start();
                        try {
                            const result = await callDeviceResource(deviceId, target, parsedOptions.inputs);
                            spinner.succeed(`Resource ${target} returned successfully for ${deviceId}`);
                            const value = parsedOptions.field
                                ? parsedOptions.field.split('.').reduce((obj, key) => obj && obj[key], result)
                                : result;
                            if (isJsonMode()) {
                                printOk(value);
                            } else {
                                console.log(value);
                            }
                        } catch (error) {
                            spinner.fail(`Resource call failed`);
                            const { message, code } = classifyError(error);
                            printErr(message, { code });
                        }
                    }
                    break;
                }

                case 'exec': {
                    // Drop CLI flags that may have leaked into the positional
                    // args (commander forwards unknown options when both
                    // allowUnknownOption and allowExcessArguments are set).
                    const cmdArgs = args
                        .slice(1)
                        .filter(a => a !== '--legacy' && a !== '--json' && a !== '-j')
                        .join(' ');
                    if (!cmdArgs) {
                        if (isJsonMode()) {
                            printErr('No command provided.', { code: 'input_error' });
                        }
                        console.error(chalk.red('Error: No command provided.'));
                        console.log(`Usage: thinr device ${deviceId} exec "ls -la"`);
                        process.exit(1);
                    }
                    try {
                        const api = createDeviceAPI(deviceId, { user: parsedOptions.user });
                        if (isJsonMode()) {
                            // Buffer stdout/stderr so we can emit a single JSON
                            // envelope at the end. Forces the non-streaming
                            // behaviour scripts actually want.
                            let stdout = '';
                            let stderr = '';
                            const { exitCode, timedOut, cancelled } = await api.execStream(cmdArgs, {
                                onStdout: (s) => { stdout += s; },
                                onStderr: (s) => { stderr += s; },
                            });
                            if (cancelled) {
                                printErr('Interrupted', { code: 'cancelled', exitCode: 130 });
                            }
                            if (timedOut) {
                                printErr('Command timed out on the device', { code: 'timeout' });
                            }
                            printOk({ stdout, stderr, exitCode: exitCode ?? null });
                            process.exit(exitCode ?? 1);
                        }
                        if (parsedOptions.legacy) {
                            // One-shot path for older devices without the
                            // streaming cmd resource. Buffers stdout/stderr
                            // server-side and returns the full result at the end.
                            const result = await api.exec(cmdArgs, 120);
                            if (result.stdout) process.stdout.write(result.stdout);
                            if (result.stderr) process.stderr.write(result.stderr);
                            process.exit(result.retcode || 0);
                        }
                        let cancelFn = null;
                        const onSigint = () => cancelFn?.();
                        process.on('SIGINT', onSigint);
                        const { exitCode, timedOut, cancelled } = await api.execStream(cmdArgs, {
                            onStdout: (s) => process.stdout.write(s),
                            onStderr: (s) => process.stderr.write(s),
                            onCancel: (fn) => { cancelFn = fn; },
                            stdin: process.stdin,
                        });
                        process.off('SIGINT', onSigint);
                        if (timedOut) {
                            console.error(chalk.red('\nError: command timed out on the device.'));
                        }
                        if (cancelled) {
                            console.error(chalk.yellow('\n[interrupted]'));
                            process.exit(130);
                        }
                        process.exit(exitCode ?? 1);
                    } catch (error) {
                        const { message, code } = classifyError(error);
                        if (isJsonMode()) {
                            printErr(message, { code });
                        }
                        console.error(chalk.red(`Error: ${message}`));
                        if (error.response) {
                            console.error(chalk.red(`Status: ${error.response.status}`));
                            console.error(chalk.red(`Body: ${JSON.stringify(error.response.data)}`));
                        }
                        process.exit(1);
                    }
                    break;
                }

                case 'update': {
                    const sub = (target || '').toLowerCase();
                    if (sub !== 'check' && sub !== 'apply') {
                        if (isJsonMode()) {
                            printErr("update requires 'check' or 'apply'", { code: 'input_error' });
                        }
                        console.error(chalk.red(`Error: update requires 'check' or 'apply'.`));
                        console.log(`Usage: thinr device ${deviceId} update check`);
                        console.log(`       thinr device ${deviceId} update apply [--channel <name>]`);
                        process.exit(1);
                    }
                    const channel = parsedOptions.channel || 'latest';
                    const label = sub === 'check' ? 'Checking for updates' : 'Applying update';
                    const spinner = createSpinner(`${label} on ${deviceId}...`).start();
                    try {
                        const api = createDeviceAPI(deviceId, { user: parsedOptions.user });
                        const timeout = sub === 'apply' ? 300000 : 30000;
                        const result = await api.callResource('update', { action: sub, channel }, { timeout });
                        spinner.succeed(`${label} finished`);
                        if (isJsonMode()) {
                            printOk(result);
                        } else if (result && typeof result === 'object') {
                            if (result.current) console.log(`  current: ${chalk.bold(result.current)}`);
                            if (result.latest)  console.log(`  latest:  ${chalk.bold(result.latest)}`);
                            if (result.arch)    console.log(`  arch:    ${result.arch}`);
                            if (result.status)  console.log(`  status:  ${chalk.cyan(result.status)}`);
                            if (result.message) console.log(`  message: ${result.message}`);
                        } else {
                            console.log(result);
                        }
                    } catch (error) {
                        spinner.fail(`${label} failed`);
                        const { message, code } = classifyError(error);
                        printErr(message, { code });
                    }
                    break;
                }

                case 'env': {
                    const envMountpoint = args[1] || `./remote-${deviceId}`;
                    const envCommand = args.slice(2);
                    try {
                        const exitCode = await launchEnv(deviceId, envMountpoint, envCommand, { user: parsedOptions.user });
                        process.exit(exitCode);
                    } catch (error) {
                        console.error(chalk.red(`Error: ${error.message}`));
                        process.exit(1);
                    }
                    break;
                }

                case 'mcp': {
                    try {
                        await startMCPServer(deviceId, { user: parsedOptions.user });
                    } catch (error) {
                        console.error(chalk.red(`Error: ${error.message}`));
                        process.exit(1);
                    }
                    break;
                }

                default:
                    console.error(chalk.red(`Error: Unknown action '${action}'. Available actions: tcp, tls, http, console, status, property, resource, exec, env, mcp, update.\n`));
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

  exec <command>                Execute a command on the remote device
                                Example: thinr device ${deviceId} exec "ls -la"

  env [path] [command]          Launch a remote environment (FUSE + remote shell)
                                Example: thinr device ${deviceId} env ~/remoto claude
                                Example: thinr device ${deviceId} env ~/remoto

  update check                  Check if an agent update is available
                                Example: thinr device ${deviceId} update check

  update apply [--channel <c>]  Apply an agent update (default channel: latest)
                                Example: thinr device ${deviceId} update apply

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

Options (for exec command):
  -j, --json                   Buffer stdout/stderr and emit a single JSON envelope at exit
  --legacy                     Use the non-streaming one-shot API (older agents)

Options (for update command):
  --channel <name>             Update channel (default: latest)
  -j, --json                   Output as JSON

All data-producing commands emit a common envelope in JSON mode:
  success: { "ok": true, "data": ... }
  failure: { "ok": false, "error": { "message": "...", "code": "..." } }

Use "thinr device ${deviceId} <command> --help" for more details on each command.`);

}