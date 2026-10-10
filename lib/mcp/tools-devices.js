// @ts-check
import { getDevice } from '@thinger-io/cli-core/devices';
import { BYTES } from '../constants.js';
import { getAPI } from './helpers.js';

async function toolDeviceInfo(args) {
    const { api: deviceApi } = getAPI(args.device_id, args.user);
    const parts = [];

    // Server-side record first — surfaces the assigned product,
    // asset group, description, etc. that the device's own agent
    // can't see. Best effort: don't fail the whole tool if the
    // record can't be read.
    try {
        const record = await getDevice(args.device_id, args.user);
        const meta = [];
        if (record.device) meta.push(`device:        ${record.device}`);
        if (record.name) meta.push(`name:          ${record.name}`);
        if (record.product) meta.push(`product:       ${record.product}`);
        if (record.asset_group) meta.push(`asset_group:   ${record.asset_group}`);
        if (record.description) meta.push(`description:   ${record.description}`);
        if (record.connection) {
            const c = record.connection;
            meta.push(
                `connection:    ${c.active ? 'online' : 'offline'}${c.ip_address ? ` from ${c.ip_address}` : ''}`,
            );
        }
        if (meta.length) {
            parts.push('--- Server record ---');
            parts.push(...meta);
            parts.push('');
        }
    } catch {}

    try {
        const sysInfo = await deviceApi.getResource('system_info');
        parts.push('--- System info ---');
        parts.push(JSON.stringify(sysInfo, null, 2));
    } catch {
        const info = await deviceApi.exec(
            'echo "hostname=$(hostname);os=$(uname -s);arch=$(uname -m);kernel=$(uname -r);user=$(whoami);home=$HOME;uptime=$(uptime -p 2>/dev/null || uptime)"',
            10,
        );
        parts.push(info.stdout || '');
    }

    try {
        const mon = await deviceApi.getResource('monitoring');
        parts.push('\n--- Real-time monitoring ---');
        if (mon.cpu)
            parts.push(
                `CPU: ${mon.cpu.usage?.toFixed(1)}% (${mon.cpu.cores} cores, ${mon.cpu.temperature?.toFixed(1)}°C)`,
            );
        if (mon.memory)
            parts.push(
                `Memory: ${mon.memory.usage?.toFixed(1)}% (${(mon.memory.total / BYTES.GB).toFixed(1)}GB total)`,
            );
        if (mon.disk?.root)
            parts.push(
                `Disk: ${mon.disk.root.usage?.toFixed(1)}% (${(mon.disk.root.total / BYTES.GB).toFixed(0)}GB total)`,
            );
        if (mon.network)
            parts.push(
                `Network: rx=${(mon.network.rx_rate / 1024).toFixed(1)}KB/s tx=${(mon.network.tx_rate / 1024).toFixed(1)}KB/s`,
            );
        if (mon.load)
            parts.push(
                `Load: ${mon.load['1m']?.toFixed(2)} / ${mon.load['5m']?.toFixed(2)} / ${mon.load['15m']?.toFixed(2)}`,
            );
        if (mon.uptime)
            parts.push(
                `Uptime: ${Math.floor(mon.uptime / 86400)}d ${Math.floor((mon.uptime % 86400) / 3600)}h`,
            );
    } catch {}

    try {
        const rootInfo = await deviceApi.info('/');
        parts.push(`\nfs_base_path=${rootInfo.path || '/'}`);
    } catch {}

    return {
        content: [{ type: 'text', text: parts.join('\n') }],
        isError: false,
    };
}

export const tools = [
    {
        // Asks the agent itself (system info, live metrics, filesystem
        // root) on top of the server record the generic tool shows.
        name: 'device_info',
        replaces: true,
        description:
            'Get device information: hostname, OS, architecture, filesystem base path, and system resources.',
        inputSchema: {
            type: 'object',
            properties: {
                device_id: { type: 'string', description: 'Device ID' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['device_id'],
        },
        handler: toolDeviceInfo,
    },
];
