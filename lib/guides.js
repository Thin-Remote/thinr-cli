// @ts-check

/**
 * The guides thinr ships for agents (served by `thinr_doc_read` and as MCP
 * resources, next to the server's documentation). They describe what thinr
 * implements on top of the server — the agent, product scripts, playbooks,
 * the product dashboard — so they live and change with this code. Tool
 * descriptions stay short and point here for the how-to.
 */
const guide = (name) => new URL(`../docs/guides/${name}.md`, import.meta.url);

export const guides = [
    {
        id: 'thinremote',
        title: 'ThinRemote: devices, agent and products',
        description:
            'Start here: what the agent exposes and the tool for each need, what a ThinRemote product holds, fleet operations and recipes.',
        file: guide('thinremote'),
    },
    {
        id: 'thinremote-scripts',
        title: 'ThinRemote scripts',
        description:
            'Device and product scripts: when to use each, the stdin/stdout JSON contract, resource shapes and examples.',
        file: guide('thinremote-scripts'),
    },
    {
        id: 'thinremote-playbooks',
        title: 'ThinRemote playbooks',
        description:
            'Write, validate, test on one device and roll out playbooks: document format, variables, actions, batches and reports.',
        file: guide('thinremote-playbooks'),
    },
    {
        id: 'thinremote-product-dashboard',
        title: 'ThinRemote product dashboard',
        description: 'Fleet metrics and log sources of a product: fields, aggregations, presets.',
        file: guide('thinremote-product-dashboard'),
    },
];
