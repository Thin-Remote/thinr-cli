// @ts-check
import {
    addLogSource,
    getProductLogs,
    listPresets,
    removeLogSource,
    setDefaultLogSource,
} from '../product/logs.js';
import { inputError } from '@thinger-io/cli-core/errors';

function truncate(value, max = 80) {
    if (typeof value !== 'string') return '';
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

async function toolProductLogsList(args) {
    if (!args.product) throw inputError('product is required');
    const cfg = await getProductLogs(args.product, args.user);
    const fallback = !!(/** @type {any} */ (cfg).__fallback);
    const def = cfg.default || cfg.sources[0]?.name || null;
    const lines = cfg.sources.map((s) => {
        const tag = s.name === def ? '★' : ' ';
        return `  ${tag} ${s.name}  →  ${truncate(s.command)}`;
    });
    const header = fallback
        ? `Product "${args.product}" has no logs property — showing the synthetic fallback (${cfg.sources.length} source):`
        : `${cfg.sources.length} log source(s) on "${args.product}" (default: ${def}):`;
    return {
        content: [{ type: 'text', text: [header, ...lines].join('\n') }],
        isError: false,
    };
}

async function toolProductLogsAdd(args) {
    if (!args.product) throw inputError('product is required');
    if (!args.name) throw inputError('name is required');
    if (typeof args.command !== 'string' || args.command.trim() === '') {
        throw inputError('command is required (non-empty string)');
    }
    const { config, action } = await addLogSource(
        args.product,
        {
            name: args.name,
            command: args.command,
            makeDefault: !!args.default,
            pattern: args.pattern,
            preset: args.preset,
        },
        args.user,
    );
    const def = config.default || config.sources[0]?.name || null;
    const lines = [
        `${action === 'added' ? 'Added' : 'Updated'} source "${args.name}" on product "${args.product}"${
            args.default ? ' (default)' : ''
        }.`,
        `Command: ${truncate(args.command, 120)}`,
    ];
    if (args.preset) lines.push(`Preset: ${args.preset}`);
    if (args.pattern) lines.push(`Pattern: ${truncate(args.pattern, 120)}`);
    lines.push(`Sources: ${config.sources.length}${def ? `, default: ${def}` : ''}`);
    return {
        content: [{ type: 'text', text: lines.join('\n') }],
        isError: false,
    };
}

async function toolProductLogsPresets() {
    const presets = listPresets();
    const lines = [
        `${presets.length} log line preset(s) shipped with the CLI:`,
        ...presets.map((p) => `  · ${p.name} — ${p.description}`),
    ];
    return {
        content: [{ type: 'text', text: lines.join('\n') }],
        isError: false,
    };
}

async function toolProductLogsRemove(args) {
    if (!args.product) throw inputError('product is required');
    if (!args.name) throw inputError('name is required');
    const { removed, config } = await removeLogSource(args.product, args.name, args.user);
    if (!removed) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Source "${args.name}" was not configured on product "${args.product}".`,
                },
            ],
            isError: false,
        };
    }
    if (config === null) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Removed last source "${args.name}" from product "${args.product}". Logs property cleared — falls back to the system journal.`,
                },
            ],
            isError: false,
        };
    }
    const def = config.default || config.sources[0]?.name || null;
    return {
        content: [
            {
                type: 'text',
                text: `Removed source "${args.name}" from product "${args.product}". ${config.sources.length} source(s) remain${def ? `, default: ${def}` : ''}.`,
            },
        ],
        isError: false,
    };
}

async function toolProductLogsSetDefault(args) {
    if (!args.product) throw inputError('product is required');
    if (!args.name) throw inputError('name is required');
    const config = await setDefaultLogSource(args.product, args.name, args.user);
    return {
        content: [
            {
                type: 'text',
                text: `Default log source set to "${config.default}" on product "${args.product}".`,
            },
        ],
        isError: false,
    };
}

export const tools = [
    {
        name: 'product_logs_list',
        description:
            "List a product's log sources (name and command; ★ marks the default). Without configured sources the product shows a single `system` journalctl source.",
        inputSchema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'Product ID.' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['product'],
        },
        handler: toolProductLogsList,
    },
    {
        name: 'product_logs_add',
        description:
            'Upsert a log source on a product: a named shell command the agent streams when an operator opens a device\'s logs (journalctl -f, docker logs -f app, tail -F file). `default` makes it the one shown first; `preset` (see {tool:product_logs_presets}) or a `pattern` with named groups time/level/msg enable structured rendering and level filters. Details: {tool:doc_read} id "thinremote-product-dashboard".',
        inputSchema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'Product ID.' },
                name: {
                    type: 'string',
                    description:
                        'Stable identifier for the source (letters, digits, underscore, dash; ≤ 32 chars). Reusing the name updates the existing entry.',
                },
                command: {
                    type: 'string',
                    description:
                        'Shell command the agent should exec-stream when this source is selected (e.g. "journalctl --no-pager --output=short -f", "docker logs -f thinger", "tail -F /var/log/nginx/access.log"). Stored verbatim.',
                },
                default: {
                    type: 'boolean',
                    description:
                        'Mark this source as the active default (default: false). When false the previous default is preserved.',
                },
                pattern: {
                    type: 'string',
                    description:
                        'Custom regex with named groups (time, level, msg) for structured rendering in the dashboard. Mutually exclusive with `preset`. Validated to compile at config time.',
                },
                preset: {
                    type: 'string',
                    description:
                        'Named preset for structured rendering (e.g. "spdlog", "journalctl", "nginx-error"). Use {tool:product_logs_presets} to list available names. Mutually exclusive with `pattern`.',
                },
                user: { type: 'string', description: 'API user' },
            },
            required: ['product', 'name', 'command'],
        },
        handler: toolProductLogsAdd,
    },
    {
        name: 'product_logs_remove',
        description:
            'Remove a log source from a product by name; removing the default leaves none marked, removing the last one restores the `system` fallback. Idempotent.',
        inputSchema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'Product ID.' },
                name: { type: 'string', description: 'Source name previously registered.' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['product', 'name'],
        },
        handler: toolProductLogsRemove,
    },
    {
        name: 'product_logs_presets',
        description:
            'List the named log patterns shipped with the CLI (journalctl, spdlog, nginx…), for the `preset` of {tool:product_logs_add}.',
        inputSchema: {
            type: 'object',
            properties: {},
        },
        handler: toolProductLogsPresets,
    },
    {
        name: 'product_logs_set_default',
        description:
            'Set which existing log source of a product is shown first (and used by `thinr device logs` without --source).',
        inputSchema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'Product ID.' },
                name: { type: 'string', description: 'Source name to mark as default.' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['product', 'name'],
        },
        handler: toolProductLogsSetDefault,
    },
];
