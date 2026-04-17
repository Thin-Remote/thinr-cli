import chalk from 'chalk';
import { requireConfig } from './config.js';
import api from './api.js';
import { apiError } from './errors.js';
import { formatUptime, colorPct, formatBytes } from './format.js';

/**
 * Get device status
 * @param {string} deviceId - Device ID to check
 * @returns {Promise<Object>} Status information
 */
export async function getDeviceStatus(deviceId) {
    const config = requireConfig();

    try {
        const response = await api.get(`/v1/users/${config.username}/devices/${deviceId}/stats`);
        return response.data;
    } catch (error) {
        throw apiError(error, { notFound: `Device not found: ${deviceId}` });
    }
}

/**
 * Format device status data for display. When a `monitoring` payload
 * (one sample from the monitoring bucket) is supplied the output
 * includes a metrics section with CPU / memory / disk / load / uptime;
 * otherwise the section is omitted.
 *
 * @param {string} deviceId
 * @param {Object} status
 * @param {Object | null} [monitoring]
 * @returns {string}
 */
export function formatDeviceStatus(deviceId, status, monitoring = null) {
    const connectedStatus = status.connected ? chalk.green('● Online') : chalk.red('○ Offline');

    let connectedTime = '';
    if (status.connected && status.connected_ts) {
        const diffSeconds = Math.floor(
            (Date.now() - new Date(status.connected_ts).getTime()) / 1000,
        );
        connectedTime = `for ${formatUptime(diffSeconds)}`;
    }

    const lines = [''];
    lines.push(chalk.bold(`Device: ${deviceId}`));
    lines.push(`Status: ${connectedStatus} ${connectedTime}`);
    if (status.ip_address) lines.push(`IP:     ${status.ip_address}`);

    if (monitoring) {
        lines.push('');
        lines.push(chalk.bold('Metrics:'));

        if (monitoring.cpu?.usage != null) {
            const bits = [];
            if (monitoring.cpu.cores != null) bits.push(`${monitoring.cpu.cores} cores`);
            if (monitoring.cpu.temperature != null)
                bits.push(`${monitoring.cpu.temperature.toFixed(1)}°C`);
            const detail = bits.length ? chalk.dim(` (${bits.join(', ')})`) : '';
            lines.push(`  CPU:     ${colorPct(monitoring.cpu.usage)}${detail}`);
        }
        if (monitoring.memory?.usage != null) {
            const total = monitoring.memory.total;
            const avail = monitoring.memory.available;
            const used = total != null && avail != null ? total - avail : null;
            const detail =
                used != null && total != null
                    ? chalk.dim(` (${formatBytes(used)} of ${formatBytes(total)} used)`)
                    : '';
            lines.push(`  Memory:  ${colorPct(monitoring.memory.usage)}${detail}`);
        }
        if (monitoring.disk?.root?.usage != null) {
            const root = monitoring.disk.root;
            const detail =
                root.available != null && root.total != null
                    ? chalk.dim(
                          ` (${formatBytes(root.available)} free of ${formatBytes(root.total)})`,
                      )
                    : '';
            lines.push(`  Disk:    ${colorPct(root.usage)}${detail}`);
        }
        if (monitoring.load) {
            const l = monitoring.load;
            const parts = [l['1m'], l['5m'], l['15m']].map((v) =>
                v != null ? v.toFixed(2) : '—',
            );
            lines.push(`  Load:    ${parts.join(' · ')}`);
        }
        if (monitoring.uptime != null) {
            lines.push(`  Uptime:  ${formatUptime(monitoring.uptime)}`);
        }
        if (monitoring.agent?.version) {
            lines.push(`  Agent:   ${chalk.dim(monitoring.agent.version)}`);
        }
    }

    lines.push('');
    lines.push(chalk.bold('Data Transfer:'));
    lines.push(`  ↓ Received: ${formatBytes(status.rx_bytes || 0)}`);
    lines.push(`  ↑ Sent:     ${formatBytes(status.tx_bytes || 0)}`);
    lines.push('');

    return lines.join('\n');
}
