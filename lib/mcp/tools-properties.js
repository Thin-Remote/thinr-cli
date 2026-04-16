// @ts-check
import { getDeviceProperties, getDeviceProperty, setDeviceProperty } from '../property.js';
import { inputError } from '../errors.js';

async function toolPropertyGet(args) {
    const device = args.device;
    if (!device)
        throw inputError('No device specified. Use thinr_devices to list available devices.');
    if (args.property) {
        const value = await getDeviceProperty(device, args.property);
        return {
            content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
            isError: false,
        };
    }
    const list = await getDeviceProperties(device);
    const names = Array.isArray(list) ? list.map((p) => p.property).filter(Boolean) : [];
    return {
        content: [{ type: 'text', text: names.length ? names.join('\n') : '(no properties)' }],
        isError: false,
    };
}

async function toolPropertySet(args) {
    const device = args.device;
    if (!device)
        throw inputError('No device specified. Use thinr_devices to list available devices.');
    if (!args.property) throw inputError('property is required');
    if (args.value === undefined) throw inputError('value is required');
    const saved = await setDeviceProperty(device, args.property, args.value);
    return {
        content: [
            {
                type: 'text',
                text: `Saved property "${saved.property}" on ${saved.device} (value: ${JSON.stringify(saved.value)})`,
            },
        ],
        isError: false,
    };
}

export const tools = [
    {
        name: 'thinr_property_get',
        description: `Read a device property. Properties are the device's structured state (e.g. configuration, last values, calibration). Call without \`property\` to list the names of every property the device has. Prefer this over thinr_exec when you need config data — it returns the raw typed value without shell parsing.`,
        inputSchema: {
            type: 'object',
            properties: {
                property: {
                    type: 'string',
                    description:
                        'Property name. Omit to list the names of all properties on the device.',
                },
                device: { type: 'string', description: 'Device ID' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['device'],
        },
        handler: toolPropertyGet,
    },
    {
        name: 'thinr_property_set',
        description: `Create or overwrite a device property. The value can be any JSON-serialisable shape (string, number, object, array). Existing properties are replaced wholesale; missing ones are created. Use this instead of thinr_exec when you want to persist structured state on the device record, since properties survive device restarts and are visible from the dashboard.`,
        inputSchema: {
            type: 'object',
            properties: {
                property: { type: 'string', description: 'Property name to create or overwrite.' },
                value: {
                    description:
                        'Any JSON-serialisable value (string, number, boolean, object, array).',
                },
                device: { type: 'string', description: 'Device ID' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['property', 'value', 'device'],
        },
        handler: toolPropertySet,
    },
];
