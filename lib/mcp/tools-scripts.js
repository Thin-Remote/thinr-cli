// @ts-check
import {
    callDeviceResource,
    getDeviceResources,
    readDeviceResource,
} from '@thinger-io/cli-core/resource';
import { inputError } from '@thinger-io/cli-core/errors';
import { getAPI } from './helpers.js';
import { toolName } from '@thinger-io/cli-core/mcp/naming';

async function toolScriptList(args) {
    const device = args.device_id;
    if (!device)
        throw inputError(
            `No device specified. Use ${toolName('resource_list')} (type "device") to list available devices.`,
        );
    const info = await readDeviceResource(device, '$scripts/info', { user: args.user });
    const scripts = Array.isArray(info?.scripts) ? info.scripts : [];
    const header = `Scripts directory: ${info?.path || '(unknown)'}\n${scripts.length} script(s) registered:`;
    const entries = scripts.map((s) => {
        const parts = [`\n- ${s.name}  (${s.path})`];
        if (s.describe?.input !== undefined)
            parts.push(`    in:  ${JSON.stringify(s.describe.input)}`);
        if (s.describe?.output !== undefined)
            parts.push(`    out: ${JSON.stringify(s.describe.output)}`);
        return parts.join('\n');
    });
    return {
        content: [{ type: 'text', text: [header, ...entries].join('\n') }],
        isError: false,
    };
}

async function toolScriptWrite(args) {
    const device = args.device_id;
    if (!device)
        throw inputError(
            `No device specified. Use ${toolName('resource_list')} (type "device") to list available devices.`,
        );
    if (!args.name) throw inputError('name is required');
    if (typeof args.content !== 'string') throw inputError('content is required (string)');

    const { api: deviceApi } = getAPI(device, args.user);

    const info = await readDeviceResource(device, '$scripts/info', { user: args.user });
    const baseDir = info?.path;
    if (!baseDir)
        throw new Error('Agent did not return a scripts directory (is $scripts/info supported?)');

    if (!/^[A-Za-z0-9._-]+$/.test(args.name)) {
        throw inputError(
            `Invalid script name "${args.name}" (allowed: letters, digits, dot, dash, underscore)`,
        );
    }
    const scriptPath = `${baseDir}/${args.name}`;

    // The agent registers scripts at the root of the device's resource
    // namespace, so a script named after a built-in resource replaces it and
    // the device silently stops answering the real one. Refuse unless the
    // caller says that is the intent. A name that already belongs to one of
    // this device's own scripts is an update, not a collision.
    const registeredName = args.name.replace(/\.[^./]+$/, '');
    if (!args.force) {
        const [native, current] = await Promise.all([
            getDeviceResources(device, { user: args.user }).catch(() => ({})),
            Promise.resolve(Array.isArray(info?.scripts) ? info.scripts : []),
        ]);
        const isOwnScript = current.some((s) => s.name === registeredName);
        if (!isOwnScript && Object.prototype.hasOwnProperty.call(native, registeredName)) {
            throw inputError(
                `"${registeredName}" is already a resource on this device, and installing this ` +
                    `script would replace it. Rename the script, or pass force: true if replacing ` +
                    `it is what you want.`,
            );
        }
    }

    await deviceApi.writeFile(scriptPath, args.content, true);

    const chmod = await deviceApi.exec(`chmod +x ${JSON.stringify(scriptPath)}`, 10);
    if (chmod.retcode !== 0) {
        throw new Error(`chmod +x failed: ${chmod.stderr || `exit ${chmod.retcode}`}`);
    }

    const reloaded = await callDeviceResource(device, '$scripts/reload', {}, { user: args.user });
    const found = Array.isArray(reloaded?.scripts)
        ? reloaded.scripts.find((s) => s.name === registeredName)
        : null;

    const lines = [`Installed script "${registeredName}" at ${scriptPath}`];
    if (found?.describe) {
        lines.push(`Schema: ${JSON.stringify(found.describe)}`);
    } else {
        lines.push(
            'Schema: (no --describe provided; script will accept any input and return raw output)',
        );
    }
    lines.push(`Resource: ${registeredName} — call it with ${toolName('device_resource_call')}.`);
    return {
        content: [{ type: 'text', text: lines.join('\n') }],
        isError: false,
    };
}

