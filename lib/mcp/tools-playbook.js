// @ts-check
import { parsePlaybook } from '../playbook/loader.js';
import { buildDryRunPlan, resolveTargets, runPlaybook } from '../playbook/runner.js';
import { playbookSchema } from '../playbook/schema.js';
import { inputError } from '../errors.js';

async function toolPlaybookSchema() {
    const schema = playbookSchema();
    return {
        content: [{ type: 'text', text: JSON.stringify(schema, null, 2) }],
        isError: false,
    };
}

async function toolPlaybookValidate(args) {
    if (typeof args.content !== 'string' || !args.content.trim()) {
        throw inputError('content (YAML playbook source) is required');
    }
    try {
        const pb = parsePlaybook(args.content);
        const summary = {
            valid: true,
            name: pb.name,
            description: pb.description,
            target: pb.target,
            steps: pb.steps.map((s) => ({ name: s.name, action: s.action })),
        };
        return {
            content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
            isError: false,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            content: [{ type: 'text', text: msg }],
            isError: true,
            _meta: { code: 'input_error', message: msg },
        };
    }
}

async function toolPlaybookRun(args) {
    if (typeof args.content !== 'string' || !args.content.trim()) {
        throw inputError('content (YAML playbook source) is required');
    }
    const pb = parsePlaybook(args.content);
    if (args.target_product) pb.target.product = args.target_product;
    if (args.target_group) pb.target.group = args.target_group;
    if (Array.isArray(args.target_devices) && args.target_devices.length) {
        pb.target.devices = args.target_devices;
    }
    if (Number.isInteger(args.concurrency) && args.concurrency > 0) {
        pb.target.concurrency = args.concurrency;
    }
    if (typeof args.fail_fast === 'boolean') pb.target.fail_fast = args.fail_fast;
    if (args.vars && typeof args.vars === 'object') {
        pb.vars = { ...pb.vars, ...args.vars };
    }

    if (args.dry_run) {
        const plan = buildDryRunPlan(pb);
        const out = {
            dry_run: true,
            name: pb.name,
            target: pb.target,
            vars: pb.vars,
            steps: plan,
        };
        return {
            content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
            isError: false,
        };
    }

    const devices = await resolveTargets(pb, { user: args.user });
    if (devices.length === 0) {
        return {
            content: [
                {
                    type: 'text',
                    text: `No devices match the playbook target (product="${pb.target.product}"${pb.target.group ? `, group="${pb.target.group}"` : ''}).`,
                },
            ],
            isError: false,
        };
    }

    const checkMode = !!args.check;
    const results = await runPlaybook(pb, devices, {
        user: args.user,
        concurrency: pb.target.concurrency,
        failFast: pb.target.fail_fast,
        checkMode,
        continueOnError: !!args.continue_on_error,
    });

    const okCount = results.filter((r) => r.ok).length;
    let verdicts;
    if (checkMode) {
        verdicts = { changed: 0, unchanged: 0, unknown: 0 };
        for (const r of results) {
            for (const s of r.steps) {
                if (s.verdict && s.verdict in verdicts) verdicts[s.verdict] += 1;
            }
        }
    }
    const summary = {
        name: pb.name,
        target: pb.target,
        mode: checkMode ? 'check' : 'apply',
        total: results.length,
        ok: okCount,
        failed: results.length - okCount,
        ...(verdicts ? { verdicts } : {}),
        results,
    };
    return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
        isError: okCount < results.length,
    };
}

export const tools = [
    {
        name: 'thinr_playbook_schema',
        description: `Return the JSON schema a ThinR playbook document must follow: accepted top-level fields, the target block, the variable substitution syntax, and the full catalogue of step actions with their parameters. Call this once before authoring or editing a playbook so the generated YAML validates on the first try.`,
        inputSchema: {
            type: 'object',
            properties: {},
            required: [],
        },
        handler: toolPlaybookSchema,
    },
    {
        name: 'thinr_playbook_validate',
        description: `Parse and validate a playbook document without running it. Returns a structured summary on success or a consolidated error message listing every issue. Use this to check a freshly authored playbook before calling thinr_playbook_run.`,
        inputSchema: {
            type: 'object',
            properties: {
                content: {
                    type: 'string',
                    description: 'Full YAML source of the playbook.',
                },
            },
            required: ['content'],
        },
        handler: toolPlaybookValidate,
    },
    {
        name: 'thinr_playbook_run',
        description: `Run a playbook (YAML source passed inline) against the product / devices declared in its target block. Optional overrides let you retarget a saved playbook without editing it. Set \`dry_run: true\` to get the execution plan without touching any device.

Response carries a consolidated report: devices visited, ok / failed counts, and per-device step outcomes (summary, duration, error message if any). \`isError\` is true whenever any device didn't complete every step cleanly, so clients can branch on a single flag.`,
        inputSchema: {
            type: 'object',
            properties: {
                content: {
                    type: 'string',
                    description: 'Full YAML source of the playbook.',
                },
                dry_run: {
                    type: 'boolean',
                    description:
                        'Return the static plan without contacting devices (default: false).',
                },
                check: {
                    type: 'boolean',
                    description:
                        'Contact devices read-only and report what each step would change, without writing. Each step verdict is one of "changed" / "unchanged" / "unknown". Actions that can\'t be predicted safely (exec, resource) always return "unknown".',
                },
                target_product: {
                    type: 'string',
                    description: 'Override the playbook\'s target.product.',
                },
                target_group: {
                    type: 'string',
                    description: 'Override the playbook\'s target.group.',
                },
                target_devices: {
                    type: 'array',
                    description: 'Override the playbook\'s target.devices with an explicit list.',
                },
                concurrency: {
                    type: 'number',
                    description: 'Override max parallel devices.',
                },
                fail_fast: {
                    type: 'boolean',
                    description:
                        'Stop dequeueing new devices on the first failure (default: playbook\'s own value).',
                },
                continue_on_error: {
                    type: 'boolean',
                    description:
                        'Keep running subsequent steps on a device even if one step fails (default: false — a failing step stops that device).',
                },
                vars: {
                    type: 'object',
                    description:
                        'Merge into the playbook\'s `vars` block before substitution.',
                },
                user: {
                    type: 'string',
                    description: 'API user (admin impersonation).',
                },
            },
            required: ['content'],
        },
        handler: toolPlaybookRun,
    },
];
