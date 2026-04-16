import chalk from 'chalk';
import { readConfig } from './config.js';
import api from './api.js';
import { apiError } from './errors.js';

/**
 * Get device status
 * @param {string} deviceId - Device ID to check
 * @returns {Promise<Object>} Status information
 */
export async function getDeviceStatus(deviceId) {
    const config = readConfig();

    if (!config.token || !config.server || !config.username) {
        throw new Error('Not configured. Run thinr without parameters to set up.');
    }

    try {
        const response = await api.get(
            `/v1/users/${config.username}/devices/${deviceId}/stats`,
        );
        return response.data;
    } catch (error) {
        throw apiError(error, { notFound: `Device not found: ${deviceId}` });
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