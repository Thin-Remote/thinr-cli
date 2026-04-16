/**
 * Normalize an axios / fetch-style error into a single Error with a stable
 * `.code` and `.status`. Replaces the repeated if-response/if-request
 * blocks in status.js / property.js / resource.js / device.js.
 *
 * Pass `messages.notFound` to override the 404 message with something
 * that names the missing entity (e.g. "Device not found: abc").
 */
export function apiError(error, messages = {}) {
    if (error && error.response) {
        const status = error.response.status;
        if (status === 404) {
            const err = new Error(messages.notFound || 'Not found');
            err.code = 'not_found';
            err.status = 404;
            return err;
        }
        if (status === 401 || status === 403) {
            const err = new Error(messages.unauthorized || 'Unauthorized. Your token may have expired. Please reconfigure.');
            err.code = 'unauthorized';
            err.status = status;
            return err;
        }
        const err = new Error(`Server error: ${status} ${error.response.statusText || ''}`.trim());
        err.code = 'server_error';
        err.status = status;
        return err;
    }
    if (error && error.request) {
        const err = new Error('No response from server. Please check your connection.');
        err.code = 'network_error';
        return err;
    }
    const err = new Error(error?.message || String(error));
    err.code = 'error';
    return err;
}
