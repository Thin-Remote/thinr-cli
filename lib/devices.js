import { requireConfig } from './config.js';
import api from './api.js';
import { apiError } from './errors.js';

/**
 * Get devices belonging to a product
 * @param {Object} filter - Filters to query devices
 * @return {Promise<Array>} List of devices
 */
export async function getDevices(filter, user = null) {
    const config = requireConfig();
    const apiUser = user || config.username;
    let devices = [];

    let queryParametersString = '';
    for (const [key, value] of Object.entries(filter)) {
        if (value) queryParametersString += key + '=' + value + '&';
    }

    try {
        const count = 50;
        const url = `/v1/users/${apiUser}/devices?count=${count}&${queryParametersString}`;
        let index = 0;
        let res_length = 0;

        do {
            const response = await api.get(`${url}index=${index}`);
            res_length = response.data.length;
            index += res_length;
            devices = devices.concat(response.data);
        } while (res_length === count);

        return devices;
    } catch (error) {
        const product = filter && filter.productId;
        const notFound = product ? `Product not found: ${product}` : 'Devices not found';
        throw apiError(error, { notFound });
    }
}

/**
 * Fetch a single device record (metadata only — assigned product,
 * description, asset group, connection state, …). Use this when you
 * need the side-channel info that doesn't come from the device's own
 * agent (system_info, monitoring, …) but from the server's record.
 *
 * @param {string} deviceId
 * @param {string} [user]  Admin impersonation; defaults to the active profile.
 * @returns {Promise<Object>} Raw API record.
 */
export async function getDevice(deviceId, user = null) {
    const config = requireConfig();
    const apiUser = user || config.username;
    try {
        const response = await api.get(`/v1/users/${apiUser}/devices/${deviceId}`);
        return response.data || {};
    } catch (error) {
        throw apiError(error, { notFound: `Device not found: ${deviceId}` });
    }
}

/**
 * Filter active devices from a list of devices
 * @param {Array} devices - List of devices to filter
 * @return {Array} List of active devices
 */
export function filterActiveDevices(devices) {
    return devices.filter((device) => device.connection && device.connection.active === true);
}
