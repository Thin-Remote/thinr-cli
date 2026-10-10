// @ts-check

/**
 * Identity of the `thinr` CLI on top of @thinger-io/cli-core: its names,
 * where its profiles live, the OAuth client registered for it on the
 * ThinRemote servers, and the shape every ThinRemote product starts with.
 *
 * Profiles stay apart from the `thinger` CLI's (~/.config/thinger-cli,
 * THINGER_*), so neither MCP server operates on the other's servers.
 *
 * @type {import('@thinger-io/cli-core/identity').CliIdentity}
 */
export const thinrIdentity = {
    name: 'thinr',
    displayName: 'ThinRemote',
    description: 'CLI for ThinRemote - Remote management for IoT devices',
    configDir: 'thinr-cli',
    envPrefix: 'THINR',
    token: { id: 'ThinRemote', name: 'ThinRemote' },
    oauth: { clientId: '3b40164d28730e416cbd' },
    defaultServer: 'console.thinr.io',
    mcp: { serverName: 'thinr', toolPrefix: 'thinr' },
    // ThinRemote products: `type: thinremote`, a Linux icon, and a
    // `monitoring` bucket fed every 60 s from the agent's `monitoring`
    // resource.
    productTemplate: {
        description: 'ThinRemote product',
        config: {
            type: 'thinremote',
            icons: [
                {
                    conditions: [],
                    icon: {
                        type: 'fa',
                        source: 'fab fa-linux',
                        color: '#000000',
                        background: '#ffffff',
                    },
                },
            ],
        },
        profile: {
            buckets: {
                monitoring: {
                    name: 'Monitoring Data',
                    description: 'ThinRemote device metrics',
                    enabled: true,
                    backend: 'mongodb',
                    data: {
                        source: 'resource',
                        resource: 'monitoring',
                        update: 'interval',
                        interval: 60,
                        magnitude: 'second',
                        payload: '{{payload}}',
                        payload_function: '',
                        payload_type: 'source_payload',
                    },
                    retention: { period: 3, unit: 'months' },
                    tags: [],
                },
            },
        },
    },
};

/** Server-level guidance sent to MCP clients on `initialize`. */
export const mcpInstructions = `Tools to operate ThinRemote fleets: Linux machines running thinr-agent on a Thinger.io server, with the permissions of the token stored in the CLI profile.

- Read the guide first: thinr_doc_read id "thinremote" (the agent, products, which tool for each need, recipes); thinr_doc_read without id lists the rest (scripts, playbooks, product dashboard) and the server's own docs.
- Server resources (devices, products, buckets, tokens, alarms, properties…) go through thinr_resource_list / _get / _create / _update / _delete with a \`type\`; thinr_resource_describe explains each type.
- List before acting to discover ids; never guess them. Fleet changes (thinr_product_exec, thinr_product_write, playbook rollouts) and deletes act immediately: confirm with the user first.
- Every tool takes an optional \`profile\` (another configured server, see thinr_profile_list) and most take \`user\` (another account, admin only).`;
