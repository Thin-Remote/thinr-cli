import chalk from 'chalk';
import { readConfig } from './config.js';
import api from './api.js';
import { apiError } from './errors.js';

/**
 * Get devices belonging to a product
 * @param {Object} filter - Filters to query devices
 * @return {Promise<Array>} List of devices
 */
export async function getDevices(filter) {
    const config = readConfig();

    if (!config.token || !config.server || !config.username) {
        throw new Error('Not configured. Run thinr without parameters to set up.');
    }

    let devices = [];

    let queryParametersString = "";
    for (const [key, value] of Object.entries(filter)) {
        if (value) queryParametersString += key + "=" + value + "&";
    }

    try {
        const count = 50;
        const url = `/v1/users/${config.username}/devices?count=${count}&${queryParametersString}`;
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
 * Filter active devices from a list of devices
 * @param {Array} devices - List of devices to filter
 * @return {Array} List of active devices
 */
export function filterActiveDevices(devices) {
    return devices.filter(device => device.connection && device.connection.active === true);
}

