// @ts-check
import { deleteStorage } from '@thinger-io/cli-core/storage';
import { inputError } from '@thinger-io/cli-core/errors';
import { opRef } from '@thinger-io/cli-core/mcp/naming';
import { DASHBOARD_METRICS_PROPERTY, validateDashboardMetrics } from '../product.js';
import {
    FALLBACK_LOGS_COMMAND,
    FALLBACK_LOGS_SOURCE_NAME,
    LOGS_PROPERTY,
    listPresets,
    validateLogsConfig,
} from '../product/logs.js';
import { getAPI } from './helpers.js';

/** Where the rest of what an agent offers is, keyed by what it is. */
const agentMap = (device) => ({
    monitoring: `live: ${opRef('device_resource', 'call')} ids {"device": "${device}", "resource": "monitoring"}; history: ${opRef('bucket_data', 'list')} ids {"bucket": "monitoring"} filter {"device": "${device}"} (fields cpu.usage, memory.usage, disk.root.usage, network.rx_rate, load.1m…), kept only when the device's product has a monitoring bucket (ThinRemote products do): empty otherwise`,
    files: `type "device_fs" ids {"device": "${device}", "path": <absolute path>}`,
    scripts: `type "device_script" ids {"device": "${device}", "script": <file name>}`,
    commands: `${opRef('device', 'exec')} ids {"device": "${device}"} body {"command": …}`,
    agent_update: `${opRef('device', 'agent_update')} ids {"device": "${device}"}`,
});

/** One metric of thinr's terminal dashboard, an element of `dashboard_metrics`. */
const METRIC_SCHEMA = {
    type: 'object',
    required: ['name', 'resource'],
    properties: {
        name: { type: 'string', description: 'Metric id (letters, digits, _ and -), unique.' },
        label: { type: 'string', description: 'Shown in the panel.' },
        resource: {
            type: 'string',
            description: 'Product API resource asked to each device (usually a product script).',
        },
        field: {
            type: 'string',
            description: 'Dot path to the value in the answer; omit for scalars.',
        },
        aggregation: {
            type: 'string',
            enum: ['sum', 'avg', 'max', 'min', 'count', 'top', 'none', 'distribution'],
            description:
                'How the devices\' values combine; "distribution" counts devices per value (versions, kernels).',
        },
        visualization: {
            type: 'string',
            enum: ['kpi', 'bar', 'sparkline', 'list'],
            description: 'kpi (default), sparkline (trend), list (pairs with distribution).',
        },
        interval: {
            type: 'number',
            description: 'Seconds between refreshes; omit to only relay what devices push.',
        },
        unit: { type: 'string', description: 'Suffix shown with the value ("%").' },
    },
};

/** The product properties thinr reads, checked whole before they are written. */
const CHECKED = {
    [LOGS_PROPERTY]: validateLogsConfig,
    [DASHBOARD_METRICS_PROPERTY]: validateDashboardMetrics,
};

/**
 * The value of `logs` or `dashboard_metrics`, checked (and normalized) before
 * it reaches the server: thinr reads them, and a bad one breaks its
 * terminal dashboard for the whole product.
 */
function checkedProperty(body, ctx) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
    const name = ctx.id ?? body.property;
    const check = Object.hasOwn(CHECKED, name) ? CHECKED[name] : undefined;
    if (!check || body.value === undefined) return body;
    if (ctx.merge) {
        throw inputError(
            `${name} is written whole: update it without merge (read it, change it, send the whole value)`,
        );
    }
    return { ...body, value: check(body.value) };
}

/**
 * What ThinRemote adds to the generic `resource_*` tools of cli-core, which
 * run these after their own hooks:
 *
 * - Reading a device also asks its agent, when it is connected, for the
 *   system it runs on (hostname, OS, architecture…) and the base path of
 *   its filesystem: what the server record cannot know. Best effort: a slow
 *   or old agent leaves the record as it is. It also says where the rest of
 *   what the agent offers is (monitoring, files, scripts, commands), so a
 *   model that starts from the device finds it.
 * - Deleting a product also deletes its file storage, which holds the
 *   product's scripts and only ThinRemote products have.
 * - The product properties thinr's terminal dashboard reads (`logs`, its
 *   log sources; `dashboard_metrics`, its fleet metrics) are checked before
 *   they are written, and resource_describe of product_property shows their
 *   shape.
 *
 * @type {Record<string, import('@thinger-io/cli-core/mcp/resource-hooks').ResourceHooks>}
 */
export const resourceHooks = {
    device: {
        async afterGet(record, ctx) {
            if (!record?.connection?.active) return record;
            const { api } = getAPI(ctx.id, ctx.user);
            const agent = {};
            try {
                agent.system_info = await api.getResource('system');
            } catch {}
            try {
                agent.fs_base_path = (await api.info('/')).path || '/';
            } catch {}
            if (!Object.keys(agent).length) return record;
            return { ...record, agent: { ...agent, where: agentMap(ctx.id) } };
        },
    },
    product: {
        async afterDelete(ctx) {
            if (await deleteStorage(ctx.id, ctx.user)) {
                return `Also deleted its file storage "${ctx.id}" (product scripts).`;
            }
        },
    },
    product_property: {
        beforeCreate: checkedProperty,
        beforeUpdate: checkedProperty,
        describe: () => ({
            [LOGS_PROPERTY]: {
                about: "Log sources of thinr's terminal dashboard: named shell commands the agent streams when someone opens a device's logs. Written whole; checked before it is saved.",
                shape: {
                    sources: [
                        {
                            name: 'letters, digits, _ and - (up to 32), unique',
                            command: '"journalctl -f", "docker logs -f app", "tail -F <file>"',
                            preset: 'optional: a named line format (presets below)',
                            pattern:
                                'optional, not with preset: a regex with named groups time, level and msg',
                        },
                    ],
                    default: 'optional: the name of the source shown first',
                },
                fallback: `Without the property a product shows one "${FALLBACK_LOGS_SOURCE_NAME}" source: ${FALLBACK_LOGS_COMMAND}.`,
                presets: Object.fromEntries(listPresets().map((p) => [p.name, p.description])),
            },
            [DASHBOARD_METRICS_PROPERTY]: {
                about: "Fleet metrics of thinr's terminal dashboard (not a console dashboard): an array of metrics, each a value asked to every device and combined across the fleet. Written whole; checked before it is saved.",
                element: METRIC_SCHEMA,
            },
        }),
    },
};
