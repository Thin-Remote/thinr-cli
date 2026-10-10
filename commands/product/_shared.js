// @ts-check
import { getDevices } from '@thinger-io/cli-core/devices';

export async function fetchProductDevices(productId, group, user) {
    const filter = { product: productId };
    if (group) filter.asset_group = group;
    return getDevices(filter, user);
}
