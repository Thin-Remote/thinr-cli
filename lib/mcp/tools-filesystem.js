// @ts-check
import { getAPI } from './helpers.js';

async function toolRead(args) {
    const { api } = getAPI(args.device, args.user);
    const content = await api.readFile(args.path);
    return {
        content: [{ type: 'text', text: content.toString('utf8') }],
        isError: false,
    };
}

async function toolWrite(args) {
    const { api } = getAPI(args.device, args.user);
    await api.writeFile(args.path, Buffer.from(args.content, 'utf8'));
    return {
        content: [{ type: 'text', text: `Written ${args.content.length} bytes to ${args.path}` }],
        isError: false,
    };
}

async function toolLs(args) {
    const { api } = getAPI(args.device, args.user);
    const entries = await api.listDir(args.path || '/', args.include_hidden || false);
    const lines = entries.map((e) => {
        const type = e.type === 'directory' ? 'd' : '-';
        const mode = e.mode || 'rwxr-xr-x';
        const size = (e.size || 0).toString().padStart(8);
        return `${type}${mode} ${size} ${e.name}`;
    });
    return {
        content: [{ type: 'text', text: lines.join('\n') || '(empty directory)' }],
        isError: false,
    };
}

async function toolMkdir(args) {
    const { api } = getAPI(args.device, args.user);
    await api.mkdir(args.path);
    return {
        content: [{ type: 'text', text: `Created directory: ${args.path}` }],
        isError: false,
    };
}

async function toolDelete(args) {
    const { api } = getAPI(args.device, args.user);
    await api.delete(args.path, args.recursive !== false);
    return {
        content: [{ type: 'text', text: `Deleted: ${args.path}` }],
        isError: false,
    };
}

async function toolMove(args) {
    const { api } = getAPI(args.device, args.user);
    await api.move(args.source, args.destination, args.overwrite || false);
    return {
        content: [{ type: 'text', text: `Moved: ${args.source} → ${args.destination}` }],
        isError: false,
    };
}

export const tools = [
    {
        name: 'thinr_read',
        description: `Read a file from a remote device. Paths are absolute on the device filesystem (e.g., "/etc/hosts", "/var/log/syslog"). Subject to the OS user the agent runs as; check whoami (or thinr_device_info) before assuming write access to system paths like /etc.`,
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute file path on the device' },
                device: { type: 'string', description: 'Device ID' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['path', 'device'],
        },
        handler: toolRead,
    },
    {
        name: 'thinr_write',
        description: `Write content to a file on a remote device. Paths are absolute on the device filesystem (e.g., "/etc/hosts", "/var/log/syslog"). Subject to the OS user the agent runs as; check whoami (or thinr_device_info) before assuming write access to system paths like /etc.`,
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute file path on the device' },
                content: { type: 'string', description: 'File content to write' },
                device: { type: 'string', description: 'Device ID' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['path', 'content', 'device'],
        },
        handler: toolWrite,
    },
    {
        name: 'thinr_ls',
        description: `List directory contents on a remote device. Paths are absolute on the device filesystem (e.g., "/", "/etc", "/var/log"). Subject to the OS user the agent runs as; check whoami (or thinr_device_info) before assuming write access to system paths like /etc. Use include_hidden to see dotfiles.`,
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Directory path (default: /)' },
                include_hidden: {
                    type: 'boolean',
                    description: 'Include hidden files (default: false)',
                },
                device: { type: 'string', description: 'Device ID' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['device'],
        },
        handler: toolLs,
    },
    {
        name: 'thinr_mkdir',
        description: `Create a directory on a remote device. Paths are absolute on the device filesystem (e.g., "/etc/hosts", "/var/log/syslog"). Subject to the OS user the agent runs as; check whoami (or thinr_device_info) before assuming write access to system paths like /etc.`,
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Directory path to create' },
                device: { type: 'string', description: 'Device ID' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['path', 'device'],
        },
        handler: toolMkdir,
    },
    {
        name: 'thinr_delete',
        description: `Delete a file or directory on a remote device. Paths are absolute on the device filesystem (e.g., "/etc/hosts", "/var/log/syslog"). Subject to the OS user the agent runs as; check whoami (or thinr_device_info) before assuming write access to system paths like /etc.`,
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Path to delete' },
                recursive: {
                    type: 'boolean',
                    description: 'Delete directory contents recursively (default: true)',
                },
                device: { type: 'string', description: 'Device ID' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['path', 'device'],
        },
        handler: toolDelete,
    },
    {
        name: 'thinr_move',
        description: `Move or rename a file or directory on a remote device. Paths are absolute on the device filesystem (e.g., "/etc/hosts", "/var/log/syslog"). Subject to the OS user the agent runs as; check whoami (or thinr_device_info) before assuming write access to system paths like /etc.`,
        inputSchema: {
            type: 'object',
            properties: {
                source: { type: 'string', description: 'Source path' },
                destination: { type: 'string', description: 'Destination path' },
                overwrite: {
                    type: 'boolean',
                    description: 'Overwrite destination if exists (default: false)',
                },
                device: { type: 'string', description: 'Device ID' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['source', 'destination', 'device'],
        },
        handler: toolMove,
    },
];
