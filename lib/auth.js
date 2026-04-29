import { Buffer } from 'node:buffer';
import { input, select } from '@inquirer/prompts';
import ora from 'ora';
import open, { apps } from 'open';
import { writeConfig, readConfig, mergeConfig } from './config.js';
import { label, success, warning, error as errorStyle, info } from './format.js';

import api, { setBaseURL } from './api.js';
import { OAUTH, TIMEOUTS } from './constants.js';

const OAUTH_CLIENT_ID = OAUTH.CLIENT_ID;
const OAUTH_DEVICE_CODE_TIMEOUT_MS = TIMEOUTS.OAUTH_DEVICE_CODE_MS;

/**
 * Authenticate user
 * @returns {Promise<void>}
 */
export async function authenticate() {
    // Ask for authentication method
    const method = await select({
        message: 'How would you like to authenticate?',
        choices: [
            { name: 'OAuth', value: 'oauth' },
            { name: 'Token', value: 'token' },
            { name: 'Username and password', value: 'userpass' },
        ],
    });

    // Ask for server URL
    const server = await input({
        message: 'Enter server URL:',
        default: 'console.thinr.io',
        validate: (input) => {
            return input ? true : 'Server URL is required';
        },
    });

    setBaseURL(`https://${server}`);

    writeConfig({
        server,
    });

    if (method === 'userpass') {
        // Authenticate with username and password
        await authenticateWithUserPass();
    } else if (method === 'oauth') {
        await authenticateWithOAuth();
    } else {
        // Authenticate with token
        await authenticateWithToken();
    }
}

/**
 * Authenticate with username and password using OAuth2 password flow
 * @returns {Promise<void>}
 */
async function authenticateWithUserPass() {
    // Ask for credentials
    const username = await input({
        message: 'Enter username:',
        validate: (input) => (input ? true : 'Username is required'),
    });
    const password = await input({
        message: 'Enter password:',
        type: 'password',
        mask: '*',
        validate: (input) => (input ? true : 'Password is required'),
    });

    const spinner = ora('Authenticating...').start();

    try {
        // OAuth2 password grant
        const formData = new URLSearchParams();
        formData.append('grant_type', 'password');
        formData.append('username', username);
        formData.append('password', password);

        await api.post(`/oauth/token`, formData, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        // Replace any existing token with a fresh permanent one
        spinner.text = 'Preparing user token...';
        try {
            await api.delete(`/v1/users/${username}/tokens/ThinRemote`);
        } catch (error) {
            if (error.response && error.response.status !== 404) throw error;
        }

        spinner.text = 'Creating new user token...';
        const createTokenResponse = await api.post(
            `/v1/users/${username}/tokens`,
            {
                enabled: true,
                allow: { '*': { '*': '*' } },
                deny: {},
                token: 'ThinRemote',
                name: 'ThinRemote',
                description: '',
            },
            { headers: { 'Content-Type': 'application/json' } },
        );
        const permanentToken = createTokenResponse.data.access_token;

        // server was already persisted by the outer authenticate(); only
        // username + token need to be merged here.
        mergeConfig({ username, token: permanentToken });
        spinner.succeed('Authentication successful');
    } catch (error) {
        spinner.fail('Authentication failed');
        if (error.response && error.response.status === 401) {
            throw new Error('Invalid username or password', { cause: error });
        }
        if (error.response && error.response.status === 404) {
            throw new Error('Authentication endpoint not found. Please check the server URL.', {
                cause: error,
            });
        }
        throw error;
    }
}

/**
 * Exchange the saved refresh_token for a fresh access_token. Throws a
 * tagged `code: 'unauthorized'` Error when no refresh_token is on
 * record (e.g. logins made with username/password don't get one) or
 * when the OAuth server rejects the refresh — both cases mean the
 * caller has to re-authenticate.
 *
 * Concurrent callers share a single in-flight refresh: refresh tokens
 * are rotated on use, so issuing two refreshes in parallel makes the
 * second one fail against an already-consumed token. The shared
 * promise lets every awaiter see the same result and lets the next
 * caller (after completion) start a new refresh against the freshly
 * persisted token.
 *
 * @returns {Promise<string>} The new access token.
 */
let inFlightRefresh = null;

export async function refreshToken() {
    if (inFlightRefresh) return inFlightRefresh;
    inFlightRefresh = doRefresh().finally(() => {
        inFlightRefresh = null;
    });
    return inFlightRefresh;
}

async function doRefresh() {
    const config = readConfig();
    if (!config.refresh_token) {
        const err = new Error('No refresh token available; re-authenticate with `thinr`.');
        err.code = 'unauthorized';
        throw err;
    }

    const formData = new URLSearchParams();
    formData.append('grant_type', 'refresh_token');
    formData.append('client_id', OAUTH_CLIENT_ID);
    formData.append('refresh_token', config.refresh_token);

    let response;
    try {
        // `_isRefresh` flags this request so the response interceptor
        // skips its own refresh-on-401 logic — otherwise a refresh that
        // returned 401 would recurse back here forever.
        response = await api.post('/oauth/token', formData, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            _isRefresh: true,
        });
    } catch (_error) {
        const err = new Error('Token refresh failed; re-authenticate with `thinr`.');
        err.code = 'unauthorized';
        throw err;
    }

    mergeConfig({
        token: response.data.access_token,
        refresh_token: response.data.refresh_token,
    });
    return response.data.access_token;
}

/**
 * Delete user token from server
 * @returns {Promise<void>}
 */
