// @ts-check
import { tools as devicesTools } from './tools-devices.js';
import { tools as filesystemTools } from './tools-filesystem.js';
import { tools as execTools } from './tools-exec.js';
import { tools as resourcesTools } from './tools-resources.js';
import { tools as propertiesTools } from './tools-properties.js';
import { tools as scriptsTools } from './tools-scripts.js';
import { tools as productsTools } from './tools-products.js';
import { tools as playbookTools } from './tools-playbook.js';
import { tools as profilesTools } from './tools-profiles.js';
import { tools as installTools } from './tools-install.js';

export const tools = [
    ...devicesTools,
    ...filesystemTools,
    ...execTools,
    ...resourcesTools,
    ...propertiesTools,
    ...scriptsTools,
    ...productsTools,
    ...playbookTools,
    ...profilesTools,
    ...installTools,
];

// Inject the optional `profile` parameter on every tool so callers can
// target any configured environment per-call without changing the saved
// default. `thinr_profiles` is the lookup itself, so it's exempt.
for (const t of tools) {
    if (t.name === 'thinr_profiles') continue;
    t.inputSchema.properties = t.inputSchema.properties || {};
    t.inputSchema.properties.profile = {
        type: 'string',
        description: 'CLI profile to use for this call (see thinr_profiles). Omit for the default.',
    };
}
