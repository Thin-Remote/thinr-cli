import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { writeConfig, readConfig } from './config.js';

/**
 * Authenticate user
 * @returns {Promise<void>}
 */
export async function authenticate() {
    // Ask for authentication method
    const { method } = await inquirer.prompt([
        {
            type: 'list',
            name: 'method',
            message: 'How would you like to authenticate?',
            choices: [
                { name: 'Username and password', value: 'userpass' },
                { name: 'Token', value: 'token' }
            ]
        }
    ]);

    if (method === 'userpass') {
        // Authenticate with username and password
        await authenticateWithUserPass();
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
        // Ask for server URL
        const { server } = await inquirer.prompt([
            {
                type: 'input',
                name: 'server',
                message: 'Enter server URL:',
                default: 'perf.aws.thinger.io',
                validate: (input) => {
                    return input ? true : 'Server URL is required';
                }
            }
        ]);

        // Ask for credentials
        const { username, password } = await inquirer.prompt([
            {
                type: 'input',
                name: 'username',
                message: 'Enter username:',
                validate: (input) => {
                    return input ? true : 'Username is required';
                }
            },
            {
                type: 'password',
                name: 'password',
                message: 'Enter password:',
                mask: '*',
                validate: (input) => {
                    return input ? true : 'Password is required';
                }
            }
        ]);

        // Show spinner
        const spinner = ora('Authenticating...').start();

        try {
            // Prepare OAuth2 password grant form data
            const formData = new URLSearchParams();
            formData.append('grant_type', 'password');
            formData.append('username', username);
            formData.append('password', password);

            // Authenticate with server using OAuth2 password flow
            const response = await axios.post(
                `https://${server}/oauth/token`,
                formData,
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            // Get temporary access token from OAuth2 response
            const accessToken = response.data.access_token;

            // Update spinner message
            spinner.text = 'Preparing user token...';

            // Delete existing token if it exists
            try {
                await axios.delete(
                    `https://${server}/v1/users/${username}/tokens/ThinRemote`,
                    {
                        headers: {
                            'Authorization': `Bearer ${accessToken}`
                        }
                    }
                );
            } catch (error) {
                // Ignore 404 errors (token doesn't exist)
                if (error.response && error.response.status !== 404) {
                    throw error;
                }
            }

            // Create new token
            spinner.text = 'Creating new user token...';
            const createTokenResponse = await axios.post(
                `https://${server}/v1/users/${username}/tokens`,
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
                        'Authorization': `Bearer ${accessToken}`,
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
            await axios.delete(
                `https://${config.server}/v1/users/${config.username}/tokens/ThinRemote`,
                {
                    headers: {
                        'Authorization': `Bearer ${config.token}`
                    }
                }
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
        // Ask for server URL and token
        const { server, token, username } = await inquirer.prompt([
            {
                type: 'input',
                name: 'server',
                message: 'Enter server URL:',
                default: 'perf.aws.thinger.io',
                validate: (input) => {
                    return input ? true : 'Server URL is required';
                }
            },
            {
                type: 'input',
                name: 'username',
                message: 'Enter username:',
                validate: (input) => {
                    return input ? true : 'Username is required';
                }
            },
            {
                type: 'password',
                name: 'token',
                message: 'Enter token:',
                mask: '*',
                validate: (input) => {
                    return input ? true : 'Token is required';
                }
            }
        ]);

        // Show spinner
        const spinner = ora('Validating token...').start();

        try {
            // Validate token by making a request to the proxies API
            await axios.get(
                `https://${server}/v1/proxies`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                }
            );

            // Save configuration
            writeConfig({
                username,
                server,
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