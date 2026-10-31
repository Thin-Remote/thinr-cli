// @ts-check
import { createDeviceAPI } from '../device-api.js';
import { inputError } from '@thinger-io/cli-core/errors';
import { opRef } from '@thinger-io/cli-core/mcp/naming';

/** Build a device-scoped API client. Tools must always pass `device`
 *  explicitly — the server has no per-session default. */
export function getAPI(device, user) {
    if (!device)
        throw inputError(
            `device is required. Use ${opRef('device', 'list')} to list available devices.`,
        );
    return { api: createDeviceAPI(device, { user: user || undefined }), device };
}
