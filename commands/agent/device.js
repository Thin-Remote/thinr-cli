// @ts-check
import { createDeviceAPI } from '../../lib/device-api.js';
import {
    isJsonMode,
    printOk,
    printErr,
    createSpinner,
    classifyError,
} from '@thinger-io/cli-core/output';
import { label as labelText, accent } from '@thinger-io/cli-core/format';
import { TIMEOUTS } from '../../lib/constants.js';

/**
 * Ask the agent of one device to check for a release (`check`) or to
 * install it (`apply`), through its `update` resource.
 *
 * @param {'check' | 'apply'} action
 * @param {string} deviceId
 * @param {{ channel?: string }} opts
 * @param {string | null} user
 */
export async function runDeviceUpdate(action, deviceId, opts, user) {
    const channel = opts.channel || 'latest';
    const phase = action === 'check' ? 'Checking for updates' : 'Applying update';
    const spinner = createSpinner(`${phase} on ${deviceId}...`).start();
    try {
        const api = createDeviceAPI(deviceId, { user });
        const timeout =
            action === 'apply' ? TIMEOUTS.DEVICE_UPDATE_APPLY_MS : TIMEOUTS.DEVICE_RESOURCE_CALL_MS;
        const result = await api.callResource('update', { action, channel }, { timeout });
        spinner.succeed(`${phase} finished`);
        if (isJsonMode()) {
            printOk(result);
        } else if (result && typeof result === 'object') {
            if (result.current) console.log(`  current: ${labelText(result.current)}`);
            if (result.latest) console.log(`  latest:  ${labelText(result.latest)}`);
            if (result.arch) console.log(`  arch:    ${result.arch}`);
            if (result.status) console.log(`  status:  ${accent(result.status)}`);
            if (result.message) console.log(`  message: ${result.message}`);
        } else {
            console.log(result);
        }
    } catch (error) {
        spinner.fail(`${phase} failed`);
        const { message, code } = classifyError(error);
        printErr(message, { code });
    }
}
