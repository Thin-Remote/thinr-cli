import { Buffer } from 'node:buffer';
import { input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import open, { apps } from 'open';
import { writeConfig, readConfig, mergeConfig } from './config.js';

import api, { setBaseURL } from './api.js';



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
        ]
    });

    // Ask for server URL
    const server = await input({
        message: 'Enter server URL:',
        default: 'console.thinr.io',
        validate: (input) => {
            return input ? true : 'Server URL is required';
        }
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
    try {
        // Ask for credentials
        const username = await input({
            message: 'Enter username:',
            validate: (input) => {
                return input ? true : 'Username is required';
            }
        });
        const password = await input({
            message: 'Enter password:',
            type: 'password',
            mask: '*',
            validate: (input) => {
                return input ? true : 'Password is required';
            }
        });

        // Show spinner
        const spinner = ora('Authenticating...').start();

        try {
            // Prepare OAuth2 password grant form data
            const formData = new URLSearchParams();
            formData.append('grant_type', 'password');
            formData.append('username', username);
            formData.append('password', password);

            // Authenticate with server using OAuth2 password flow
            const response = await api.post(
                `/oauth/token`,
                formData,
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            // Update spinner message
            spinner.text = 'Preparing user token...';

            // Delete existing token if it exists
            try {
                await api.delete(
                    `/v1/users/${username}/tokens/ThinRemote`,
                );
            } catch (error) {
                // Ignore 404 errors (token doesn't exist)
                if (error.response && error.response.status !== 404) {
                    throw error;
                }
            }

            // Create new token
            spinner.text = 'Creating new user token...';
            const createTokenResponse = await api.post(
                `/v1/users/${username}/tokens`,
                {
                    "enabled": true,
                    "allow": {"*": {"*": "*"}},
                    "deny": {},
                    "token": "ThinRemote",
                    "name": "ThinRemote",
                    "description": ""
                },
                {
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );
            const permanentToken = createTokenResponse.data.access_token;

            // Save configuration with permanent token
            writeConfig({
                username,
                server,
                token: permanentToken
            });

            spinner.succeed('Authentication successful');
        } catch (error) {
            spinner.fail('Authentication failed');

            if (error.response && error.response.status === 401) {
                console.error(chalk.red('Invalid username or password'));
            } else if (error.response && error.response.status === 404) {
                console.error(chalk.red('Authentication endpoint not found. Please check the server URL.'));
            } else {
                console.error(chalk.red(`Error: ${error.message}`));
            }

            process.exit(1);
        }
    } catch (error) {
        console.error(chalk.red(`Error: ${error.message}`));
        process.exit(1);
    }
}

export async function refreshToken() {
    try {
        const config = readConfig();
        if (!config || !config.username || !config.server || !config.refresh_token) {
            console.log(chalk.yellow('No configuration found'));
            return;
        }

        //const spinner = ora('Refreshing user token...').start();

        try {
            // Prepare OAuth2 refresh token form data
            const formData = new URLSearchParams();
            formData.append('grant_type', 'refresh_token');
            formData.append('client_id', '3b40164d28730e416cbd');
            formData.append('refresh_token', config.refresh_token);

            // Refresh token using OAuth2 refresh flow
            const response = await api.post(
                `/oauth/token`,
                formData,
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            // Save new token in configuration
            mergeConfig({
                token: response.data.access_token,
                refresh_token: response.data.refresh_token
            });

            //spinner.succeed('Token refreshed successfully');
            return response.data.access_token;

        } catch (error) {
            //spinner.fail('Failed to refresh token');
            console.error(chalk.red(`Error: ${error.message}`));
        }
    } catch (error) {
        console.error(chalk.red(`Error: ${error.message}`));
    }
}

/**
 * Delete user token from server
 * @returns {Promise<void>}
 */
export async function deleteToken() {
    try {
        const config = readConfig();
        if (!config || !config.username || !config.server || !config.token) {
            console.log(chalk.yellow('No configuration found'));
            return;
        }

        const spinner = ora('Deleting user token...').start();

        try {
            await api.delete(
                `/v1/users/${config.username}/tokens/ThinRemote`,
            );
            spinner.succeed('Token deleted successfully');
        } catch (error) {
            if (error.response && error.response.status === 404) {
                spinner.succeed('Token was already deleted');
            } else {
                spinner.fail('Failed to delete token');
                console.error(chalk.red(`Error: ${error.message}`));
            }
        }
    } catch (error) {
        console.error(chalk.red(`Error: ${error.message}`));
    }
}

/**
 * Authenticate with token
 * @returns {Promise<void>}
 */
async function authenticateWithToken() {
    try {
        // Ask for username and token
        const username = await input({
            message: 'Enter username:',
            validate: (input) => {
                return input ? true : 'Username is required';
            }
        });
        const token = await input({
            message: 'Enter token:',
            type: 'password',
            mask: '*',
            validate: (input) => {
                return input ? true : 'Token is required';
            }
        });

        // Show spinner
        const spinner = ora('Validating token...').start();

        try {
            // Validate token by making a request to the proxies API
            await api.get(
                `/v1/proxies`,
            );

            // Save configuration
            mergeConfig({
                username,
                token
            });

            spinner.succeed('Token validation successful');
        } catch (error) {
            spinner.fail('Token validation failed');

            if (error.response && error.response.status === 401) {
                console.error(chalk.red('Invalid token'));
            } else {
                console.error(chalk.red(`Error: ${error.message}`));
            }

            process.exit(1);
        }
    } catch (error) {
        console.error(chalk.red(`Error: ${error.message}`));
        process.exit(1);
    }
}

/**
 * Authenticate with OAuth token
 * @returns {Promise<void>}
 */
async function authenticateWithOAuth() {

    const client_id = '3b40164d28730e416cbd';
    let device_code = '';
    let oauth_tokens = {};

    try {

        // Show spinner
        const spinner = ora('Requesting OAuth User Code...').start();

        try {
            // Validate OAuth token by making a request to the proxies API
            const { data } = await api.post(
                `/oauth/device/authorize`,
                {
                    client_id: client_id
                },
                {
                    headers: {
                        'content-type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            spinner.succeed('OAuth User Code received');

            console.log('\nYour one time device code is: ' + chalk.bold(data.user_code));

            console.log(chalk.blue('Press ' + chalk.bold('ENTER')) + ' to open your browser or submit your device code here: ' + data.verification_uri + '\n');

            device_code = data.device_code;

            let validated = false;
            let pollDeviceIntervalId;
            let interval = 5000; // Default polling interval
            const controller = new AbortController();

            function setPollingInterval(interval) {
                if (pollDeviceIntervalId) {
                    clearInterval(pollDeviceIntervalId);
                }
                pollDeviceIntervalId = setInterval(pollDevice, interval);
            }

            async function pollDevice () {
                api.post(
                    `/oauth/token`,
                    {
                        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                        client_id: client_id,
                        device_code: device_code
                    },
                     {
                        headers: {
                            'content-type': 'application/x-www-form-urlencoded'
                        }
                    }
                )
                .then((response) => {
                    if (response.status === 200) {
                        console.log(response);
                        validated = true;
                        oauth_tokens = response.data;
                        controller.abort("validated");
                    }
                }).catch((e) => {
                    if (e.status === 400) {
                        // Check for specific OAuth error messages
                        if ( e.response.data.error === 'authorization_pending' ) {
                            //console.debug("Authorization pending, continuing to poll...");
                        } else if ( e.response.data.error === 'slow_down' ) {
                            //console.debug("Received slow_down, increasing polling interval");
                            // Increase polling interval to avoid hitting rate limits
                            clearInterval(pollDeviceIntervalId);
                            interval = 5000+1000;
                            setPollingInterval(interval); // Increase to 10 seconds
                        } else if ( e.response.data.error === 'access_denied' ) {
                            console.error(chalk.red('User denied the authorization request'));
                            process.exit(1);
                        } else if ( e.response.data.error === 'expired_token' ) {
                            console.error(chalk.red('Device code expired'));
                            process.exit(1);
                        } else {
                           console.error(chalk.red(`OAuth error: ${e.response.data.error}`));
                        }
                    }
                });

            }

            // Poll every 5 seconds
            setPollingInterval(interval);
            //pollDeviceIntervalId = setInterval(pollDevice, 5000, client_id, data.device_code);

            // Timeout after 10 minutes
            setTimeout(() => {
                clearInterval(pollDeviceIntervalId)
                controller.abort("timeout");
            }, 600000);


            // Wait for validation
            await input({
                message: 'Press ENTER to continue or wait for authentication...',
                waitUserInput: true,
                validate: function (input) {
                    open(data.verification_uri_complete, {app: [{name: apps.browser}, 'firefox-developer-edition']});
                    return '';
                },
            },
            {
                    signal: controller.signal
            }).catch((error) => {
                if (error.cause === 'timeout') {
                    console.log(chalk.yellow('Polling aborted due to timeout'));
                    // Polling was aborted
                } else if (error.cause === 'validated') {
                    console.log(chalk.green('Device authenticated successfully'));
                }
            });

            clearInterval(pollDeviceIntervalId);

            const token = oauth_tokens.access_token;
            const refresh_token = oauth_tokens.refresh_token;
            const decodedJWT = JSON.parse(Buffer.from(oauth_tokens.access_token.split('.')[1], 'base64').toString());
            const username = decodedJWT.usr;

            // Save configuration
            mergeConfig({
                username,
                token,
                refresh_token,
            });

            spinner.succeed('OAuth token validation successful\n');
        } catch (error) {
            spinner.fail('OAuth token validation failed');

            if (error.response && error.response.status === 401) {
                console.error(chalk.red('Invalid OAuth token'));
            } else {
                console.error(chalk.red(`Error: ${error.message}`));
            }

            process.exit(1);
        }

    } catch (error) {
        console.error(chalk.red(`Error: ${error.message}`));
        process.exit(1);
    }

}

/**
 * Get access token from configuration
 * @returns {string|axios.CancelToken|*|null}
 */
export function getAccessToken() {
    const config = readConfig();
    if (!config || !config.token) {
        console.log(chalk.yellow('No token found in configuration'));
        return null;
    }
    return config.token;
}