async function toolScriptDelete(args) {
    const device = args.device_id;
    if (!device)
        throw inputError(
            `No device specified. Use ${toolName('resource_list')} (type "device") to list available devices.`,
        );
    if (!args.name) throw inputError('name is required');

    const { api: deviceApi } = getAPI(device, args.user);
    const info = await readDeviceResource(device, '$scripts/info', { user: args.user });
    const baseDir = info?.path;
    if (!baseDir)
        throw new Error('Agent did not return a scripts directory (is $scripts/info supported?)');

    if (!/^[A-Za-z0-9._-]+$/.test(args.name)) {
        throw inputError(`Invalid script name "${args.name}"`);
    }

    // Callers name a script either way round: `battery` as it appears in the
    // resource list, or `battery.sh` as it sits on disk. Resolve against what
    // the agent reports so both land on the same file, and say what is there
    // when neither matches instead of letting a 404 through.
    const scripts = Array.isArray(info?.scripts) ? info.scripts : [];
    const stem = args.name.replace(/\.[^./]+$/, '');
    const match = scripts.find((s) => s.name === stem || s.path?.endsWith(`/${args.name}`));
    if (!match) {
        const registered = scripts.map((s) => s.name).join(', ') || 'none';
        throw inputError(
            `No script named "${args.name}" on this device. Registered: ${registered}.`,
        );
    }
    const scriptPath = match.path || `${baseDir}/${args.name}`;

    await deviceApi.delete(scriptPath, false);
    const reloaded = await callDeviceResource(device, '$scripts/reload', {}, { user: args.user });
    const remaining = Array.isArray(reloaded?.scripts) ? reloaded.scripts.length : 0;
    return {
        content: [
            {
                type: 'text',
                text: `Removed script "${match.name}" (${scriptPath}). ${remaining} script(s) remain registered.`,
            },
        ],
        isError: false,
    };
}

export const tools = [
    {
        name: 'device_script_list',
        description:
            "List the scripts installed on a device (the agent's scripts folder) with the input/output schema each describes.",
        inputSchema: {
            type: 'object',
            properties: {
                device_id: { type: 'string', description: 'Device ID' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['device_id'],
        },
        handler: toolScriptList,
    },
    {
        name: 'device_script_write',
        description:
            'Install or replace a script on one device and reload the agent\'s scripts, so it becomes a resource of that device (battery.sh → "battery"). It runs with the agent\'s privileges (root for a system install): installing one grants permanent remote execution of that code. Refuses names of built-in resources (cmd, monitoring, system, update, agent) unless `force`. For fleets prefer {tool:product_script_write}. Contract (--describe, stdin/stdout JSON): {tool:doc_read} id "thinremote-scripts".',
        inputSchema: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description:
                        'Script filename. The file extension (e.g. .sh, .py) is stripped to form the resource name, so battery.sh registers as the resource "battery".',
                },
                force: {
                    type: 'boolean',
                    description:
                        "Install even when the resulting resource name replaces one of the device's built-in resources.",
                },
                content: {
                    type: 'string',
                    description: 'Full script source code, including shebang.',
                },
                device_id: { type: 'string', description: 'Device ID' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['name', 'content', 'device_id'],
        },
        handler: toolScriptWrite,
    },
    {
        name: 'device_script_delete',
        description:
            "Remove a script from a device and reload the agent's scripts, retiring its resource.",
        inputSchema: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description:
                        'Name of the script to remove (must match the file basename, without extension).',
                },
                device_id: { type: 'string', description: 'Device ID' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['name', 'device_id'],
        },
        handler: toolScriptDelete,
    },
];
