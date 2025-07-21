import chalk from 'chalk';
import { readConfig } from './config.js';
import api from './api.js';

/**
 * Get devices belonging to a product
 * @param {Object} filter - Filters to query devices
 * @return {Promise<Array>} List of devices
 */
export async function getDevices(filter) {
    // Get configuration
    const config = readConfig();

    if (!config.token || !config.server || !config.username) {
        throw new Error('Not configured. Run thinr without parameters to set up.');
    }

    let devices = [];

    // Query parameters to string
    let queryParametersString = "";
    for (const [key, value] of Object.entries(filter)) {
        if ( value ) queryParametersString += key+"="+value+"&";
    }

    try {
        const count = 50;
        let url = `/v1/users/${config.username}/devices?count=${count}&${queryParametersString}`;

        let index = 0;
        let res_length = 0;

        do {
            // Fetch devices for the product
            const response = await api.get(
                `${url}index=${index}`,
            );

            res_length = response.data.length;
            index += res_length;
            devices = devices.concat(response.data);

        } while ( res_length === count );

        return devices;

    } catch (error) {
        if (error.response) {
            // The request was made and the server responded with a status code
            if (error.response.status === 404) {
                throw new Error(`Product not found: ${productId}`);
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
 * Filter active devices from a list of devices
 * @param {Array} devices - List of devices to filter
 * @return {Array} List of active devices
 */
export function filterActiveDevices(devices) {
    return devices.filter(device => device.connection && device.connection.active === true);
}