export async function deleteToken() {
    try {
        const config = readConfig();
        if (!config || !config.username || !config.server || !config.token) {
            console.log(warning('No configuration found'));
            return;
        }

        const spinner = ora('Deleting user token...').start();

        try {
            await api.delete(`/v1/users/${config.username}/tokens/ThinRemote`);
            spinner.succeed('Token deleted successfully');
        } catch (error) {
            if (error.response && error.response.status === 404) {
                spinner.succeed('Token was already deleted');
            } else {
                spinner.fail('Failed to delete token');
                console.error(errorStyle(`Error: ${error.message}`));
            }
        }
    } catch (error) {
        console.error(errorStyle(`Error: ${error.message}`));
    }
}

/**
 * Authenticate with token
 * @returns {Promise<void>}
 */
async function authenticateWithToken() {
    const username = await input({
        message: 'Enter username:',
        validate: (input) => (input ? true : 'Username is required'),
    });
    const token = await input({
        message: 'Enter token:',
        type: 'password',
        mask: '*',
        validate: (input) => (input ? true : 'Token is required'),
    });

    const spinner = ora('Validating token...').start();
    try {
        // The api interceptor attaches Authorization from the saved
        // config; at this point we haven't persisted the token yet, so
        // the header has to be passed explicitly for the probe request.
        await api.get(`/v1/proxies`, {
            headers: { Authorization: `Bearer ${token}` },
        });
    } catch (error) {
        spinner.fail('Token validation failed');
        if (error.response && error.response.status === 401) {
            throw new Error('Invalid token', { cause: error });
        }
        throw error;
    }
    mergeConfig({ username, token });
    spinner.succeed('Token validation successful');
}

/**
 * Authenticate with OAuth token
 * @returns {Promise<void>}
 */
async function authenticateWithOAuth() {
    const client_id = OAUTH_CLIENT_ID;
    let oauth_tokens = {};

    const spinner = ora('Requesting OAuth User Code...').start();
    let data;
    try {
        ({ data } = await api.post(
            `/oauth/device/authorize`,
            { client_id },
            { headers: { 'content-type': 'application/x-www-form-urlencoded' } },
        ));
        spinner.succeed('OAuth User Code received');
    } catch (error) {
        spinner.fail('OAuth device-code request failed');
        throw error;
    }

    console.log('\nYour one time device code is: ' + label(data.user_code));
    console.log(
        info('Press ' + label('ENTER')) +
            ' to open your browser or submit your device code here: ' +
            data.verification_uri +
            '\n',
    );

    const device_code = data.device_code;
    let pollDeviceIntervalId;
    let interval = 5000;
    let pollError = null; // captured by polling, surfaced after the await
    const controller = new AbortController();

    function setPollingInterval(ms) {
        if (pollDeviceIntervalId) clearInterval(pollDeviceIntervalId);
        pollDeviceIntervalId = setInterval(pollDevice, ms);
    }

    async function pollDevice() {
        try {
            const response = await api.post(
                `/oauth/token`,
                {
                    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                    client_id,
                    device_code,
                },
                { headers: { 'content-type': 'application/x-www-form-urlencoded' } },
            );
            if (response.status === 200) {
                oauth_tokens = response.data;
                controller.abort('validated');
            }
        } catch (e) {
            if (e.response && e.response.status === 400) {
                const err = e.response.data && e.response.data.error;
                if (err === 'authorization_pending') return;
                if (err === 'slow_down') {
                    interval += 1000;
                    setPollingInterval(interval);
                    return;
                }
                if (err === 'access_denied') {
                    pollError = new Error('User denied the authorization request');
                    controller.abort('error');
                    return;
                }
                if (err === 'expired_token') {
                    pollError = new Error('Device code expired');
                    controller.abort('error');
                    return;
                }
                pollError = new Error(`OAuth error: ${err}`);
                controller.abort('error');
            }
        }
    }

    setPollingInterval(interval);

    // 10-minute hard ceiling on the user finishing in the browser
    const timeoutId = setTimeout(() => {
        clearInterval(pollDeviceIntervalId);
        controller.abort('timeout');
    }, OAUTH_DEVICE_CODE_TIMEOUT_MS);

    try {
        await input(
            {
                message: 'Press ENTER to continue or wait for authentication...',
                waitUserInput: true,
                validate: () => {
                    open(data.verification_uri_complete, {
                        app: [{ name: apps.browser }, 'firefox-developer-edition'],
                    });
                    return '';
                },
            },
            {
                signal: controller.signal,
            },
        ).catch((error) => {
            if (error.cause === 'timeout') {
                console.log(warning('Polling aborted due to timeout'));
            } else if (error.cause === 'validated') {
                console.log(success('Device authenticated successfully'));
            }
            // 'error' cause falls through; we surface pollError below.
        });
    } finally {
        clearInterval(pollDeviceIntervalId);
        clearTimeout(timeoutId);
    }

    if (pollError) throw pollError;
    if (!oauth_tokens.access_token) throw new Error('OAuth flow ended without a token');

    const token = oauth_tokens.access_token;
    const refresh_token = oauth_tokens.refresh_token;
    const decodedJWT = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    const username = decodedJWT.usr;

    mergeConfig({ username, token, refresh_token });
    console.log(success('OAuth token validation successful\n'));
}

/**
 * Get access token from configuration
 * @returns {string|axios.CancelToken|*|null}
 */
export function getAccessToken() {
    const config = readConfig();
    if (!config || !config.token) {
        console.log(warning('No token found in configuration'));
        return null;
    }
    return config.token;
}
