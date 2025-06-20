import chalk from 'chalk';
import { readConfig } from './config.js';
import api from './api.js';

/**
 * Get device status
 * @param {string} deviceId - Device ID to check
 * @returns {Promise<Object>} Status information
 */
export async function getDeviceStatus(deviceId) {
    // Get configuration
    const config = readConfig();

    if (!config.token || !config.server || !config.username) {
        throw new Error('Not configured. Run thinr without parameters to set up.');
    }

    try {
        // Fetch device status
        const response = await api.get(
            `/v1/users/${config.username}/devices/${deviceId}/stats`,
        );

        return response.data;
    } catch (error) {
        if (error.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            if (error.response.status === 404) {
                throw new Error(`Device not found: ${deviceId}`);
            } else if (error.response.status === 401) {
                throw new Error('Unauthorized. Your token may have expired. Please reconfigure.');
            } else {
                throw new Error(`Server error: ${error.response.status} ${error.response.statusText}`);
            }
        } else if (error.request) {
            // The request was made but no response was received
            throw new Error('No response from server. Please check your connection.');
        } else {
            // Something happened in setting up the request that triggered an Error
            throw new Error(`Error: ${error.message}`);
        }
    }
}

/**
 * Format device status data for display
 * @param {string} deviceId - Device ID
 * @param {Object} status - Status data from API
 * @returns {string} Formatted status
 */
export function formatDeviceStatus(deviceId, status) {
    const connectedStatus = status.connected ?
        chalk.green('● Online') :
        chalk.red('○ Offline');

    // Format connected time
    let connectedTime = '';
    if (status.connected && status.connected_ts) {
        const now = new Date().getTime();
        const connectedSince = new Date(status.connected_ts).getTime();
        const diffSeconds = Math.floor((now - connectedSince) / 1000);

        if (diffSeconds < 60) {
            connectedTime = `for ${diffSeconds} seconds`;
        } else if (diffSeconds < 3600) {
            connectedTime = `for ${Math.floor(diffSeconds / 60)} minutes`;
        } else if (diffSeconds < 86400) {
            connectedTime = `for ${Math.floor(diffSeconds / 3600)} hours`;
        } else {
            connectedTime = `for ${Math.floor(diffSeconds / 86400)} days`;
        }
    }

    // Format data transfer
    const rxMB = status.rx_bytes ? (status.rx_bytes / (1024 * 1024)).toFixed(2) : '0.00';
    const txMB = status.tx_bytes ? (status.tx_bytes / (1024 * 1024)).toFixed(2) : '0.00';

    // Build the output
    let output = `
${chalk.bold(`Device: ${deviceId}`)}
Status: ${connectedStatus} ${connectedTime}
`;

    if (status.ip_address) {
        output += `IP Address: ${status.ip_address}\n`;
    }

    output += `
Data Transfer:
  ↓ Received: ${rxMB} MB
  ↑ Sent: ${txMB} MB
`;

    return output;
}