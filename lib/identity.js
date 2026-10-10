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
