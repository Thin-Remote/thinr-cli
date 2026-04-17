// @ts-check

/**
 * Catalogue of playbook actions the runner knows how to execute.
 *
 * Each entry declares the parameters it accepts (name, type, required
 * flag, human description). The runner uses this for validation, the
 * MCP surface uses it to advertise what playbooks can do, and the CLI
 * uses it for dry-run labels and error messages.
 *
 * Action handlers live in ./actions.js; names must match.
 *
 * @typedef {{ name: string, type: 'string' | 'number' | 'boolean' | 'object', required?: boolean, description: string }} ParamSpec
 * @typedef {{ name: string, description: string, params: ParamSpec[], summary: (params: Record<string, unknown>) => string }} ActionSpec
 */

/** @type {ActionSpec[]} */
export const ACTIONS = [
    {
        name: 'exec',
        description: 'Run a shell command on the device and fail the step on non-zero exit.',
        params: [
            { name: 'command', type: 'string', required: true, description: 'Shell command to run.' },
            { name: 'timeout', type: 'number', description: 'Per-device timeout in seconds (default: 30).' },
        ],
        summary: (p) => `exec: ${p.command}`,
    },
    {
        name: 'sleep',
        description: 'Pause execution for the given number of seconds before the next step.',
        params: [
            { name: 'seconds', type: 'number', required: true, description: 'Seconds to sleep.' },
        ],
        summary: (p) => `sleep ${p.seconds}s`,
    },
    {
        name: 'write',
        description: 'Write a file on the device. Content comes from `content` or from a local file via `content_file`.',
        params: [
            { name: 'path', type: 'string', required: true, description: 'Absolute path on the device.' },
            { name: 'content', type: 'string', description: 'Inline content to write.' },
            { name: 'content_file', type: 'string', description: 'Local file whose content should be uploaded.' },
        ],
        summary: (p) => `write ${p.path}`,
    },
    {
        name: 'delete',
        description: 'Delete a file or directory on the device.',
        params: [
            { name: 'path', type: 'string', required: true, description: 'Absolute path on the device.' },
            { name: 'recursive', type: 'boolean', description: 'Recurse into directories (default: true).' },
        ],
        summary: (p) => `delete ${p.path}`,
    },
    {
        name: 'property_set',
        description: 'Create or overwrite a device property.',
        params: [
            { name: 'property', type: 'string', required: true, description: 'Property name.' },
            { name: 'value', type: 'object', required: true, description: 'Any JSON-serialisable value.' },
        ],
        summary: (p) => `property_set ${p.property}`,
    },
    {
        name: 'resource',
        description: 'Invoke a device resource. Inputs are forwarded as the resource payload.',
        params: [
            { name: 'resource', type: 'string', required: true, description: 'Resource name.' },
            { name: 'inputs', type: 'object', description: 'Resource inputs (omit for read-only resources).' },
        ],
        summary: (p) => `resource ${p.resource}`,
    },
    {
        name: 'update',
        description: 'Check for or apply an agent update.',
        params: [
            { name: 'op', type: 'string', required: true, description: '"check" or "apply".' },
            { name: 'channel', type: 'string', description: 'Update channel (default: "latest").' },
        ],
        summary: (p) => `update ${p.op}`,
    },
    {
        name: 'script_install',
        description: 'Install or replace a custom script on the device. Triggers a scripts reload.',
        params: [
            { name: 'name', type: 'string', required: true, description: 'Script filename (e.g. "battery.sh").' },
            { name: 'content', type: 'string', description: 'Inline script source.' },
            { name: 'content_file', type: 'string', description: 'Local file with the script source.' },
        ],
        summary: (p) => `script_install ${p.name}`,
    },
    {
        name: 'script_delete',
        description: 'Remove a custom script from the device.',
        params: [
            { name: 'name', type: 'string', required: true, description: 'Script filename.' },
        ],
        summary: (p) => `script_delete ${p.name}`,
    },
];

/** Map from action name to spec, computed once for O(1) lookup. */
export const ACTION_BY_NAME = Object.fromEntries(ACTIONS.map((a) => [a.name, a]));

/**
 * JSON-shaped summary of the accepted playbook format. Consumed by the
 * MCP `thinr_playbook_schema` tool so an AI agent can author playbooks
 * that validate on the first try.
 */
export function playbookSchema() {
    return {
        version: 1,
        description:
            'ThinR playbook — declarative sequence of agent-backed actions executed in parallel across a fleet.',
        document: {
            name: 'Optional human-readable name.',
            description: 'Optional longer description.',
            target: {
                product: 'Product ID (use instead of `devices`).',
                group: 'Optional asset group filter.',
                devices: 'Optional explicit list of device IDs.',
                concurrency: 'Max parallel devices (default: 10).',
                fail_fast: 'Abort the whole run on the first step failure (default: false).',
            },
            vars: 'Plain key/value map. Referenced in step params with `{{ var }}`.',
            steps: 'Ordered list of steps, executed sequentially on each device.',
        },
        step: {
            name: 'Human-readable label shown in the summary.',
            action: 'Action name — one of the actions below.',
            pause_after: 'Optional seconds to wait after this step completes.',
            when: 'Optional boolean expression. When present and falsy the step is skipped. See `when_expression` below for supported syntax.',
            register: 'Optional identifier. When set, the step outcome is exposed under that name to later `when` expressions and string interpolation as `{ ok, result | error, duration_ms }`.',
            '...': 'Additional fields are the action parameters (see `actions` below).',
        },
        when_expression: {
            syntax:
                'Minimal boolean mini-language: `==`, `!=`, `>`, `<`, `>=`, `<=`, `and`, `or`, `not`, parentheses; literals for strings (single or double quoted), numbers, `true`, `false`, `null`; dotted identifier paths resolve against the current scope.',
            examples: [
                'env == "prod"',
                'check.ok and agent.version != "1.6.0"',
                'not dry_run',
            ],
        },
        actions: ACTIONS.map((a) => ({
            name: a.name,
            description: a.description,
            params: a.params,
        })),
        variable_interpolation: {
            syntax: '{{ name }}',
            scope: 'Anything from the top-level `vars` block, plus the implicit `device` (current device ID).',
            applies_to: 'String parameter values. Non-string values are passed through verbatim.',
        },
    };
}
