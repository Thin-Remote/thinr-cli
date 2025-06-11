import axios from 'axios';
import chalk from 'chalk';
import open from 'open';
import { readConfig } from './config.js';

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
export async function createProxy(deviceId, options) {
    // Get configuration
    const config = readConfig();

    if (!config.token || !config.server || !config.username) {
        throw new Error('Not configured. Run thingr without parameters to set up.');
    }

    const protocol = options.web ? 'http_iotmp' : 'tcp_iotmp';
    const targetAddress = options.targetAddress || 'localhost';
    const targetPort = options.targetPort || (options.web ? 80 : 22);
    const serverPort = options.serverPort || getRandomPort();
    const serverSecure = options.serverSecure || (!!options.web);
    const targetSecure = options.targetSecure || false;

    // Create a unique proxy ID based on device, protocol and a timestamp
    const timestamp = new Date().getTime().toString(36);
    const proxyId = `${protocol}_${deviceId}_${timestamp}`;

    try {
        // Create proxy
        const response = await axios.post(
            `https://${config.server}/v1/proxies`,
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
                    'Authorization': `Bearer ${config.token}`,
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
export async function deleteProxy(proxyId) {
    // Get configuration
    const config = readConfig();

    if (!config.token || !config.server) {
        return; // Silently fail on config issues during cleanup
    }

    try {
        await axios.delete(
            `https://${config.server}/v1/proxies/${proxyId}`,
            {
                headers: {
                    'Authorization': `Bearer ${config.token}`
                }
            }
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
export async function openBrowser(url) {
    try {
        await open(url);
        return true;
    } catch (error) {
        console.error(chalk.red(`Error opening browser: ${error.message}`));
        return false;
    }
}