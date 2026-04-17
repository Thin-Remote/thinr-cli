import { requireConfig } from './config.js';
import api from './api.js';
import { apiError } from './errors.js';
import { info, success } from './format.js';

/**
 * Get device properties
 * @param {string} deviceId - Device ID to query
 * @returns {Promise<Object>} Device properties
 */
export async function getDeviceProperties(deviceId) {
    const config = requireConfig();

    try {
        const response = await api.get(
            `/v3/users/${config.username}/devices/${deviceId}/properties`,
        );
        return response.data;
    } catch (error) {
        throw apiError(error, { notFound: `Device not found: ${deviceId}` });
    }
}

/**
 * Get device property value
 * @param {string} deviceId - Device ID to query
 * @param {string} propertyId - Property ID to retrieve
 * @returns {Promise<Object>} Property value
 */
export async function getDeviceProperty(deviceId, propertyId) {
    const config = requireConfig();

    try {
        const response = await api.get(
            `/v3/users/${config.username}/devices/${deviceId}/properties/${propertyId}`,
        );
        return response.data.value;
    } catch (error) {
        throw apiError(error, {
            notFound: `Property not found: ${propertyId} on device ${deviceId}`,
        });
    }
}

/**
 * Create or update a property value on a device. Uses PUT so the
 * operation is idempotent — missing properties are created, existing
 * ones are overwritten wholesale.
 *
 * @param {string} deviceId
 * @param {string} propertyId
 * @param {*} value  JSON-serialisable value to store.
 * @returns {Promise<Object>} The server's persisted record.
 */
export async function setDeviceProperty(deviceId, propertyId, value) {
    const config = requireConfig();

    try {
        const response = await api.put(
            `/v3/users/${config.username}/devices/${deviceId}/properties/${propertyId}`,
            { value },
        );
        return response.data;
    } catch (error) {
        throw apiError(error, { notFound: `Device not found: ${deviceId}` });
    }
}

/**
 * Format device properties for display
 * @param {string} deviceId - Device ID
 * @param {Object} properties - Properties object from API
 * @returns {string} Formatted properties
 */
export function formatDeviceProperties(deviceId, properties) {
    let formattedProperties = '\nProperties of device ' + info(deviceId) + ':\n';

    properties.forEach((property) => {
        formattedProperties += `- ${property.property}\n`;
    });

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
    let formattedValue =
        '\nValue of property ' +
        info(propertyId) +
        ' for device ' +
        info(deviceId) +
        ':\n';
    const flattenedValue = flatten(propertyValue);
    for (const key in flattenedValue) {
        formattedValue += `${key}: ${success(flattenedValue[key])}\n`;
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
