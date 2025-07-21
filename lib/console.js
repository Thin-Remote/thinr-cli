import WebSocket from 'ws';
import chalk from 'chalk';
import { readConfig } from './config.js';
import api from './api.js';

/**
 * Creates a WebSocket connection to a device terminal
 * @param {string} deviceId - The ID of the device to connect to
 */
export async function connectToDeviceConsole(deviceId) {
    // Get configuration
    const config = readConfig();

    if (!config.token || !config.server || !config.username) {
        console.error(chalk.red('Error: Not configured. Run thinr without parameters to set up.'));
        process.exit(1);
    }

    // Create a unique session ID
    const sessionId = createUUID();

    // Create WebSocket URL
    const wsUrl = `wss://${config.server}/v3/users/${config.username}/devices/${deviceId}/resources/$terminal/${sessionId}?raw=1`;

    //console.log(chalk.blue(`Connecting to ${deviceId}...`));

    // Create WebSocket connection
    const ws = new WebSocket(wsUrl, {
        headers: {
            'Authorization': `Bearer ${config.token}`
        }
    });

    // Flag to track if terminal settings have been restored
    let terminalRestored = false;

    // Setup raw mode for process.stdin
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    // Function to restore terminal settings
    const restoreTerminal = () => {
        if (!terminalRestored) {
            // Restore terminal settings
            process.stdin.setRawMode(false);
            process.stdin.pause();
            terminalRestored = true;
        }
    };

    // Handle WebSocket connection
    ws.on('open', () => {
        //console.log(chalk.green(`Connected to ${deviceId}`));

        // Set initial terminal size
        updateTerminalSize(config, deviceId, sessionId, process.stdout.columns, process.stdout.rows);

        // Handle window resize
        process.stdout.on('resize', () => {
            updateTerminalSize(config, deviceId, sessionId, process.stdout.columns, process.stdout.rows);
        });

        // Forward stdin to WebSocket
        process.stdin.on('data', (data) => {
            // Check for Ctrl+D (EOT character, ASCII 4) to exit gracefully
            if (data.toString() === '\u0004') {
                ws.close();
                return;
            }

            // Forward any other input (including Ctrl+C) to the remote device
            ws.send(data);
        });

        // Forward WebSocket data to stdout
        ws.on('message', (data) => {
            // Ensure we're writing Buffer data to avoid encoding issues
            if (!(data instanceof Buffer)) {
                data = Buffer.from(data);
            }

            process.stdout.write(data);
        });
    });

    // Handle WebSocket close
    ws.on('close', () => {
        console.log(chalk.yellow('\nConnection closed'));
        restoreTerminal();

        // Small delay before exiting to flush any remaining output
        setTimeout(() => {
            process.exit(0);
        }, 100);
    });

    // Handle WebSocket errors
    ws.on('error', (error) => {
        console.error(chalk.red(`\nWebSocket error: ${error.message}`));
        restoreTerminal();
        process.exit(1);
    });

    // Handle SIGINT (Ctrl+C) at process level
    process.on('SIGINT', () => {
        // Try to send Ctrl+C to the remote terminal
        if (ws.readyState === WebSocket.OPEN) {
            ws.send('\u0003');
        }

        // Don't exit our process - let the remote terminal handle it
        return false;
    });

    // Ensure cleanup on other exit signals
    process.on('SIGTERM', () => {
        restoreTerminal();
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
    });

    // Handle uncaught exceptions gracefully
    process.on('uncaughtException', (error) => {
        console.error(chalk.red(`\nUnexpected error: ${error.message}`));
        restoreTerminal();
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
        process.exit(1);
    });
}

/**
 * Update terminal size on remote device
 * @param {Object} config - Configuration object
 * @param {string} deviceId - Device ID
 * @param {string} sessionId - Session ID
 * @param {number} cols - Number of columns
 * @param {number} rows - Number of rows
 */
async function updateTerminalSize(config, deviceId, sessionId, cols, rows) {
    try {
        const url = `/v3/users/${config.username}/devices/${deviceId}/resources/$terminal/${sessionId}/params`;

        await api.post(
            url,
            {
                size: {
                    cols: cols,
                    rows: rows
                }
            },
        );
    } catch (error) {
        console.error(chalk.red(`Error updating terminal size: ${error.message}`));
    }
}

/**
 * Generate a UUID
 * @returns {string} UUID
 */
function createUUID() {
    let dt = new Date().getTime();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = (dt + Math.random() * 16) % 16 | 0;
        dt = Math.floor(dt / 16);
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}