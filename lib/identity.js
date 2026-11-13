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
    npmPackage: '@thinremote/thinr-cli',
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
export const mcpInstructions = `Tools to operate ThinRemote fleets: machines running thinr-agent on a Thinger.io server, with the permissions of the token stored in the CLI profile.

- Read the guide first: thinr_resource_get type "doc" ids {"doc": "thinremote"} (the agent, products, which type or action for each need, recipes); thinr_resource_list type "doc" lists the rest (scripts, playbooks, metrics and logs) and the platform's guides (concepts, product code, server administration, the dashboard SDK).
- Everything is a resource type behind eight tools: thinr_resource_list / _get / _create / _update / _delete / _clone and thinr_resource_call (actions), described by thinr_resource_describe: the server's (device, product, bucket, token, alarm…), data and files (bucket_data, storage_file, device_resource) and ThinRemote's: device_fs (a device's files and folders, ids {"device", "path"}), device_script (ids {"device", "script"}), product_script and product_playbook (ids {"product", "script"} and {"product", "playbook"}; playbook actions validate, run and rollout). Actions on devices: exec, agent_update, agent_install (the command that installs the agent). Each type's ids, filter, bodies, actions and ready-to-send examples are in thinr_resource_describe with that type: read it before the first call on a type.
- A record is located by \`ids\`, one key per level; the records the tools answer carry their ids: pass them back as they are.
- Shell commands: thinr_resource_call type "device" action "exec", with ids {"device": <id>} for one device, or without ids and body devices, product (and group), group or all for several; body.command; body.dry_run lists the targets first.
- Monitoring: live with thinr_resource_call type "device_resource" action "call" ids {"device": <device>, "resource": "monitoring"}; history with thinr_resource_list type "bucket_data" ids {"bucket": "monitoring"} (filter {"device": <device>} for one), stored only for devices of products that have that bucket (ThinRemote products do).
- Fleet metrics and log sources of thinr's terminal dashboard: the product properties "dashboard_metrics" and "logs" (thinr_resource_describe type "product_property" shows their shape).
- List before acting to discover ids; never guess them. Deletes act immediately: confirm with the user first. Fleet changes (exec on several devices, playbook rollouts and runs on several devices) answer their targets first: show them to the user and repeat the call with confirm: true in the body only if they agree.
- Every tool takes an optional \`profile\` (another configured server or account, see thinr_resource_list type "profile"; read what each profile is for in its description before using one other than the default) and most take \`user\` (another account, admin only).`;
