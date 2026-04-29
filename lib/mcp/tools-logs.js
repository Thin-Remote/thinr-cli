// @ts-check
import {
    addLogSource,
    getProductLogs,
    listPresets,
    removeLogSource,
    setDefaultLogSource,
} from '../product/logs.js';
import { inputError } from '../errors.js';

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
        name: 'thinr_product_logs_list',
        description: `List the log sources configured on a product. Each source pairs a slug-ish \`name\` (visible to operators) with a \`command\` the agent will exec-stream when that source is selected. The default source — used when callers do not pick explicitly — is highlighted with a ★. When the product has no \`logs\` property yet, returns a synthetic fallback with a single \`system\` source running journalctl, matching the dashboard's pre-feature behaviour. Pair with thinr_product_logs_add to populate, thinr_product_logs_set_default to pick which one comes up first, or thinr_product_logs_remove to drop entries.`,
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
        name: 'thinr_product_logs_add',
        description: `Upsert a log source on a product: adds a new entry if \`name\` is unused, replaces the command in place when it already exists. The command is an opaque shell string the agent will exec-stream as-is when the dashboard or CLI selects this source — there is no protocol indirection, no special log "kind". Use it to expose journalctl unit tails, container log streams (\`docker logs -f thinger\`), application log files (\`tail -F /var/log/app.log\`), or any other follow-style command relevant to the device fleet.

Set \`default: true\` to mark this source as the active default; the previous default is preserved otherwise (or, on a fresh product, no default is recorded so consumers fall back to the first source). Names are slug-ish (letters, digits, underscore, dash; ≤ 32 chars). Up to 32 sources per product. The product does not need to exist on the agent — the configuration lives entirely server-side.

Optionally attach a \`pattern\` (regex with named groups \`time\`, \`level\`, \`msg\`) or a \`preset\` (named pattern shipped with the CLI; see thinr_product_logs_presets) to enable structured rendering in the dashboard. When the pattern captures a \`level\` group, the operator can filter the panel by severity (info+/warn+/error+). \`pattern\` and \`preset\` are mutually exclusive; omit both to keep the source rendered raw.`,
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
                        'Named preset for structured rendering (e.g. "spdlog", "journalctl", "nginx-error"). Use thinr_product_logs_presets to list available names. Mutually exclusive with `pattern`.',
                },
                user: { type: 'string', description: 'API user' },
            },
            required: ['product', 'name', 'command'],
        },
        handler: toolProductLogsAdd,
    },
    {
        name: 'thinr_product_logs_remove',
        description: `Remove a log source by name from a product. When the removed entry was the default, the default is dropped (consumers will fall back to the first remaining source). When the last source is removed, the entire \`logs\` property is deleted so the product reverts to the synthetic fallback. Idempotent — calling it on a missing source reports success without erroring.`,
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
        name: 'thinr_product_logs_presets',
        description: `List the named log line patterns shipped with the CLI. Each preset bundles a regex with named groups (\`time\`, \`level\`, \`msg\`) tuned for a common log format (journalctl short, spdlog, nginx access/error). Use the preset name with thinr_product_logs_add via the \`preset\` argument to enable structured rendering and level-based filtering on a source without typing the regex by hand.`,
        inputSchema: {
            type: 'object',
            properties: {},
        },
        handler: toolProductLogsPresets,
    },
    {
        name: 'thinr_product_logs_set_default',
        description: `Set the active default log source on a product. The named source must already exist (use thinr_product_logs_add first). The default is what the dashboard surfaces first when an operator opens a device, and what \`thinr device logs <id>\` resolves to when no \`--source\` flag is passed. To clear the default, remove the matching source with thinr_product_logs_remove.`,
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
