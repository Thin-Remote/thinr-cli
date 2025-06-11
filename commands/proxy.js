import { createProxy, deleteProxy, openBrowser } from '../lib/proxy.js';
import { connectToDeviceConsole } from '../lib/console.js';
import { getDeviceStatus, formatDeviceStatus } from '../lib/status.js';
import chalk from 'chalk';
import ora from 'ora';
import { configExists } from '../lib/config.js';

/**
 * Parse target argument into address and port
 * @param {string} target - Target in format 'address:port', 'port', 'address', or 'protocol://hostname_or_ip:port'
 * @param {number} defaultPort - Default port if not specified
 * @returns {Object} Parsed address, port, and secure flag
 */
function parseTarget(target, defaultPort) {
    if (!target) {
        return { address: 'localhost', port: defaultPort, isSecure: false };
    }

    // Check if target is just a number (port only)
    if (/^\d+$/.test(target)) {
        return { address: 'localhost', port: parseInt(target), isSecure: false };
    }

    let isSecure = false;
    let cleanTarget = target;
    
    // Check if target starts with a protocol (full URL format)
    if (target.startsWith('https://')) {
        isSecure = true;
        cleanTarget = target.replace('https://', '');
    } else if (target.startsWith('http://')) {
        isSecure = false;
        cleanTarget = target.replace('http://', '');
    }

    // Remove any path/query/fragment from the URL (everything after the first slash)
    const slashIndex = cleanTarget.indexOf('/');
    if (slashIndex !== -1) {
        cleanTarget = cleanTarget.substring(0, slashIndex);
    }

    // Parse the remaining part (hostname_or_ip:port or just hostname_or_ip)
    let address;
    let port;

    if (cleanTarget.includes(':')) {
        // Format: hostname_or_ip:port
        const lastColonIndex = cleanTarget.lastIndexOf(':');
        address = cleanTarget.substring(0, lastColonIndex);
        const portStr = cleanTarget.substring(lastColonIndex + 1);
        
        // Check if the part after the last colon is actually a port number
        const parsedPort = parseInt(portStr);
        if (!isNaN(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
            port = parsedPort;
        } else {
            // Not a valid port, treat the whole thing as address
            address = cleanTarget;
            port = defaultPort;
        }
    } else {
        // Format: just hostname_or_ip
        address = cleanTarget;
        port = defaultPort;
    }

    // If we detected a protocol but no explicit port, use protocol defaults
    if ((target.startsWith('https://') || target.startsWith('http://')) && port === defaultPort) {
        if (isSecure && defaultPort !== 443) {
            port = 443; // Default HTTPS port
        } else if (!isSecure && defaultPort !== 80) {
            port = 80; // Default HTTP port
        }
    }

    return { 
        address: address || 'localhost', 
        port: port, 
        isSecure 
    };
}

/**
 * Create proxy action handler
 */
async function handleProxyAction(deviceId, protocol, target, options) {
    // Check if configured
    if (!configExists()) {
        console.error(chalk.red('Error: Not configured. Run thingr without parameters to set up.'));
        process.exit(1);
    }

    // Determine default port based on protocol
    const defaultPort = protocol === 'http' ? 80 : (protocol === 'tls' ? 443 : 22);
    const { address, port, isSecure } = parseTarget(target, defaultPort);

    // Determine proxy configuration based on protocol
    let proxyConfig = {
        targetAddress: address,
        targetPort: port,
        serverPort: options.port ? parseInt(options.port) : null,
        targetSecure: false,
        serverSecure: false,
        web: false
    };

    switch (protocol) {
        case 'tcp':
            // TCP proxy without TLS
            proxyConfig.serverSecure = false;
            break;
        case 'tls':
            // TLS proxy
            proxyConfig.targetSecure = true;
            proxyConfig.serverSecure = true;
            break;
        case 'http':
            // HTTP proxy
            proxyConfig.web = true;
            proxyConfig.serverSecure = true; // Default to HTTPS for web interface
            // Use the isSecure flag from parseTarget
            proxyConfig.targetSecure = isSecure || port === 443;
            break;
    }

    const proxyType = proxyConfig.web ? 'HTTP proxy' : `${protocol.toUpperCase()} proxy`;
    const spinner = ora(`Creating ${proxyType} to ${deviceId} (${address}:${port})...`).start();
    let proxyId = null;

    try {
        // Create proxy
        const proxy = await createProxy(deviceId, proxyConfig);
        proxyId = proxy.proxyId;

        if (proxyConfig.web) {
            // For HTTP proxy, show target as URL format
            const targetProtocol = isSecure ? 'https' : 'http';
            const targetUrl = `${targetProtocol}://${address}${port === 80 || port === 443 ? '' : `:${port}`}`;
            
            spinner.succeed(`HTTP proxy running at ${chalk.blue(proxy.url)} → ${deviceId} -> ${chalk.cyan(targetUrl)}`);

            // Open browser if not disabled
            if (options.open !== false) {
                await openBrowser(proxy.url);
            }
        } else {
            // For TCP/TLS proxy, show address:port format
            const secureInfo = isSecure ? ' [TLS]' : '';
            spinner.succeed(`${protocol.toUpperCase()} proxy running on ${chalk.blue(proxy.serverHost + ':' + proxy.serverPort)} → ${deviceId} (${address}:${port})${secureInfo}`);
        }

        console.log(chalk.gray(`Press Ctrl+C to stop`));

        // Handle process termination
        process.on('SIGINT', async () => {
            console.log(chalk.yellow('\nStopping proxy...'));
            if (proxyId) {
                await deleteProxy(proxyId);
            }
            process.exit(0);
        });

        // Keep the process running
        process.stdin.resume();

    } catch (error) {
        spinner.fail(`Failed to create ${proxyType}`);
        console.error(chalk.red(`Error: ${error.message}`));

        // Clean up if needed
        if (proxyId) {
            await deleteProxy(proxyId);
        }

        process.exit(1);
    }
}

/**
 * Register the device command with all device-related subcommands
 * @param {Command} program - Commander program instance
 */
export function deviceCommand(program) {
    program
        .command('device <deviceId>')
        .description('Manage device connections and proxies')
        .allowUnknownOption(true)
        .allowExcessArguments(true)
        .action(async (deviceId, options, command) => {
            // Get additional arguments manually
            const args = command.args.slice(1); // Skip deviceId
            const action = args[0];
            const target = args[1];
            
            // Parse options manually from process.argv
            const parsedOptions = {
                port: null,
                json: false,
                open: true
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
                }
            }

            // Check if configured
            if (!configExists()) {
                console.error(chalk.red('Error: Not configured. Run thingr without parameters to set up.'));
                process.exit(1);
            }

            // If no action provided, show help
            if (!action) {
                console.log(`Usage: thingr device ${deviceId} <command> [options]

Available commands for device "${deviceId}":

  tcp [target]       Create a TCP proxy (no TLS)
                     Example: thingr device ${deviceId} tcp 22
  
  tls [target]       Create a TLS proxy  
                     Example: thingr device ${deviceId} tls 443
  
  http [target]      Create an HTTP proxy
                     Example: thingr device ${deviceId} http 8080
  
  console            Open terminal console
                     Example: thingr device ${deviceId} console
  
  status             Check device status
                     Example: thingr device ${deviceId} status

Arguments:
  target             Target for proxy commands (address:port, port, or address)
                     Defaults: tcp=22, tls=443, http=80

Options (for proxy commands):
  -p, --port <port>  Local port to use (default: random)
  --no-open          Do not open browser (http only)

Options (for status command):
  -j, --json         Output as JSON

Use "thingr device ${deviceId} <command> --help" for more details on each command.`);
                return;
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
                
                case 'status':
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
                
                default:
                    console.error(chalk.red(`Error: Unknown action '${action}'. Available actions: tcp, tls, http, console, status`));
                    process.exit(1);
            }
        });
}