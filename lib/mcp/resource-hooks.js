// @ts-check
import { deleteStorage } from '@thinger-io/cli-core/storage';
import { getAPI } from './helpers.js';

/**
 * What ThinRemote adds to the generic `resource_*` tools of cli-core, which
 * run these after their own hooks:
 *
 * - Reading a device also asks its agent, when it is connected, for the
 *   system it runs on (hostname, OS, architecture…) and the base path of
 *   its filesystem: what the server record cannot know. Best effort: a slow
 *   or old agent leaves the record as it is.
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
            return Object.keys(agent).length ? { ...record, agent } : record;
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
