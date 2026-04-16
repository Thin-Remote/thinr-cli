import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createDeviceAPI } from './device-api.js';
import { getDevices } from './device.js';
import { getDeviceProperties, getDeviceProperty, setDeviceProperty } from './property.js';
import { callDeviceResource, listDeviceResourcesWithSchemas, readDeviceResource } from './resource.js';
import { readConfig, listProfiles, getActiveProfile, getProfile, setActiveProfile } from './config.js';
import { setBaseURL } from './api.js';
import {
    getProducts,
    setDeviceProduct,
    deleteProductWithStorage,
    installProductScript,
    removeProductScript,
    listProductScripts,
    readProductScript,
    getProductApi,
} from './product.js';
import { getMonitoringData } from './monitoring.js';
import { classifyError } from './output.js';
import { inputError } from './errors.js';

/**
 * Start a generic MCP server for ThinRemote
 * All tools accept device and optional user parameters
 */
export async function startMCPServer() {
    const config = readConfig();
    if (config.server) {
        setBaseURL(`https://${config.server}`);
    }

    const server = new Server({
        name: 'thinr',
        version: '1.0.0',
    }, {
        capabilities: { tools: {} }
    });

    /** Build a device-scoped API client. Tools must always pass `device`
     *  explicitly — the server has no per-session default. */
    function getAPI(device, user) {
        if (!device) throw inputError('device is required. Use thinr_devices to list available devices.');
        return { api: createDeviceAPI(device, { user: user || undefined }), device };
    }

    const tools = [
        {
            name: 'thinr_devices',
            description: 'List all available remote devices and their online/offline status.',
            inputSchema: {
                type: 'object',
                properties: {
                    user: {
                        type: 'string',
                        description: 'API user (for admin impersonation). Omit to use your own account.'
                    }
                },
                required: []
            }
        },
        {
            name: 'thinr_search',
            description: 'Search devices by matching a pattern against the device ID and name fields. The backend interprets the pattern as a case-insensitive regular expression, so anchors (^, $), wildcards (.*), character classes ([mM]) and alternatives (mac|book) all work. Use this before other device tools when you know only part of the device name to avoid listing every device.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Pattern matched against device ID or name. Plain substrings work ("office"); regex metacharacters are also honoured ("^raspberry", "mac|book"). Case-insensitive.'
                    },
                    limit: {
                        type: 'number',
                        description: 'Maximum number of matches to return (default: 20).'
                    },
                    user: {
                        type: 'string',
                        description: 'API user (for admin impersonation). Omit to use your own account.'
                    }
                },
                required: ['query']
            }
        },
        {
            name: 'thinr_device_info',
            description: 'Get device information: hostname, OS, architecture, filesystem base path, and system resources.',
            inputSchema: {
                type: 'object',
                properties: {
                    device: {
                        type: 'string',
                        description: `Device ID`
                    },
                    user: {
                        type: 'string',
                        description: `API user`
                    }
                },
                required: []
            }
        },
        {
            name: 'thinr_exec',
            description: `Execute a shell command on a remote device. Returns stdout, stderr, and exit code.`,
            inputSchema: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'Shell command to execute'
                    },
                    device: {
                        type: 'string',
                        description: `Device ID (from thinr_devices)`
                    },
                    timeout: {
                        type: 'number',
                        description: 'Timeout in seconds (default: 30)'
                    },
                    user: {
                        type: 'string',
                        description: `API user (for admin impersonation)`
                    }
                },
                required: ['command']
            }
        },
        {
            name: 'thinr_read',
            description: `Read a file from a remote device. Paths are absolute on the device filesystem (e.g., "/etc/hosts", "/var/log/syslog"). Subject to the OS user's permissions; the agent currently runs as root on most devices.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Absolute file path on the device'
                    },
                    device: {
                        type: 'string',
                        description: `Device ID`
                    },
                    user: {
                        type: 'string',
                        description: `API user`
                    }
                },
                required: ['path']
            }
        },
        {
            name: 'thinr_write',
            description: `Write content to a file on a remote device. Paths are absolute on the device filesystem (e.g., "/etc/hosts", "/var/log/syslog"). Subject to the OS user's permissions; the agent currently runs as root on most devices.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Absolute file path on the device'
                    },
                    content: {
                        type: 'string',
                        description: 'File content to write'
                    },
                    device: {
                        type: 'string',
                        description: `Device ID`
                    },
                    user: {
                        type: 'string',
                        description: `API user`
                    }
                },
                required: ['path', 'content']
            }
        },
        {
            name: 'thinr_ls',
            description: `List directory contents on a remote device. Paths are absolute on the device filesystem (e.g., "/", "/etc", "/var/log"). Subject to the OS user's permissions; the agent currently runs as root on most devices. Use include_hidden to see dotfiles.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Directory path (default: /)'
                    },
                    include_hidden: {
                        type: 'boolean',
                        description: 'Include hidden files (default: false)'
                    },
                    device: {
                        type: 'string',
                        description: `Device ID`
                    },
                    user: {
                        type: 'string',
                        description: `API user`
                    }
                },
                required: []
            }
        },
        {
            name: 'thinr_mkdir',
            description: `Create a directory on a remote device. Paths are absolute on the device filesystem (e.g., "/etc/hosts", "/var/log/syslog"). Subject to the OS user's permissions; the agent currently runs as root on most devices.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Directory path to create'
                    },
                    device: {
                        type: 'string',
                        description: `Device ID`
                    },
                    user: {
                        type: 'string',
                        description: `API user`
                    }
                },
                required: ['path']
            }
        },
        {
            name: 'thinr_delete',
            description: `Delete a file or directory on a remote device. Paths are absolute on the device filesystem (e.g., "/etc/hosts", "/var/log/syslog"). Subject to the OS user's permissions; the agent currently runs as root on most devices.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Path to delete'
                    },
                    recursive: {
                        type: 'boolean',
                        description: 'Delete directory contents recursively (default: true)'
                    },
                    device: {
                        type: 'string',
                        description: `Device ID`
                    },
                    user: {
                        type: 'string',
                        description: `API user`
                    }
                },
                required: ['path']
            }
        },
        {
            name: 'thinr_move',
            description: `Move or rename a file or directory on a remote device. Paths are absolute on the device filesystem (e.g., "/etc/hosts", "/var/log/syslog"). Subject to the OS user's permissions; the agent currently runs as root on most devices.`,
            inputSchema: {
                type: 'object',
                properties: {
                    source: {
                        type: 'string',
                        description: 'Source path'
                    },
                    destination: {
                        type: 'string',
                        description: 'Destination path'
                    },
                    overwrite: {
                        type: 'boolean',
                        description: 'Overwrite destination if exists (default: false)'
                    },
                    device: {
                        type: 'string',
                        description: `Device ID`
                    },
                    user: {
                        type: 'string',
                        description: `API user`
                    }
                },
                required: ['source', 'destination']
            }
        },
        {
            name: 'thinr_resource_list',
            description: `List the callable resources exposed by a device, with their input/output schemas when available. Resources are the device's public API — typed endpoints like "cmd" (run a shell command), "monitoring" (live metrics), "update" (upgrade the agent), "system" (OS info), etc. Prefer this before calling thinr_resource_call to discover what a device offers and how to call each resource.`,
            inputSchema: {
                type: 'object',
                properties: {
                    device: {
                        type: 'string',
                        description: `Device ID`
                    },
                    user: {
                        type: 'string',
                        description: `API user`
                    }
                },
                required: []
            }
        },
        {
            name: 'thinr_resource_call',
            description: `Invoke a resource on a device. Pass \`inputs\` when the resource declares an input schema (e.g. cmd, update); omit for read-only resources like monitoring/system/agent. Returns the resource's output. Use thinr_resource_list first to discover available resources and their expected inputs.`,
            inputSchema: {
                type: 'object',
                properties: {
                    resource: {
                        type: 'string',
                        description: 'Resource name as returned by thinr_resource_list.'
                    },
                    inputs: {
                        description: 'JSON object with the input parameters declared by the resource. Omit or pass {} for input-less resources.'
                    },
                    device: {
                        type: 'string',
                        description: `Device ID`
                    },
                    user: {
                        type: 'string',
                        description: `API user`
                    }
                },
                required: ['resource']
            }
        },
        {
            name: 'thinr_property_get',
            description: `Read a device property. Properties are the device's structured state (e.g. configuration, last values, calibration). Call without \`property\` to list the names of every property the device has. Prefer this over thinr_exec when you need config data — it returns the raw typed value without shell parsing.`,
            inputSchema: {
                type: 'object',
                properties: {
                    property: {
                        type: 'string',
                        description: 'Property name. Omit to list the names of all properties on the device.'
                    },
                    device: {
                        type: 'string',
                        description: `Device ID`
                    },
                    user: {
                        type: 'string',
                        description: `API user`
                    }
                },
                required: []
            }
        },
        {
            name: 'thinr_property_set',
            description: `Create or overwrite a device property. The value can be any JSON-serialisable shape (string, number, object, array). Existing properties are replaced wholesale; missing ones are created. Use this instead of thinr_exec when you want to persist structured state on the device record, since properties survive device restarts and are visible from the dashboard.`,
            inputSchema: {
                type: 'object',
                properties: {
                    property: {
                        type: 'string',
                        description: 'Property name to create or overwrite.'
                    },
                    value: {
                        description: 'Any JSON-serialisable value (string, number, boolean, object, array).'
                    },
                    device: {
                        type: 'string',
                        description: `Device ID`
                    },
                    user: {
                        type: 'string',
                        description: `API user`
                    }
                },
                required: ['property', 'value']
            }
        },
        {
            name: 'thinr_script_list',
            description: `List the custom scripts registered by the agent's scripts extension, including the on-device scripts directory and each script's --describe schema. Scripts are user-provided executables in <agent_base>/scripts/ that the agent registers as first-class resources under their own names (e.g. a file named \`battery.sh\` becomes the resource \`battery\`). Use this to discover which scripted capabilities the device exposes.`,
            inputSchema: {
                type: 'object',
                properties: {
                    device: {
                        type: 'string',
                        description: `Device ID`
                    },
                    user: {
                        type: 'string',
                        description: `API user`
                    }
                },
                required: []
            }
        },
        {
            name: 'thinr_script_write',
            description: `Install or replace a custom script on the device and reload the scripts extension so the new resource is immediately callable.

Scripts turn an ad-hoc operation into a reusable, typed, discoverable resource on the device. Prefer this over thinr_exec when you want to formalise a recurring task (read sensors, rotate a log, run a backup, collect a health report) so it becomes a persistent resource with an input/output schema that future tool calls can introspect and invoke via thinr_resource_call. A script named \`battery.sh\` is registered as the resource \`battery\` — collisions with native resources (e.g. \`monitoring\`, \`system\`) overwrite them, so pick a name that doesn't clash.

Script contract:
- Must be executable code (any interpreter works — add a shebang like \`#!/bin/bash\` or \`#!/usr/bin/env python3\`).
- When invoked with \`--describe\`, it should print a JSON object with \`input\` and/or \`output\` sample objects on stdout (e.g. \`{"input": {"path": ""}, "output": {"size": 0, "mtime": 0}}\`). These populate the resource's schema.
- When invoked normally, the full input JSON object is passed on stdin; stdout is parsed as JSON. If stdout is a JSON object, its keys become the output fields; otherwise the value is exposed under \`output\`. Non-zero exit codes surface as errors.

This tool writes the script, makes it executable, and calls the agent's \`$scripts/reload\` so the change takes effect without restarting the agent.`,
            inputSchema: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'Script filename. The file extension (e.g. .sh, .py) is stripped to form the resource name, so battery.sh registers as the resource "battery".'
                    },
                    content: {
                        type: 'string',
                        description: 'Full script source code, including shebang.'
                    },
                    device: {
                        type: 'string',
                        description: `Device ID`
                    },
                    user: {
                        type: 'string',
                        description: `API user`
                    }
                },
                required: ['name', 'content']
            }
        },
        {
            name: 'thinr_script_delete',
            description: `Remove a previously installed custom script from the device and reload the scripts extension so the corresponding resource is unregistered. Use this to retire a scripted capability you no longer want the device to expose.`,
            inputSchema: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'Name of the script to remove (must match the file basename, without extension).'
                    },
                    device: {
                        type: 'string',
                        description: `Device ID`
                    },
                    user: {
                        type: 'string',
                        description: `API user`
                    }
                },
                required: ['name']
            }
        },
        {
            name: 'thinr_update',
            description: `Check for agent updates or apply an update on a remote device.`,
            inputSchema: {
                type: 'object',
                properties: {
                    device: {
                        type: 'string',
                        description: `Device ID`
                    },
                    action: {
                        type: 'string',
                        description: '"check" to check for updates, "apply" to install the update'
                    },
                    channel: {
                        type: 'string',
                        description: 'Update channel (default: "latest")'
                    },
                    user: {
                        type: 'string',
                        description: `API user`
                    }
                },
                required: ['action']
            }
        },
        {
            name: 'thinr_monitoring',
            description: `Get monitoring data (CPU, memory, disk, network, temperature, load) from a device or all devices. Use realtime=true for live data from the device, or omit for historical data from the monitoring bucket.`,
            inputSchema: {
                type: 'object',
                properties: {
                    realtime: {
                        type: 'boolean',
                        description: 'If true, get live data directly from the device. If false/omitted, query historical data from the monitoring bucket.'
                    },
                    device: {
                        type: 'string',
                        description: `Device ID. Required for realtime. Omit for historical data from ALL devices.`
                    },
                    items: {
                        type: 'number',
                        description: 'Number of data points to return (default: 10)'
                    },
                    minutes: {
                        type: 'number',
                        description: 'Get data from the last N minutes. Alternative to min_ts/max_ts.'
                    },
                    min_ts: {
                        type: 'number',
                        description: 'Minimum timestamp in milliseconds'
                    },
                    max_ts: {
                        type: 'number',
                        description: 'Maximum timestamp in milliseconds (0 = now)'
                    },
                    sort: {
                        type: 'string',
                        description: 'Sort order: "asc" or "desc" (default: "desc")'
                    },
                    agg: {
                        type: 'string',
                        description: 'Aggregation period: "5m", "10m", "1h", "6h"'
                    },
                    agg_type: {
                        type: 'string',
                        description: 'Aggregation type: "mean", "min", "max"'
                    },
                    fields: {
                        type: 'string',
                        description: 'Comma-separated fields to return (e.g., "cpu.usage,memory.usage,disk.root.usage")'
                    },
                    user: {
                        type: 'string',
                        description: `API user`
                    }
                },
                required: []
            }
        },
        {
            name: 'thinr_product_delete',
            description: 'Delete a product and, by default, its file storage with all scripts. Destructive: confirm with the user before calling. Any device currently assigned to the product is left as-is (unassigned from it by the server) — this tool does not touch the user-level monitoring bucket, which is shared across products.',
            inputSchema: {
                type: 'object',
                properties: {
                    product: {
                        type: 'string',
                        description: 'Product ID to delete.'
                    },
                    keep_storage: {
                        type: 'boolean',
                        description: 'When true, preserve the product\'s file storage (scripts + index.js). Default: false (also delete the storage).'
                    },
                    user: {
                        type: 'string',
                        description: `API user`
                    }
                },
                required: ['product']
            }
        },
        {
            name: 'thinr_products',
            description: 'List all products configured on the server, with their device count and whether they have product-level scripts configured. Use this before assigning a device to a product with thinr_device_set_product, or before managing product scripts with thinr_product_script_*.',
            inputSchema: {
                type: 'object',
                properties: {
                    user: {
                        type: 'string',
                        description: `API user`
                    }
                },
                required: []
            }
        },
        {
            name: 'thinr_device_set_product',
            description: 'Assign a device to a product, or unassign it by passing an empty string. Devices inherit the product\'s API resources and profile configuration (scripts, buckets, etc.) once assigned. Typical flow: create product scripts with thinr_product_script_write, then set a device\'s product here so it can invoke those scripts.',
            inputSchema: {
                type: 'object',
                properties: {
                    device: {
                        type: 'string',
                        description: `Device ID`
                    },
                    product: {
                        type: 'string',
                        description: 'Product ID to assign, or empty string "" to unassign.'
                    },
                    user: {
                        type: 'string',
                        description: `API user`
                    }
                },
                required: ['product']
            }
        },
        {
            name: 'thinr_product_script_list',
            description: `List product-level scripts stored under the product's file storage, cross-referenced with the API resources they expose.

Product scripts are executable files kept in a per-product storage ("<product>") under scripts/. Each script file is exposed as a product API resource (same name without the extension) that can be invoked on any device of the product via thinr_resource_call. Compared to device-level scripts (thinr_script_*), product scripts scale to large fleets because the source of truth lives server-side and is downloaded inline on each invocation — no per-device deployment, no drift.`,
            inputSchema: {
                type: 'object',
                properties: {
                    product: {
                        type: 'string',
                        description: 'Product ID.'
                    },
                    user: {
                        type: 'string',
                        description: `API user`
                    }
                },
                required: ['product']
            }
        },
        {
            name: 'thinr_product_script_read',
            description: `Read the current content of a product script from the product storage. Useful to inspect or edit an existing script before rewriting it with thinr_product_script_write.`,
            inputSchema: {
                type: 'object',
                properties: {
                    product: {
                        type: 'string',
                        description: 'Product ID.'
                    },
                    name: {
                        type: 'string',
                        description: 'Script filename as stored under scripts/ (with extension if any, e.g. "backup.sh").'
                    },
                    user: {
                        type: 'string',
                        description: `API user`
                    }
                },
                required: ['product', 'name']
            }
        },
        {
            name: 'thinr_product_script_write',
            description: `Install or replace a product-level script. Orchestrates everything transparently: creates the product's storage if missing, writes the generic index.js wrapper on first use, wires profile.code.storage, enables the product, uploads the script under scripts/<name>, and creates/updates the API resource so the script is immediately callable on any device of the product.

Script contract:
- Any executable source. If the body starts with a shebang (#!/usr/bin/env python3, #!/bin/bash, …) the agent materializes it to a temp file and runs it with the declared interpreter. Without a shebang, the body runs through the shell (pipes, redirects, && all work).
- The caller's optional "input" object is forwarded to the script on stdin as JSON. Parse with jq / json.load / JSON.parse.
- Stdout/stderr/exit code are returned in the response.

The file extension (.sh, .py, .js, …) is preserved in the storage for editor highlighting, but the API resource name is the stem without extension. So scripts/backup.sh is callable as the resource "backup".`,
            inputSchema: {
                type: 'object',
                properties: {
                    product: {
                        type: 'string',
                        description: 'Product ID.'
                    },
                    name: {
                        type: 'string',
                        description: 'Script filename (e.g. "backup.sh"). The stem ("backup") becomes the API resource name.'
                    },
                    content: {
                        type: 'string',
                        description: 'Full script source code. Include a shebang to use a non-shell interpreter.'
                    },
                    icon: {
                        type: 'string',
                        description: 'Optional Font Awesome 5 icon class to use when the product is created (only applied on first write). Default: "fab fa-linux". Examples: "fab fa-apple", "fab fa-raspberry-pi", "fas fa-server".'
                    },
                    user: {
                        type: 'string',
                        description: `API user`
                    }
                },
                required: ['product', 'name', 'content']
            }
        },
        {
            name: 'thinr_product_script_delete',
            description: `Remove a product script: deletes the file under scripts/ in the product storage and the associated API resource.`,
            inputSchema: {
                type: 'object',
                properties: {
                    product: {
                        type: 'string',
                        description: 'Product ID.'
                    },
                    name: {
                        type: 'string',
                        description: 'Script filename as stored under scripts/ (with extension if any).'
                    },
                    user: {
                        type: 'string',
                        description: `API user`
                    }
                },
                required: ['product', 'name']
            }
        },
        {
            name: 'thinr_profiles',
            description: 'List configured CLI profiles (each profile targets a different ThinRemote server). Use the returned profile name as the optional `profile` parameter on any other tool to target that environment for a single call.',
            inputSchema: {
                type: 'object',
                properties: {},
                required: []
            }
        },
    ];

    // Inject the optional `profile` parameter on every tool so callers can
    // target any configured environment per-call without changing the
    // saved default.
    for (const t of tools) {
        if (t.name === 'thinr_profiles') continue;
        t.inputSchema.properties = t.inputSchema.properties || {};
        t.inputSchema.properties.profile = {
            type: 'string',
            description: 'CLI profile to use for this call (see thinr_profiles). Omit for the default.'
        };
    }

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return { tools };
    });

    /**
     * Run `fn` with the active profile temporarily switched to `profile`
     * (when supplied) so callers can target any configured environment per
     * tool call without persisting the change.
     */
    async function withProfile(profile, fn) {
        if (!profile) return fn();
        const previous = getActiveProfile();
        const target = getProfile(profile);
        if (!target) {
            throw new Error(`Unknown profile: ${profile}. Use thinr_profiles to list available ones.`);
        }
        setActiveProfile(profile);
        if (target.server) setBaseURL(`https://${target.server}`);
        try {
            return await fn();
        } finally {
            setActiveProfile(previous);
            const restore = previous ? getProfile(previous) : null;
            if (restore?.server) setBaseURL(`https://${restore.server}`);
        }
    }

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        try {
            return await withProfile(args?.profile, async () => {
            switch (name) {
                case 'thinr_devices': {
                    const devices = await getDevices({}, args.user);
                    const lines = devices.map(d => {
                        const status = d.connection?.active ? 'online ' : 'offline';
                        const label = d.name ? ` (${d.name})` : '';
                        return `${status}  ${d.device}${label}`;
                    });
                    return {
                        content: [{ type: 'text', text: lines.join('\n') || 'No devices found' }],
                        isError: false
                    };
                }

                case 'thinr_search': {
                    const query = String(args.query || '').trim();
                    if (!query) throw inputError('query is required');
                    const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 20;
                    // Delegate the match to the backend via the `name` query
                    // param, which already searches device ID and name.
                    const matches = await getDevices({ name: query }, args.user);
                    const limited = matches.slice(0, limit);
                    const lines = limited.map(d => {
                        const status = d.connection?.active ? 'online ' : 'offline';
                        const label = d.name ? ` (${d.name})` : '';
                        const product = d.type && d.type !== 'Generic' ? ` [${d.type}]` : '';
                        return `${status}  ${d.device}${label}${product}`;
                    });
                    const header = matches.length === 0
                        ? `No devices match "${query}"`
                        : `${matches.length} match(es) for "${query}"${matches.length > limit ? ` — showing first ${limit}` : ''}:`;
                    return {
                        content: [{ type: 'text', text: [header, ...lines].join('\n') }],
                        isError: false
                    };
                }

                case 'thinr_device_info': {
                    const { api: deviceApi } = getAPI(args.device, args.user);
                    const parts = [];

                    // Try system_info resource first (structured data)
                    try {
                        const sysInfo = await deviceApi.getResource('system_info');
                        parts.push(JSON.stringify(sysInfo, null, 2));
                    } catch {
                        // Fallback to exec
                        const info = await deviceApi.exec('echo "hostname=$(hostname);os=$(uname -s);arch=$(uname -m);kernel=$(uname -r);user=$(whoami);home=$HOME;uptime=$(uptime -p 2>/dev/null || uptime)"', 10);
                        parts.push(info.stdout || '');
                    }

                    // Try real-time monitoring
                    try {
                        const mon = await deviceApi.getResource('monitoring');
                        parts.push('\n--- Real-time monitoring ---');
                        if (mon.cpu) parts.push(`CPU: ${mon.cpu.usage?.toFixed(1)}% (${mon.cpu.cores} cores, ${mon.cpu.temperature?.toFixed(1)}°C)`);
                        if (mon.memory) parts.push(`Memory: ${mon.memory.usage?.toFixed(1)}% (${(mon.memory.total/1073741824).toFixed(1)}GB total)`);
                        if (mon.disk?.root) parts.push(`Disk: ${mon.disk.root.usage?.toFixed(1)}% (${(mon.disk.root.total/1073741824).toFixed(0)}GB total)`);
                        if (mon.network) parts.push(`Network: rx=${(mon.network.rx_rate/1024).toFixed(1)}KB/s tx=${(mon.network.tx_rate/1024).toFixed(1)}KB/s`);
                        if (mon.load) parts.push(`Load: ${mon.load['1m']?.toFixed(2)} / ${mon.load['5m']?.toFixed(2)} / ${mon.load['15m']?.toFixed(2)}`);
                        if (mon.uptime) parts.push(`Uptime: ${Math.floor(mon.uptime/86400)}d ${Math.floor((mon.uptime%86400)/3600)}h`);
                    } catch {}

                    // Try filesystem base path
                    try {
                        const rootInfo = await deviceApi.info('/');
                        parts.push(`\nfs_base_path=${rootInfo.path || '/'}`);
                    } catch {}

                    return {
                        content: [{ type: 'text', text: parts.join('\n') }],
                        isError: false
                    };
                }

                case 'thinr_exec': {
                    const { api } = getAPI(args.device, args.user);
                    let output = '';
                    const { exitCode, timedOut } = await api.execStream(args.command, {
                        timeout: args.timeout || 0,
                        onStdout: (s) => { output += s; },
                        onStderr: (s) => { output += s; },
                    });
                    const trailer = [];
                    if (timedOut) trailer.push(`[command timed out${args.timeout ? ` after ${args.timeout}s` : ''}]`);
                    trailer.push(`[exit code: ${exitCode ?? 'unknown'}]`);
                    const text = [output.trimEnd(), trailer.join(' ')].filter(Boolean).join('\n');
                    return {
                        content: [{ type: 'text', text: text || '(no output)' }],
                        isError: timedOut || exitCode !== 0
                    };
                }

                case 'thinr_read': {
                    const { api } = getAPI(args.device, args.user);
                    const content = await api.readFile(args.path);
                    return {
                        content: [{ type: 'text', text: content.toString('utf8') }],
                        isError: false
                    };
                }

                case 'thinr_write': {
                    const { api } = getAPI(args.device, args.user);
                    await api.writeFile(args.path, Buffer.from(args.content, 'utf8'));
                    return {
                        content: [{ type: 'text', text: `Written ${args.content.length} bytes to ${args.path}` }],
                        isError: false
                    };
                }

                case 'thinr_ls': {
                    const { api } = getAPI(args.device, args.user);
                    const entries = await api.listDir(args.path || '/', args.include_hidden || false);
                    const lines = entries.map(e => {
                        const type = e.type === 'directory' ? 'd' : '-';
                        const mode = e.mode || 'rwxr-xr-x';
                        const size = (e.size || 0).toString().padStart(8);
                        return `${type}${mode} ${size} ${e.name}`;
                    });
                    return {
                        content: [{ type: 'text', text: lines.join('\n') || '(empty directory)' }],
                        isError: false
                    };
                }

                case 'thinr_resource_list': {
                    const device = args.device;
                    if (!device) throw new Error('No device specified. Use thinr_devices to list available devices.');
                    const entries = await listDeviceResourcesWithSchemas(device);
                    const fnLabel = (f) => ({ 1: 'no params', 2: 'input', 3: 'output', 4: 'input/output' }[f] || 'unknown');
                    const lines = entries.map((e) => {
                        const parts = [`${e.name} [${fnLabel(e.fn)}]`];
                        if (e.in !== undefined)  parts.push(`  in:  ${JSON.stringify(e.in)}`);
                        if (e.out !== undefined) parts.push(`  out: ${JSON.stringify(e.out)}`);
                        return parts.join('\n');
                    });
                    return {
                        content: [{ type: 'text', text: lines.length ? lines.join('\n\n') : '(no resources)' }],
                        isError: false
                    };
                }

                case 'thinr_resource_call': {
                    const device = args.device;
                    if (!device) throw new Error('No device specified. Use thinr_devices to list available devices.');
                    if (!args.resource) throw inputError('resource is required');
                    const result = await callDeviceResource(device, args.resource, args.inputs);
                    return {
                        content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
                        isError: false
                    };
                }

                case 'thinr_property_get': {
                    const device = args.device;
                    if (!device) throw new Error('No device specified. Use thinr_devices to list available devices.');
                    if (args.property) {
                        const value = await getDeviceProperty(device, args.property);
                        return {
                            content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
                            isError: false
                        };
                    }
                    const list = await getDeviceProperties(device);
                    const names = Array.isArray(list) ? list.map(p => p.property).filter(Boolean) : [];
                    return {
                        content: [{ type: 'text', text: names.length ? names.join('\n') : '(no properties)' }],
                        isError: false
                    };
                }

                case 'thinr_property_set': {
                    const device = args.device;
                    if (!device) throw new Error('No device specified. Use thinr_devices to list available devices.');
                    if (!args.property) throw inputError('property is required');
                    if (args.value === undefined) throw inputError('value is required');
                    const saved = await setDeviceProperty(device, args.property, args.value);
                    return {
                        content: [{ type: 'text', text: `Saved property "${saved.property}" on ${saved.device} (value: ${JSON.stringify(saved.value)})` }],
                        isError: false
                    };
                }

                case 'thinr_script_list': {
                    const device = args.device;
                    if (!device) throw new Error('No device specified. Use thinr_devices to list available devices.');
                    const info = await readDeviceResource(device, '$scripts/info');
                    const scripts = Array.isArray(info?.scripts) ? info.scripts : [];
                    const header = `Scripts directory: ${info?.path || '(unknown)'}\n${scripts.length} script(s) registered:`;
                    const entries = scripts.map((s) => {
                        const parts = [`\n- ${s.name}  (${s.path})`];
                        if (s.describe?.input !== undefined)  parts.push(`    in:  ${JSON.stringify(s.describe.input)}`);
                        if (s.describe?.output !== undefined) parts.push(`    out: ${JSON.stringify(s.describe.output)}`);
                        return parts.join('\n');
                    });
                    return {
                        content: [{ type: 'text', text: [header, ...entries].join('\n') }],
                        isError: false
                    };
                }

                case 'thinr_script_write': {
                    const device = args.device;
                    if (!device) throw new Error('No device specified. Use thinr_devices to list available devices.');
                    if (!args.name) throw inputError('name is required');
                    if (typeof args.content !== 'string') throw inputError('content is required (string)');

                    const { api: deviceApi } = getAPI(device, args.user);

                    // 1. Discover the scripts directory from the agent.
                    const info = await readDeviceResource(device, '$scripts/info');
                    const baseDir = info?.path;
                    if (!baseDir) throw new Error('Agent did not return a scripts directory (is $scripts/info supported?)');

                    // Basic safety: script name must be a simple basename.
                    if (!/^[A-Za-z0-9._-]+$/.test(args.name)) {
                        throw inputError(`Invalid script name "${args.name}" (allowed: letters, digits, dot, dash, underscore)`);
                    }
                    const scriptPath = `${baseDir}/${args.name}`;

                    // 2. Write the script.
                    await deviceApi.writeFile(scriptPath, args.content, true);

                    // 3. Make it executable.
                    const chmod = await deviceApi.exec(`chmod +x ${JSON.stringify(scriptPath)}`, 10);
                    if (chmod.retcode !== 0) {
                        throw new Error(`chmod +x failed: ${chmod.stderr || `exit ${chmod.retcode}`}`);
                    }

                    // 4. Reload so the new resource is immediately available.
                    const reloaded = await callDeviceResource(device, '$scripts/reload', {});
                    // The agent registers resources by the file's stem, so
                    // "battery.sh" becomes scripts/battery. Match the same
                    // way when looking up the describe schema to echo back.
                    const registeredName = args.name.replace(/\.[^./]+$/, '');
                    const found = Array.isArray(reloaded?.scripts)
                        ? reloaded.scripts.find((s) => s.name === registeredName)
                        : null;

                    const lines = [`Installed script "${registeredName}" at ${scriptPath}`];
                    if (found?.describe) {
                        lines.push(`Schema: ${JSON.stringify(found.describe)}`);
                    } else {
                        lines.push('Schema: (no --describe provided; script will accept any input and return raw output)');
                    }
                    lines.push(`Resource: ${registeredName} — call it with thinr_resource_call.`);
                    return {
                        content: [{ type: 'text', text: lines.join('\n') }],
                        isError: false
                    };
                }

                case 'thinr_script_delete': {
                    const device = args.device;
                    if (!device) throw new Error('No device specified. Use thinr_devices to list available devices.');
                    if (!args.name) throw inputError('name is required');

                    const { api: deviceApi } = getAPI(device, args.user);
                    const info = await readDeviceResource(device, '$scripts/info');
                    const baseDir = info?.path;
                    if (!baseDir) throw new Error('Agent did not return a scripts directory (is $scripts/info supported?)');

                    if (!/^[A-Za-z0-9._-]+$/.test(args.name)) {
                        throw inputError(`Invalid script name "${args.name}"`);
                    }
                    const scriptPath = `${baseDir}/${args.name}`;

                    await deviceApi.delete(scriptPath, false);
                    const reloaded = await callDeviceResource(device, '$scripts/reload', {});
                    const remaining = Array.isArray(reloaded?.scripts) ? reloaded.scripts.length : 0;
                    return {
                        content: [{ type: 'text', text: `Removed script "${args.name}". ${remaining} script(s) remain registered.` }],
                        isError: false
                    };
                }

                case 'thinr_update': {
                    const { api: deviceApi } = getAPI(args.device, args.user);
                    const payload = {
                        action: args.action,
                        channel: args.channel || 'latest'
                    };
                    const result = await deviceApi.callResource('update', payload);
                    return {
                        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                        isError: false
                    };
                }

                case 'thinr_monitoring': {
                    const device = args.device;
                    const user = args.user;

                    // Real-time: read the device's `monitoring` resource directly
                    if (args.realtime) {
                        if (!device) throw inputError('Device required for real-time monitoring');
                        const { api: deviceApi } = getAPI(device, args.user);
                        const mon = await deviceApi.getResource('monitoring');
                        const parts = [`Real-time monitoring for ${device}:`];
                        if (mon.cpu) parts.push(`CPU: ${mon.cpu.usage?.toFixed(1)}% (${mon.cpu.cores} cores, ${mon.cpu.temperature?.toFixed(1)}°C)`);
                        if (mon.memory) parts.push(`Memory: ${mon.memory.usage?.toFixed(1)}% (available: ${(mon.memory.available/1073741824).toFixed(1)}GB / total: ${(mon.memory.total/1073741824).toFixed(1)}GB)`);
                        if (mon.disk?.root) parts.push(`Disk: ${mon.disk.root.usage?.toFixed(1)}% (available: ${(mon.disk.root.available/1073741824).toFixed(1)}GB / total: ${(mon.disk.root.total/1073741824).toFixed(0)}GB)`);
                        if (mon.network) parts.push(`Network: rx=${(mon.network.rx_rate/1024).toFixed(1)}KB/s tx=${(mon.network.tx_rate/1024).toFixed(1)}KB/s`);
                        if (mon.load) parts.push(`Load: ${mon.load['1m']?.toFixed(2)} / ${mon.load['5m']?.toFixed(2)} / ${mon.load['15m']?.toFixed(2)}`);
                        if (mon.processes) parts.push(`Processes: ${mon.processes.total}`);
                        if (mon.uptime) parts.push(`Uptime: ${Math.floor(mon.uptime/86400)}d ${Math.floor((mon.uptime%86400)/3600)}h ${Math.floor((mon.uptime%3600)/60)}m`);
                        if (mon.agent) parts.push(`Agent: ${mon.agent.version}`);
                        return { content: [{ type: 'text', text: parts.join('\n') }], isError: false };
                    }

                    // Historical: query the monitoring bucket
                    const data = await getMonitoringData({
                        device, user,
                        items: args.items || 10,
                        sort: args.sort || 'desc',
                        minutes: args.minutes,
                        min_ts: args.min_ts,
                        max_ts: args.max_ts,
                        agg: args.agg,
                        agg_type: args.agg_type,
                        fields: args.fields,
                    });

                    // Format output concisely
                    let output;
                    if (Array.isArray(data) && data.length > 0) {
                        output = data.map(d => {
                            const ts = new Date(d.ts).toISOString();
                            const parts = [ts];
                            if (d.device) parts.push(`device=${d.device}`);
                            if (d.cpu) {
                                const cpuParts = [];
                                if (d.cpu.usage !== undefined) cpuParts.push(`${d.cpu.usage.toFixed(1)}%`);
                                if (d.cpu.temperature !== undefined) cpuParts.push(`${d.cpu.temperature.toFixed(1)}°C`);
                                if (cpuParts.length) parts.push(`cpu=${cpuParts.join(' ')}`);
                            }
                            if (d.memory) parts.push(`mem=${d.memory.usage?.toFixed(1)}%`);
                            if (d.disk?.root) parts.push(`disk=${d.disk.root.usage?.toFixed(1)}%`);
                            if (d.network) parts.push(`net_rx=${(d.network.rx_rate/1024)?.toFixed(1)}KB/s tx=${(d.network.tx_rate/1024)?.toFixed(1)}KB/s`);
                            if (d.load) parts.push(`load=${d.load['1m']?.toFixed(2)}`);
                            if (d.processes) parts.push(`procs=${d.processes.total}`);
                            return parts.join(' | ');
                        }).join('\n');
                    } else {
                        output = JSON.stringify(data, null, 2);
                    }

                    return {
                        content: [{ type: 'text', text: output || 'No data' }],
                        isError: false
                    };
                }

                case 'thinr_mkdir': {
                    const { api } = getAPI(args.device, args.user);
                    await api.mkdir(args.path);
                    return {
                        content: [{ type: 'text', text: `Created directory: ${args.path}` }],
                        isError: false
                    };
                }

                case 'thinr_delete': {
                    const { api } = getAPI(args.device, args.user);
                    await api.delete(args.path, args.recursive !== false);
                    return {
                        content: [{ type: 'text', text: `Deleted: ${args.path}` }],
                        isError: false
                    };
                }

                case 'thinr_move': {
                    const { api } = getAPI(args.device, args.user);
                    await api.move(args.source, args.destination, args.overwrite || false);
                    return {
                        content: [{ type: 'text', text: `Moved: ${args.source} → ${args.destination}` }],
                        isError: false
                    };
                }

                case 'thinr_profiles': {
                    const names = listProfiles();
                    const active = getActiveProfile();
                    const lines = names.map(n => {
                        const data = getProfile(n) || {};
                        const marker = n === active ? '* ' : '  ';
                        return `${marker}${n}  (${data.username || ''}@${data.server || n})`;
                    });
                    return {
                        content: [{ type: 'text', text: lines.join('\n') || 'No profiles configured' }],
                        isError: false
                    };
                }

                case 'thinr_product_delete': {
                    if (!args.product) throw inputError('product is required');
                    const user = args.user;
                    const { steps } = await deleteProductWithStorage(args.product, user, {
                        keepStorage: !!args.keep_storage,
                    });
                    return {
                        content: [{ type: 'text', text: `Removed "${args.product}":\n  - ${steps.join('\n  - ')}` }],
                        isError: false
                    };
                }

                case 'thinr_products': {
                    const user = args.user;
                    const products = await getProducts(user);
                    if (products.length === 0) {
                        return { content: [{ type: 'text', text: 'No products configured' }], isError: false };
                    }
                    const lines = await Promise.all(products.map(async p => {
                        const id = p.product;
                        const label = p.name && p.name !== id ? ` (${p.name})` : '';
                        const enabled = p.enabled ? '✓' : '✗';
                        const apis = await getProductApi(id, user);
                        const scripts = Object.keys(apis).length;
                        const scriptsLabel = scripts > 0 ? ` — ${scripts} api-resource(s)` : '';
                        return `${enabled}  ${id}${label}${scriptsLabel}`;
                    }));
                    return {
                        content: [{ type: 'text', text: `${products.length} product(s):\n${lines.join('\n')}` }],
                        isError: false
                    };
                }

                case 'thinr_device_set_product': {
                    const device = args.device;
                    if (!device) throw inputError('device is required');
                    if (args.product === undefined || args.product === null) throw inputError('product is required (pass "" to unassign)');
                    await setDeviceProduct(device, args.product, args.user);
                    const label = args.product === ''
                        ? `Unassigned ${device} from its product.`
                        : `Assigned ${device} → product "${args.product}".`;
                    return { content: [{ type: 'text', text: label }], isError: false };
                }

                case 'thinr_product_script_list': {
                    if (!args.product) throw inputError('product is required');
                    const entries = await listProductScripts(args.product, args.user);
                    const header = entries.length === 0
                        ? `No scripts in product "${args.product}"`
                        : `${entries.length} script(s) in product "${args.product}":`;
                    const lines = entries.map(e => {
                        const marker = e.registered ? '[api]' : '[orphan]';
                        return `  ${marker} ${e.name}  (${e.size} bytes) → resource: ${e.stem}`;
                    });
                    return {
                        content: [{ type: 'text', text: [header, ...lines].join('\n') }],
                        isError: false
                    };
                }

                case 'thinr_product_script_read': {
                    if (!args.product) throw inputError('product is required');
                    if (!args.name) throw inputError('name is required');
                    const body = await readProductScript(args.product, args.name, args.user);
                    return {
                        content: [{ type: 'text', text: body }],
                        isError: false
                    };
                }

                case 'thinr_product_script_write': {
                    const { steps, stem } = await installProductScript({
                        product: args.product,
                        name: args.name,
                        content: args.content,
                        user: args.user,
                        icon: args.icon,
                    });
                    const lines = [
                        `Installed product script "${args.name}" on "${args.product}".`,
                        `Steps:`,
                        ...steps.map(s => `  - ${s}`),
                        `Invoke on any device of this product with thinr_resource_call(device=<id>, resource="${stem}", inputs={input: {...}}).`
                    ];
                    return {
                        content: [{ type: 'text', text: lines.join('\n') }],
                        isError: false
                    };
                }

                case 'thinr_product_script_delete': {
                    const { steps } = await removeProductScript({
                        product: args.product,
                        name: args.name,
                        user: args.user,
                    });
                    return {
                        content: [{ type: 'text', text: `Removed product script "${args.name}" from "${args.product}":\n  - ${steps.join('\n  - ')}` }],
                        isError: false
                    };
                }

                default:
                    return {
                        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
                        isError: true
                    };
            }
            });
        } catch (error) {
            // Surface the same {message, code} pair the CLI emits in JSON
            // mode so MCP clients can pattern-match on `[code]` instead of
            // doing fuzzy matches on the human message.
            const { message, code } = classifyError(error);
            return {
                content: [{ type: 'text', text: `Error [${code}]: ${message}` }],
                isError: true,
                _meta: { code, message },
            };
        }
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[thinr-mcp] Server started');
}
