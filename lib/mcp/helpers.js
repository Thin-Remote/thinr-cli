// @ts-check
import { createDeviceAPI } from '../device-api.js';
import { getActiveProfile, getProfile, setActiveProfile } from '../config.js';
import { setBaseURL } from '../api.js';
import { inputError } from '../errors.js';

/** Build a device-scoped API client. Tools must always pass `device`
 *  explicitly — the server has no per-session default. */
export function getAPI(device, user) {
    if (!device)
        throw inputError('device is required. Use thinr_devices to list available devices.');
    return { api: createDeviceAPI(device, { user: user || undefined }), device };
}

/** Run `fn` with the active profile temporarily switched to `profile`
 *  (when supplied) so callers can target any configured environment per
 *  tool call without persisting the change. */
export async function withProfile(profile, fn) {
    if (!profile) return fn();
    const previous = getActiveProfile();
    const target = getProfile(profile);
    if (!target) {
        throw inputError(`Unknown profile: ${profile}. Use thinr_profiles to list available ones.`);
    }
    setActiveProfile(profile);
    if (target.server) setBaseURL(`https://${target.server}`);
    try {
        return await fn();
    } finally {
        setActiveProfile(previous);
        const restore = previous ? getProfile(previous) : null;
        if (restore?.server) setBaseURL(`https://${restore.server}`);
    }
}
