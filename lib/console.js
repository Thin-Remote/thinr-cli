import WebSocket from 'ws';
import chalk from 'chalk';
import { requireConfig } from './config.js';
import api from './api.js';

/**
 * Creates a WebSocket connection to a device terminal. Returns a
 * promise that resolves with `0` when the remote side closes
 * cleanly, and rejects with a tagged Error when the connection
 * fails (404 → not_found, 401/403 → unauthorized, anything else →
 * error). The CLI command wrapping this call decides what to do
 * with the resolved code or the thrown error — the helper itself
 * never calls process.exit.
 *
 * @param {string} deviceId - The ID of the device to connect to
 * @returns {Promise<number>} Exit code (0 on clean close)
 */
export async function connectToDeviceConsole(deviceId) {
    const config = requireConfig();

    const sessionId = createUUID();
    const wsUrl = `wss://${config.server}/v3/users/${config.username}/devices/${deviceId}/resources/$terminal/${sessionId}?raw=1`;
    const ws = new WebSocket(wsUrl, {
        headers: { 'Authorization': `Bearer ${config.token}` },
    });

    let terminalRestored = false;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const restoreTerminal = () => {
        if (!terminalRestored) {
            process.stdin.setRawMode(false);
            process.stdin.pause();
            terminalRestored = true;
        }
    };

    return new Promise((resolve, reject) => {
        ws.on('open', () => {
            updateTerminalSize(config, deviceId, sessionId, process.stdout.columns, process.stdout.rows);

            process.stdout.on('resize', () => {
                updateTerminalSize(config, deviceId, sessionId, process.stdout.columns, process.stdout.rows);
            });

            process.stdin.on('data', (data) => {
                // Ctrl+D (EOT) to exit gracefully
                if (data.toString() === '\u0004') {
                    ws.close();
                    return;
                }
                // Forward everything else (including Ctrl+C) to the device
                ws.send(data);
            });

            ws.on('message', (data) => {
                if (!(data instanceof Buffer)) data = Buffer.from(data);
                process.stdout.write(data);
            });
        });

        ws.on('close', () => {
            console.log(chalk.yellow('\nConnection closed'));
            restoreTerminal();
            // Small delay so any final output flushes before the caller exits.
            setTimeout(() => resolve(0), 100);
        });

        ws.on('error', (error) => {
            restoreTerminal();
            const m = /(\d{3})/.exec(error.message || '');
            const status = m ? parseInt(m[1], 10) : 0;
            let msg, code;
            if (status === 404) {
                msg = `Device "${deviceId}" not found or offline.`;
                code = 'not_found';
            } else if (status === 401 || status === 403) {
                msg = `Not authorized to access "${deviceId}". Check your token or user.`;
                code = 'unauthorized';
            } else {
                msg = `Connection error: ${error.message}`;
                code = 'error';
            }
            const err = new Error(msg);
            err.code = code;
            reject(err);
        });

        // Forward Ctrl+C to the remote terminal instead of killing ourselves.
        process.on('SIGINT', () => {
            if (ws.readyState === WebSocket.OPEN) ws.send('\u0003');
            return false;
        });

        // Cleanup on shutdown signals (no exit — the WS close will resolve us).
        process.on('SIGTERM', () => {
            restoreTerminal();
            if (ws.readyState === WebSocket.OPEN) ws.close();
        });
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