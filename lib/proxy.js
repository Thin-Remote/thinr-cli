import chalk from 'chalk';
import open, { apps } from 'open';
import ora from 'ora';
import { configExists, readConfig } from './config.js';
import api from './api.js';

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
export async function handleProxyAction(deviceId, protocol, target, options) {
    // Check if configured
    if (!configExists()) {
        console.error(chalk.red('Error: Not configured. Run thinr without parameters to set up.'));
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
            if (options.openBrowser !== false) {
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
 * Generate a random port number within a range
 * @param {number} min - Minimum port number
 * @param {number} max - Maximum port number
 * @returns {number} Random port number
 */
function getRandomPort(min = 50000, max = 51000) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Create a proxy to a device
 * @param {string} deviceId - Device ID
 * @param {Object} options - Proxy options
 * @returns {Promise<Object>} Proxy information
 */
async function createProxy(deviceId, options) {
    // Get configuration
    const config = readConfig();

    if (!config.token || !config.server || !config.username) {
        throw new Error('Not configured. Run thinr without parameters to set up.');
    }

    const protocol = options.web ? 'http_iotmp' : 'tcp_iotmp';
    const targetAddress = options.targetAddress || 'localhost';
    const targetPort = options.targetPort || (options.web ? 80 : 22);
    const serverPort = options.serverPort || getRandomPort();
    const serverSecure = options.serverSecure || (!!options.web);
    const targetSecure = options.targetSecure || false;

    // Create a unique proxy ID based on device, protocol and a timestamp
    const timestamp = new Date().getTime().toString(36);
    const proxyId = `${protocol}_${deviceId.slice(0,12)}_${timestamp}`;

    try {
        // Create proxy
        const response = await api.post(
            `/v1/proxies`,
            {
                enabled: true,
                config: {
                    target: {
                        type: 'address',
                        user: config.username,
                        device: deviceId,
                        address: targetAddress,
                        port: targetPort,
                        secure: targetSecure
                    },
                    protocol: protocol,
                    source: {
                        port: serverPort,
                        secure: serverSecure
                    }
                },
                proxy: proxyId,
                name: options.web ? `Web access for ${deviceId}` : `TCP proxy for ${deviceId}`,
                description: `${options.web ? 'Web interface' : 'TCP proxy'} for ${deviceId}:${targetPort} created by ThingR CLI`
            },
            {
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        // Determine the URL based on protocol and SSL setting
        const scheme = serverSecure ? 'https' : 'http';
        const url = options.web ? `${scheme}://${config.server}:${serverPort}` : null;

        return {
            proxyId: proxyId,
            url: url,
            serverPort: serverPort,
            serverHost: config.server,
            targetAddress: targetAddress,
            targetPort: targetPort,
            protocol: protocol,
            serverSecure: serverSecure,
            targetSecure: targetSecure
        };
    } catch (error) {
        if (error.response) {
            if (error.response.status === 401) {
                throw new Error('Unauthorized. Your token may have expired. Please reconfigure.');
            } else {
                throw new Error(`Server error: ${error.response.status} ${error.response.statusText}`);
            }
        } else if (error.request) {
            throw new Error('No response from server. Please check your connection.');
        } else {
            throw new Error(`Error: ${error.message}`);
        }
    }
}

/**
 * Delete a proxy
 * @param {string} proxyId - Proxy ID to delete
 */
async function deleteProxy(proxyId) {
    // Get configuration
    const config = readConfig();

    if (!config.token || !config.server) {
        return; // Silently fail on config issues during cleanup
    }

    try {
        await api.delete(
            `/v1/proxies/${proxyId}`,
        );

        return true;
    } catch (error) {
        console.error(chalk.red(`Error deleting proxy: ${error.message}`));
        return false;
    }
}

/**
 * Open web browser to the proxy URL
 * @param {string} url - URL to open
 */
async function openBrowser(url) {
    try {
        await open(url, {app: [{name: apps.browser}, 'firefox-developer-edition']});
        return true;
    } catch (error) {
        console.error(chalk.red(`Error opening browser: ${error.message}`));
        return false;
    }
}