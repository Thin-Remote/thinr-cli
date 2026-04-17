// @ts-check
import { getDevices } from '../../lib/devices.js';

export async function fetchProductDevices(productId, group, user) {
    const filter = { productId };
    if (group) filter.asset_group = group;
    return getDevices(filter, user);
}
