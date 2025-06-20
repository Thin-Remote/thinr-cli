import chalk from 'chalk';
import { readConfig } from './config.js';
import api from './api.js';

/**
 * Get device properties
 * @param {string} deviceId - Device ID to query
 * @returns {Promise<Object>} Device properties
 */
export async function getDeviceProperties(deviceId) {
    // Get configuration
    const config = readConfig();

    if (!config.token || !config.server || !config.username) {
        throw new Error('Not configured. Run thinr without parameters to set up.');
    }

    try {
        // Fetch device properties
        const response = await api.get(
            `/v3/users/${config.username}/devices/${deviceId}/properties`,
        );

        return response.data;
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
 * Get device property value
 * @param {string} deviceId - Device ID to query
 * @param {string} propertyId - Property ID to retrieve
 * @returns {Promise<Object>} Property value
 */
export async function getDeviceProperty(deviceId, propertyId) {
    // Get configuration
    const config = readConfig();

    if (!config.token || !config.server || !config.username) {
        throw new Error('Not configured. Run thinr without parameters to set up.');
    }

    try {
        // Fetch property value
        const response = await api.get(
            `/v3/users/${config.username}/devices/${deviceId}/properties/${propertyId}`
        );

        return response.data.value;
    } catch (error) {
        console.log(error);
        if (error.response) {
            // The request was made and the server responded with a status code
            if (error.response.status === 404) {
                throw new Error(`Property not found: ${propertyId} on device ${deviceId}`);
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
 * Format device properties for display
 * @param {string} deviceId - Device ID
 * @param {Object} properties - Properties object from API
 * @returns {string} Formatted properties
 */
export function formatDeviceProperties(deviceId, properties) {

    let formattedProperties = '\nProperties of device ' + chalk.cyan(deviceId) + ':\n';

    properties.forEach(property => {
        formattedProperties += `- ${property.property}\n`;
    })

    return formattedProperties;
}

/**
 * Format device property value for display
 * @param {string} deviceId - Device ID
 * @param {string} propertyId - Property ID
 * @param {Object} propertyValue - Property value from API
 * @returns {string} Formatted property value
 */
export function formatDeviceProperty(deviceId, propertyId, propertyValue) {
    // show json with flattened structure
    let formattedValue = '\nValue of property ' + chalk.cyan(propertyId) + ' for device ' + chalk.cyan(deviceId) + ':\n';
    const flattenedValue = flatten(propertyValue);
    for (const key in flattenedValue) {
        formattedValue += `${key}: ${chalk.green(flattenedValue[key])}\n`;
    }
    return formattedValue;
}

function flatten(obj, prefix = '', res = {}) {
    for (const key in obj) {
        const val = obj[key];
        const path = prefix ? `${prefix}.${key}` : key;
        if (typeof val === 'object' && val !== null) {
            flatten(val, path, res);
        } else {
            res[path] = val;
        }
    }
    return res;
}


