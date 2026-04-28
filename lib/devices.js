import { requireConfig } from './config.js';
import api from './api.js';
import { apiError } from './errors.js';

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
        const product = filter && filter.product;
        const notFound = product ? `Product not found: ${product}` : 'Devices not found';
        throw apiError(error, { notFound });
    }
}

// Server-side metadata (assigned product, description, asset group,
// connection state…). For device-side data — system_info, monitoring —
// hit the agent resources directly instead.
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

export function filterActiveDevices(devices) {
    return devices.filter((device) => device.connection && device.connection.active === true);
}
