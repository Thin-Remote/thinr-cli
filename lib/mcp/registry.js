// @ts-check
import { tools as filesystemTools } from './tools-filesystem.js';
import { tools as execTools } from './tools-exec.js';
import { tools as scriptsTools } from './tools-scripts.js';
import { tools as productsTools } from './tools-products.js';
import { tools as playbookTools } from './tools-playbook.js';
import { tools as installTools } from './tools-install.js';
import { tools as logsTools } from './tools-logs.js';

/**
 * ThinRemote's own MCP tools: everything that goes through the agent
 * (filesystem, exec, scripts, logs, monitoring, playbooks, install) and
 * the product workflows built on it. They are served next to the generic
 * tools of @thinger-io/cli-core (the `resource_*` tools over the server's
 * resource types, bucket data, device resources, storage files, dashboards,
 * docs), which `buildTools` adds, prefixes with `thinr_` and gives the
 * per-call `profile` option. What ThinRemote adds to the generic tools
 * themselves lives in resource-hooks.js.
 */
export const tools = [
    ...filesystemTools,
    ...execTools,
    ...scriptsTools,
    ...productsTools,
    ...playbookTools,
    ...installTools,
    ...logsTools,
];
