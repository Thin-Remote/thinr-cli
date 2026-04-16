import chalk from 'chalk';
import { readConfig } from './config.js';
import api from './api.js';
import { apiError } from './errors.js';

/**
 * Get device resource value
 * @param {string} deviceId - Device ID to query
 * @return {Promise<Object>} Resource value
 */
export async function getDeviceResources(deviceId) {
    const config = readConfig();

    if (!config.token || !config.server || !config.username) {
        throw new Error('Not configured. Run thinr without parameters to set up.');
    }

    try {
        const response = await api.get(
            `/v3/users/${config.username}/devices/${deviceId}/resources`,
        );
        // Drop internal resources whose keys start with '$'
        return Object.fromEntries(
            Object.entries(response.data).filter(([key]) => !key.startsWith('$'))
        );
    } catch (error) {
        throw apiError(error, { notFound: `Device not found: ${deviceId}` });
    }
}

/**
 * Execute a resource on a device
 */
export async function executeDeviceResource(deviceId, resourceId, inputs) {
    const config = readConfig();

    if (!config.token || !config.server || !config.username) {
        throw new Error('Not configured. Run thinr without parameters to set up.');
    }

    try {
        const response = await api.post(
            `/v3/users/${config.username}/devices/${deviceId}/resources/${resourceId}`,
            inputs,
        );
        return response.data;
    } catch (error) {
        throw apiError(error, { notFound: `Resource not found: ${resourceId} on device ${deviceId}` });
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
