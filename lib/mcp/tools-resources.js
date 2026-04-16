// @ts-check
import { callDeviceResource, listDeviceResourcesWithSchemas } from '../resource.js';
import { inputError } from '../errors.js';

async function toolResourceList(args) {
    const device = args.device;
    if (!device)
        throw inputError('No device specified. Use thinr_devices to list available devices.');
    const entries = await listDeviceResourcesWithSchemas(device);
    const fnLabel = (f) =>
        ({ 1: 'no params', 2: 'input', 3: 'output', 4: 'input/output' })[f] || 'unknown';
    const lines = entries.map((e) => {
        const parts = [`${e.name} [${fnLabel(e.fn)}]`];
        if (e.in !== undefined) parts.push(`  in:  ${JSON.stringify(e.in)}`);
        if (e.out !== undefined) parts.push(`  out: ${JSON.stringify(e.out)}`);
        return parts.join('\n');
    });
    return {
        content: [{ type: 'text', text: lines.length ? lines.join('\n\n') : '(no resources)' }],
        isError: false,
    };
}

async function toolResourceCall(args) {
    const device = args.device;
    if (!device)
        throw inputError('No device specified. Use thinr_devices to list available devices.');
    if (!args.resource) throw inputError('resource is required');
    const result = await callDeviceResource(device, args.resource, args.inputs);
    return {
        content: [
            {
                type: 'text',
                text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            },
        ],
        isError: false,
    };
}

export const tools = [
    {
        name: 'thinr_resource_list',
        description: `List the callable resources exposed by a device, with their input/output schemas when available. Resources are the device's public API — typed endpoints like "cmd" (run a shell command), "monitoring" (live metrics), "update" (upgrade the agent), "system" (OS info), etc. Prefer this before calling thinr_resource_call to discover what a device offers and how to call each resource.`,
        inputSchema: {
            type: 'object',
            properties: {
                device: { type: 'string', description: 'Device ID' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['device'],
        },
        handler: toolResourceList,
    },
    {
        name: 'thinr_resource_call',
        description: `Invoke a resource on a device. Pass \`inputs\` when the resource declares an input schema (e.g. cmd, update); omit for read-only resources like monitoring/system/agent. Returns the resource's output. Use thinr_resource_list first to discover available resources and their expected inputs.`,
        inputSchema: {
            type: 'object',
            properties: {
                resource: {
                    type: 'string',
                    description: 'Resource name as returned by thinr_resource_list.',
                },
                inputs: {
                    description:
                        'JSON object with the input parameters declared by the resource. Omit or pass {} for input-less resources.',
                },
                device: { type: 'string', description: 'Device ID' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['resource', 'device'],
        },
        handler: toolResourceCall,
    },
];
