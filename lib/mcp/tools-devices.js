// @ts-check
import { getDevices, getDevice } from '../devices.js';
import { setDeviceProduct } from '../product.js';
import { inputError } from '../errors.js';
import { getAPI } from './helpers.js';

async function toolDevices(args) {
    const query = args.query ? String(args.query).trim() : '';
    const filter = query ? { name: query } : {};
    const devices = await getDevices(filter, args.user);

    const renderLine = (d) => {
        const status = d.connection?.active ? 'online ' : 'offline';
        const label = d.name ? ` (${d.name})` : '';
        const product = d.type && d.type !== 'Generic' ? ` [${d.type}]` : '';
        return `${status}  ${d.device}${label}${product}`;
    };

    if (!query) {
        return {
            content: [
                { type: 'text', text: devices.map(renderLine).join('\n') || 'No devices found' },
            ],
            isError: false,
        };
    }

    const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 20;
    const limited = devices.slice(0, limit);
    const header =
        devices.length === 0
            ? `No devices match "${query}"`
            : `${devices.length} match(es) for "${query}"${devices.length > limit ? ` — showing first ${limit}` : ''}:`;
    return {
        content: [{ type: 'text', text: [header, ...limited.map(renderLine)].join('\n') }],
        isError: false,
    };
}

async function toolDeviceInfo(args) {
    const { api: deviceApi } = getAPI(args.device, args.user);
    const parts = [];

    // Server-side record first — surfaces the assigned product,
    // asset group, description, etc. that the device's own agent
    // can't see. Best effort: don't fail the whole tool if the
    // record can't be read.
    try {
        const record = await getDevice(args.device, args.user);
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
                `Memory: ${mon.memory.usage?.toFixed(1)}% (${(mon.memory.total / 1073741824).toFixed(1)}GB total)`,
            );
        if (mon.disk?.root)
            parts.push(
                `Disk: ${mon.disk.root.usage?.toFixed(1)}% (${(mon.disk.root.total / 1073741824).toFixed(0)}GB total)`,
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

async function toolDeviceSetProduct(args) {
    const device = args.device;
    if (!device) throw inputError('device is required');
    if (args.product === undefined || args.product === null)
        throw inputError('product is required (pass "" to unassign)');
    await setDeviceProduct(device, args.product, args.user);
    const label =
        args.product === ''
            ? `Unassigned ${device} from its product.`
            : `Assigned ${device} → product "${args.product}".`;
    return { content: [{ type: 'text', text: label }], isError: false };
}

export const tools = [
    {
        name: 'thinr_devices',
        description:
            'List remote devices with their online/offline status. Pass `query` to filter by device id or name (case-insensitive regex on the server side, so plain substrings, anchors, wildcards and alternations all work). Use this before any other device tool to discover or narrow down ids.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description:
                        'Optional pattern matched against device id and name. Plain substrings work ("office"); regex metacharacters are also honoured ("^raspberry", "mac|book"). Case-insensitive.',
                },
                limit: {
                    type: 'number',
                    description:
                        'Maximum matches to return when `query` is set (default: 20). Ignored when listing without a query.',
                },
                user: {
                    type: 'string',
                    description:
                        'API user (for admin impersonation). Omit to use your own account.',
                },
            },
            required: [],
        },
        handler: toolDevices,
    },
    {
        name: 'thinr_device_info',
        description:
            'Get device information: hostname, OS, architecture, filesystem base path, and system resources.',
        inputSchema: {
            type: 'object',
            properties: {
                device: { type: 'string', description: 'Device ID' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['device'],
        },
        handler: toolDeviceInfo,
    },
    {
        name: 'thinr_device_set_product',
        description:
            "Assign a device to a product, or unassign it by passing an empty string. Devices inherit the product's API resources and profile configuration (scripts, buckets, etc.) once assigned. Typical flow: create product scripts with thinr_product_script_write, then set a device's product here so it can invoke those scripts.",
        inputSchema: {
            type: 'object',
            properties: {
                device: { type: 'string', description: 'Device ID' },
                product: {
                    type: 'string',
                    description: 'Product ID to assign, or empty string "" to unassign.',
                },
                user: { type: 'string', description: 'API user' },
            },
            required: ['device', 'product'],
        },
        handler: toolDeviceSetProduct,
    },
];
