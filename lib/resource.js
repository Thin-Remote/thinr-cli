import chalk from 'chalk';
import { readConfig } from './config.js';
import api from './api.js';

/**
 * Get device resource value
 * @param {string} deviceId - Device ID to query
 * @return {Promise<Object>} Resource value
 */
export async function getDeviceResources(deviceId) {
    // Get configuration
    const config = readConfig();

    if (!config.token || !config.server || !config.username) {
        throw new Error('Not configured. Run thinr without parameters to set up.');
    }

    try {
        // Fetch resource value
        const response = await api.get(
            `/v3/users/${config.username}/devices/${deviceId}/resources`,
        );

        // Remove hidden resources for which the keys starting with '_'
        const filtered = Object.fromEntries(
            Object.entries(response.data).filter(([key]) => !key.startsWith('$'))
        );

        return filtered;
    } catch (error) {
        if (error.response) {
            // The request was made and the server responded with a status code
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
 * Execute a resource on a device
 */
export async function executeDeviceResource(deviceId, resourceId, inputs) {
    // Get configuration
    const config = readConfig();

    if (!config.token || !config.server || !config.username) {
        throw new Error('Not configured. Run thinr without parameters to set up.');
    }

    try {
        // Execute resource
        const response = await api.post(
            `/v3/users/${config.username}/devices/${deviceId}/resources/${resourceId}`,
            inputs,
        );

        return response.data;
    } catch (error) {
        if (error.response) {
            // The request was made and the server responded with a status code
            if (error.response.status === 404) {
                throw new Error(`Resource not found: ${resourceId} on device ${deviceId}`);
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
 * Format device resources for display
 * @param {string} deviceId - Device ID
 * @param {Object} resources - Resources data from API
 * @return {string} Formatted resources
 */
export function formatDeviceResources(deviceId, resources) {
    let formattedResources = `\nResources for device ${chalk.cyan(deviceId)}:\n`;

    //
    if (resources && Object.keys(resources).length > 0) {
        Object.keys(resources).forEach(key => {
            formattedResources += `- ${chalk.green(key)}: ${chalk.blue(getResourceType(resources[key]))}\n`;
        });
    } else {
        formattedResources += chalk.yellow('No resources found for this device.\n');
    }

    return formattedResources;
}

function getResourceType(value) {
    switch (value.fn) {
        case 1:
            return "no parameters";
        case 2:
            return "input";
        case 3:
            return "output";
        case 4:
            return "input/output";
        default:
            return 'unknown';
    }
}
