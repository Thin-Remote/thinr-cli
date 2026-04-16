// @ts-check
import { callDeviceResource, readDeviceResource } from '../resource.js';
import { inputError } from '../errors.js';
import { getAPI } from './helpers.js';

async function toolScriptList(args) {
    const device = args.device;
    if (!device)
        throw inputError('No device specified. Use thinr_devices to list available devices.');
    const info = await readDeviceResource(device, '$scripts/info');
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
    const device = args.device;
    if (!device)
        throw inputError('No device specified. Use thinr_devices to list available devices.');
    if (!args.name) throw inputError('name is required');
    if (typeof args.content !== 'string') throw inputError('content is required (string)');

    const { api: deviceApi } = getAPI(device, args.user);

    const info = await readDeviceResource(device, '$scripts/info');
    const baseDir = info?.path;
    if (!baseDir)
        throw new Error('Agent did not return a scripts directory (is $scripts/info supported?)');

    if (!/^[A-Za-z0-9._-]+$/.test(args.name)) {
        throw inputError(
            `Invalid script name "${args.name}" (allowed: letters, digits, dot, dash, underscore)`,
        );
    }
    const scriptPath = `${baseDir}/${args.name}`;

    await deviceApi.writeFile(scriptPath, args.content, true);

    const chmod = await deviceApi.exec(`chmod +x ${JSON.stringify(scriptPath)}`, 10);
    if (chmod.retcode !== 0) {
        throw new Error(`chmod +x failed: ${chmod.stderr || `exit ${chmod.retcode}`}`);
    }

    const reloaded = await callDeviceResource(device, '$scripts/reload', {});
    // The agent registers resources by the file's stem, so "battery.sh"
    // becomes scripts/battery. Match the same way to echo back the schema.
    const registeredName = args.name.replace(/\.[^./]+$/, '');
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
    lines.push(`Resource: ${registeredName} — call it with thinr_resource_call.`);
    return {
        content: [{ type: 'text', text: lines.join('\n') }],
        isError: false,
    };
}

async function toolScriptDelete(args) {
    const device = args.device;
    if (!device)
        throw inputError('No device specified. Use thinr_devices to list available devices.');
    if (!args.name) throw inputError('name is required');

    const { api: deviceApi } = getAPI(device, args.user);
    const info = await readDeviceResource(device, '$scripts/info');
    const baseDir = info?.path;
    if (!baseDir)
        throw new Error('Agent did not return a scripts directory (is $scripts/info supported?)');

    if (!/^[A-Za-z0-9._-]+$/.test(args.name)) {
        throw inputError(`Invalid script name "${args.name}"`);
    }
    const scriptPath = `${baseDir}/${args.name}`;

    await deviceApi.delete(scriptPath, false);
    const reloaded = await callDeviceResource(device, '$scripts/reload', {});
    const remaining = Array.isArray(reloaded?.scripts) ? reloaded.scripts.length : 0;
    return {
        content: [
            {
                type: 'text',
                text: `Removed script "${args.name}". ${remaining} script(s) remain registered.`,
            },
        ],
        isError: false,
    };
}

export const tools = [
    {
        name: 'thinr_script_list',
        description: `List the custom scripts registered by the agent's scripts extension, including the on-device scripts directory and each script's --describe schema. Scripts are user-provided executables in <agent_base>/scripts/ that the agent registers as first-class resources under their own names (e.g. a file named \`battery.sh\` becomes the resource \`battery\`). Use this to discover which scripted capabilities the device exposes.`,
        inputSchema: {
            type: 'object',
            properties: {
                device: { type: 'string', description: 'Device ID' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['device'],
        },
        handler: toolScriptList,
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
                    description:
                        'Script filename. The file extension (e.g. .sh, .py) is stripped to form the resource name, so battery.sh registers as the resource "battery".',
                },
                content: {
                    type: 'string',
                    description: 'Full script source code, including shebang.',
                },
                device: { type: 'string', description: 'Device ID' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['name', 'content', 'device'],
        },
        handler: toolScriptWrite,
    },
    {
        name: 'thinr_script_delete',
        description: `Remove a previously installed custom script from the device and reload the scripts extension so the corresponding resource is unregistered. Use this to retire a scripted capability you no longer want the device to expose.`,
        inputSchema: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description:
                        'Name of the script to remove (must match the file basename, without extension).',
                },
                device: { type: 'string', description: 'Device ID' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['name', 'device'],
        },
        handler: toolScriptDelete,
    },
];
