// @ts-check
import { deleteStorage } from '@thinger-io/cli-core/storage';
import { toolName } from '@thinger-io/cli-core/mcp/naming';
import { getAPI } from './helpers.js';

/** Where the rest of what an agent offers is, keyed by what it is. */
const agentMap = (device) => ({
    monitoring: `live: ${toolName('device_resource_call')} resource "monitoring"; history: ${toolName('bucket_data_read')} bucket "monitoring" device "${device}" (fields cpu.usage, memory.usage, disk.root.usage, network.rx_rate, load.1m…)`,
    files: `${toolName('resource_list')} / _get / _create / _update / _delete type "device_fs" parent "${device}"`,
    scripts: `type "device_script" parent "${device}"`,
    commands: `${toolName('device_exec')} device "${device}"`,
    agent_update: `${toolName('resource_call')} type "device" action "agent_update" id "${device}"`,
});

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
                agent.system_info = await api.getResource('system_info');
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
};
