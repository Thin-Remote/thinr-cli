import api from './api.js';
import { apiError } from './errors.js';
import { v1 } from './paths.js';

export async function getDevices(filter, user = null) {
    let devices = [];

    let queryParametersString = '';
    for (const [key, value] of Object.entries(filter)) {
        if (value) queryParametersString += key + '=' + value + '&';
    }

    try {
        const count = 50;
        const url = `${v1(user)}/devices?count=${count}&${queryParametersString}`;
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
    try {
        const response = await api.get(`${v1(user)}/devices/${deviceId}`);
        return response.data || {};
    } catch (error) {
        throw apiError(error, { notFound: `Device not found: ${deviceId}` });
    }
}

// Idempotent: returns true if the device record was removed, false if it
// was already absent. Other failures (auth, network) propagate as apiError.
export async function deleteDevice(deviceId, user = null) {
    try {
        await api.delete(`${v1(user)}/devices/${deviceId}`);
        return true;
    } catch (error) {
        if (error.response?.status === 404) return false;
        throw apiError(error);
    }
}

export function filterActiveDevices(devices) {
    return devices.filter((device) => device.connection && device.connection.active === true);
}
