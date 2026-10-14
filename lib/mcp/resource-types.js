// @ts-check
import { readFile as readLocalFile, writeFile as writeLocalFile } from 'fs/promises';
import { basename, posix, resolve as resolvePath } from 'path';
import {
    callDeviceResource,
    getDeviceResources,
    readDeviceResource,
} from '@thinger-io/cli-core/resource';
import { inputError } from '@thinger-io/cli-core/errors';
import { toolName } from '@thinger-io/cli-core/mcp/naming';
import {
    deleteProductPlaybook,
    findProductPlaybook,
    installProductScript,
    listDashboardMetrics,
    listProductPlaybooks,
    listProductScripts,
    readProductPlaybook,
    readProductScript,
    removeDashboardMetric,
    removeProductScript,
    upsertDashboardMetric,
    uploadProductPlaybook,
} from '../product.js';
import { addLogSource, getProductLogs, listPresets, removeLogSource } from '../product/logs.js';
import { getAPI } from './helpers.js';
import { agentInstallCommand } from './agent-install.js';
import {
    DEFAULT_FAILURE_THRESHOLD,
    playbookSchema,
    toolPlaybookRun,
    toolPlaybookValidate,
    toolProductPlaybookRollout,
    toolProductPlaybookRun,
} from './playbook-ops.js';

/**
 * ThinRemote's own resources, served by the generic `resource_*` tools of
 * cli-core next to the server's: a device's file system and scripts, and
 * a product's scripts, dashboard metrics, log sources and playbooks. Plus
 * two actions on the server's `device` type: updating the agent and the
 * command that installs it.
 *
 * Create fails when the record is already there and update when it is
 * not, as on the server; a file of `device_fs` is written either way.
 */

/** @typedef {import('@thinger-io/cli-core/mcp/tools-resource').LocalType} LocalType */
/** @typedef {import('@thinger-io/cli-core/mcp/tools-resource').LocalAction} LocalAction */

const exists = (what, id, where) =>
    inputError(`${what} "${id}" already exists on ${where}: update it instead`);
const missing = (what, id, where) => {
    const e = inputError(`No ${what} "${id}" on ${where}`);
    return Object.assign(e, { code: 'not_found' });
};
const objectBody = (body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw inputError('body must be a JSON object');
    }
    return body;
};

// ─── device_fs ──────────────────────────────────────────────────────

/** Bytes that are not text: a NUL in the first few KB. */
const isBinary = (buf) => buf.subarray(0, 8192).includes(0);

/** @type {LocalType} */
const deviceFs = {
    description:
        'Files and folders of a device with the agent: list a folder, read, write, delete; move, push and pull are actions.',
    parent: 'device',
    id: 'path',
    schema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Absolute path on the device (the id).' },
            content: { type: 'string', description: 'Text to write (create, update).' },
            type: {
                type: 'string',
                enum: ['file', 'directory'],
                description: 'create only: "directory" creates a folder (default file).',
            },
        },
    },
    notes: 'Paths are absolute on the device and act as the agent\'s OS user (root for a system install; check before writing to /etc). resource_list takes filter {path: "<folder>", include_hidden?: true} (default "/", which means the agent\'s working directory, normally the root). resource_get reads a text file; binary files are copied with the pull action. resource_create writes a file (body {content}) or creates a folder (body {type: "directory"}); resource_update writes a file whether it exists or not; resource_delete deletes a file or a folder with all it holds.',
    async list(ctx) {
        const { api } = getAPI(ctx.parent, ctx.user);
        const dir = ctx.filter?.path || '/';
        const entries = await api.listDir(dir, !!ctx.filter?.include_hidden);
        return entries.map((e) => ({
            name: e.name,
            path: posix.join(dir, e.name),
            type: e.type === 'directory' ? 'directory' : 'file',
            size: e.size ?? 0,
            ...(e.mode ? { mode: e.mode } : {}),
        }));
    },
    async get(ctx) {
        const { api } = getAPI(ctx.parent, ctx.user);
        const buf = await api.readFile(ctx.id);
        if (isBinary(buf)) {
            return `Binary file of ${buf.byteLength} bytes: copy it to this machine with ${toolName('resource_call')} action "pull".`;
        }
        return buf.toString('utf8');
    },
    async create(body, ctx) {
        const { api } = getAPI(ctx.parent, ctx.user);
        if (body.type === 'directory') {
            await api.mkdir(ctx.id);
            return 'Folder created.';
        }
        if (typeof body.content !== 'string') {
            throw inputError('body.content (text) is required, or type "directory" for a folder');
        }
        await api.writeFile(ctx.id, Buffer.from(body.content, 'utf8'));
        return `Wrote ${Buffer.byteLength(body.content)} bytes.`;
    },
    async update(body, ctx) {
        if (typeof body.content !== 'string') throw inputError('body.content (text) is required');
        const { api } = getAPI(ctx.parent, ctx.user);
        await api.writeFile(ctx.id, Buffer.from(body.content, 'utf8'));
        return `Wrote ${Buffer.byteLength(body.content)} bytes.`;
    },
    async delete(ctx) {
        const { api } = getAPI(ctx.parent, ctx.user);
        await api.delete(ctx.id, true);
    },
    actions: {
        move: {
            description:
                'Move or rename the path `id` to body.destination; body.overwrite replaces what is there. Write to a temporary file and move it into place for a change that is never seen half done.',
            body: {
                type: 'object',
                properties: { destination: { type: 'string' }, overwrite: { type: 'boolean' } },
                required: ['destination'],
            },
            async run(body, ctx) {
                const { destination, overwrite } = objectBody(body);
                if (!destination) throw inputError('body.destination is required');
                const { api } = getAPI(ctx.parent, ctx.user);
                await api.move(ctx.id, destination, !!overwrite);
                return `Moved ${ctx.id} → ${destination}.`;
            },
        },
        push: {
            description:
                'Copy a file of the machine running this MCP server (body.source) to the device (body.destination; ending in "/" keeps the name). For binary or large files.',
            on: 'collection',
            body: {
                type: 'object',
                properties: { source: { type: 'string' }, destination: { type: 'string' } },
                required: ['source', 'destination'],
            },
            async run(body, ctx) {
                const { source, destination } = objectBody(body);
                if (!source || !destination) {
                    throw inputError('body.source (local) and body.destination are required');
                }
                const local = resolvePath(source);
                const remote = destination.endsWith('/')
                    ? destination + basename(local)
                    : destination;
                const content = await readLocalFile(local);
                const { api } = getAPI(ctx.parent, ctx.user);
                await api.writeFile(remote, content);
                return `Pushed ${content.byteLength} bytes: ${local} → ${remote}.`;
            },
        },
        pull: {
            description:
                'Copy the file `id` of the device to the machine running this MCP server (body.destination; ending in "/" keeps the name).',
            body: {
                type: 'object',
                properties: { destination: { type: 'string' } },
                required: ['destination'],
            },
            async run(body, ctx) {
                const { destination } = objectBody(body);
                if (!destination) throw inputError('body.destination (local) is required');
                const local = destination.endsWith('/')
                    ? resolvePath(destination, basename(ctx.id))
                    : resolvePath(destination);
                const { api } = getAPI(ctx.parent, ctx.user);
                const buf = await api.readFile(ctx.id);
                await writeLocalFile(local, buf);
                return `Pulled ${buf.byteLength} bytes: ${ctx.id} → ${local}.`;
            },
        },
    },
};

// ─── device_script ──────────────────────────────────────────────────

const SCRIPT_NAME = /^[A-Za-z0-9._-]+$/;

async function scriptsInfo(device, user) {
    const info = await readDeviceResource(device, '$scripts/info', { user });
    if (!info?.path) {
        throw new Error('The agent did not return a scripts folder (is $scripts/info supported?)');
    }
    return { dir: info.path, scripts: Array.isArray(info.scripts) ? info.scripts : [] };
}

/** A script by the name the agent reports (`battery`) or its file (`battery.sh`). */
const findScript = (scripts, name) => {
    const stem = name.replace(/\.[^./]+$/, '');
    return scripts.find((s) => s.name === stem || s.path?.endsWith(`/${name}`));
};

async function installDeviceScript(body, ctx, { replace }) {
    const name = ctx.id;
    if (!SCRIPT_NAME.test(name)) {
        throw inputError(`Invalid script name "${name}" (letters, digits, dot, dash, underscore)`);
    }
    if (typeof body.content !== 'string') throw inputError('body.content (the script) is required');
    const { dir, scripts } = await scriptsInfo(ctx.parent, ctx.user);
    const current = findScript(scripts, name);
    if (current && !replace) throw exists('script', name, `device ${ctx.parent}`);
    if (!current && replace) throw missing('script', name, `device ${ctx.parent}`);
    const resource = name.replace(/\.[^./]+$/, '');
    // The agent registers scripts at the root of the device's resources: a
    // script named after a built-in one replaces it, and the device stops
    // answering the real one.
    if (!current && !body.force) {
        const native = await getDeviceResources(ctx.parent, { user: ctx.user }).catch(() => ({}));
        if (Object.prototype.hasOwnProperty.call(native, resource)) {
            throw inputError(
                `"${resource}" is already a resource of this device and the script would replace it: rename it, or pass force: true if that is the intent`,
            );
        }
    }
    const path = current?.path || `${dir}/${name}`;
    const { api } = getAPI(ctx.parent, ctx.user);
    await api.writeFile(path, body.content, true);
    const chmod = await api.exec(`chmod +x ${JSON.stringify(path)}`, 10);
    if (chmod.retcode !== 0) {
        throw new Error(`chmod +x failed: ${chmod.stderr || `exit ${chmod.retcode}`}`);
    }
    const reloaded = await callDeviceResource(
        ctx.parent,
        '$scripts/reload',
        {},
        { user: ctx.user },
    );
    const found = (reloaded?.scripts || []).find((s) => s.name === resource);
    return [
        `Script at ${path}; resource "${resource}": call it with ${toolName('device_resource_call')}.`,
        found?.describe
            ? `Schema: ${JSON.stringify(found.describe)}`
            : 'Schema: none (the script does not answer --describe): any input, raw output.',
    ].join('\n');
}

/** @type {LocalType} */
const deviceScript = {
    description:
        'Scripts installed on a device with the agent: each becomes a resource of the device (battery.sh → "battery").',
    parent: 'device',
    id: 'name',
    schema: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'File name (the id); without extension it names the resource.',
            },
            content: { type: 'string', description: 'Script source, shebang included.' },
            force: {
                type: 'boolean',
                description:
                    'Install even if it replaces a built-in resource (cmd, monitoring, update…).',
            },
        },
    },
    notes: 'A script runs with the agent\'s privileges (root for a system install): installing one grants permanent remote execution of that code. Contract (--describe, JSON on stdin and stdout): {tool:doc_read} id "thinremote-scripts". For every device of a product use type "product_script" instead.',
    async list(ctx) {
        const { scripts } = await scriptsInfo(ctx.parent, ctx.user);
        return scripts.map((s) => ({
            name: s.name,
            path: s.path,
            ...(s.describe ? { describe: s.describe } : {}),
        }));
    },
    async get(ctx) {
        const { scripts } = await scriptsInfo(ctx.parent, ctx.user);
        const script = findScript(scripts, ctx.id);
        if (!script) throw missing('script', ctx.id, `device ${ctx.parent}`);
        const { api } = getAPI(ctx.parent, ctx.user);
        const content = (await api.readFile(script.path)).toString('utf8');
        return { ...script, content };
    },
    create: (body, ctx) => installDeviceScript(body, ctx, { replace: false }),
    update: (body, ctx) => installDeviceScript(body, ctx, { replace: true }),
    async delete(ctx) {
        const { scripts } = await scriptsInfo(ctx.parent, ctx.user);
        const script = findScript(scripts, ctx.id);
        if (!script) {
            const names = scripts.map((s) => s.name).join(', ') || 'none';
            throw missing('script', ctx.id, `device ${ctx.parent} (it has: ${names})`);
        }
        const { api } = getAPI(ctx.parent, ctx.user);
        await api.delete(script.path, false);
        await callDeviceResource(ctx.parent, '$scripts/reload', {}, { user: ctx.user });
        return `Its resource "${script.name}" is gone.`;
    },
};

// ─── product_script ─────────────────────────────────────────────────

async function writeProductScript(body, ctx, { replace }) {
    const there = (await listProductScripts(ctx.parent, ctx.user)).some((s) => s.name === ctx.id);
    if (there && !replace) throw exists('script', ctx.id, `product ${ctx.parent}`);
    if (!there && replace) throw missing('script', ctx.id, `product ${ctx.parent}`);
    const { steps, stem } = await installProductScript({
        product: ctx.parent,
        name: ctx.id,
        content: body.content,
        input: body.input,
        output: body.output,
        user: ctx.user,
    });
    return [
        ...steps.map((s) => `- ${s}`),
        `Call it on any device of the product: ${toolName('device_resource_call')} resource "${stem}".`,
    ].join('\n');
}

/** @type {LocalType} */
const productScript = {
    description:
        'Scripts of a product: kept once in its storage, they run on any of its devices as a product API resource named after the file (backup.sh → "backup").',
    parent: 'product',
    id: 'name',
    schema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'File name (the id), e.g. "backup.sh".' },
            content: { type: 'string', description: 'Script source.' },
            input: {
                type: 'object',
                description:
                    'Input fields and their defaults ({"path": "/var"}); omit for a free-form payload.',
            },
            output: {
                type: 'boolean',
                description:
                    'Whether it answers JSON on stdout (default true); false for fire-and-forget.',
            },
        },
    },
    notes: 'Writing one sets up all it needs (storage, wrapper, product code, API resource); the product must exist. Records listed with registered: false are files without their API resource. Contract and examples: {tool:doc_read} id "thinremote-scripts".',
    list: (ctx) => listProductScripts(ctx.parent, ctx.user),
    async get(ctx) {
        return { name: ctx.id, content: await readProductScript(ctx.parent, ctx.id, ctx.user) };
    },
    create: (body, ctx) => writeProductScript(body, ctx, { replace: false }),
    update: (body, ctx) => writeProductScript(body, ctx, { replace: true }),
    async delete(ctx) {
        const { steps } = await removeProductScript({
            product: ctx.parent,
            name: ctx.id,
            user: ctx.user,
        });
        return steps.map((s) => `- ${s}`).join('\n');
    },
};

// ─── product_metric ─────────────────────────────────────────────────

const METRIC_FIELDS = [
    'label',
    'resource',
    'field',
    'aggregation',
    'visualization',
    'interval',
    'unit',
];

async function writeMetric(body, ctx, { replace }) {
    const list = await listDashboardMetrics(ctx.parent, ctx.user);
    const current = list.find((m) => m.name === ctx.id);
    if (current && !replace) throw exists('metric', ctx.id, `product ${ctx.parent}`);
    if (!current && replace) throw missing('metric', ctx.id, `product ${ctx.parent}`);
    const metric = { ...(current || {}), name: ctx.id };
    for (const k of METRIC_FIELDS) if (body[k] !== undefined) metric[k] = body[k];
    const { count } = await upsertDashboardMetric(ctx.parent, metric, ctx.user);
    return `The product has ${count} metric(s).`;
}

/** @type {LocalType} */
const productMetric = {
    description:
        "Metrics of thinr's terminal dashboard for a product (not a console dashboard): a value asked to every device and combined across the fleet.",
    parent: 'product',
    id: 'name',
    schema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Metric id.' },
            label: { type: 'string', description: 'Shown in the panel.' },
            resource: {
                type: 'string',
                description:
                    'Product API resource asked to each device (usually a product script). Required.',
            },
            field: {
                type: 'string',
                description: 'Dot path to the value in the answer; omit for scalars.',
            },
            aggregation: {
                type: 'string',
                enum: ['sum', 'avg', 'max', 'min', 'count', 'top', 'none', 'distribution'],
                description:
                    'How the devices\' values combine; "distribution" counts devices per value (versions, kernels).',
            },
            visualization: {
                type: 'string',
                enum: ['kpi', 'bar', 'sparkline', 'list'],
                description: 'kpi (default), sparkline (trend), list (pairs with distribution).',
            },
            interval: {
                type: 'number',
                description: 'Seconds between refreshes; omit to only relay what devices push.',
            },
            unit: { type: 'string', description: 'Suffix shown with the value ("%").' },
        },
        required: ['resource'],
    },
    notes: 'Kept in the product property "dashboard_metrics": change them here, not through the property. Recipe: {tool:doc_read} id "thinremote-metrics-logs".',
    list: (ctx) => listDashboardMetrics(ctx.parent, ctx.user),
    async get(ctx) {
        const metric = (await listDashboardMetrics(ctx.parent, ctx.user)).find(
            (m) => m.name === ctx.id,
        );
        if (!metric) throw missing('metric', ctx.id, `product ${ctx.parent}`);
        return metric;
    },
    create: (body, ctx) => writeMetric(body, ctx, { replace: false }),
    update: (body, ctx) => writeMetric(body, ctx, { replace: true }),
    async delete(ctx) {
        const { action } = await removeDashboardMetric(ctx.parent, ctx.id, ctx.user);
        if (action !== 'removed') throw missing('metric', ctx.id, `product ${ctx.parent}`);
    },
};

// ─── product_log_source ─────────────────────────────────────────────

async function logSources(product, user) {
    const cfg = await getProductLogs(product, user);
    const fallback = !!(/** @type {any} */ (cfg).__fallback);
    const def = cfg.default || cfg.sources[0]?.name || null;
    return {
        fallback,
        sources: cfg.sources.map((s) => ({
            ...s,
            default: s.name === def,
            ...(fallback ? { fallback: true } : {}),
        })),
    };
}

async function writeLogSource(body, ctx, { replace }) {
    const { sources, fallback } = await logSources(ctx.parent, ctx.user);
    const current = fallback ? undefined : sources.find((s) => s.name === ctx.id);
    if (current && !replace) throw exists('log source', ctx.id, `product ${ctx.parent}`);
    if (!current && replace) throw missing('log source', ctx.id, `product ${ctx.parent}`);
    const command = body.command ?? current?.command;
    if (typeof command !== 'string' || !command.trim()) {
        throw inputError('body.command is required');
    }
    const { config } = await addLogSource(
        ctx.parent,
        {
            name: ctx.id,
            command,
            makeDefault: !!body.default,
            pattern: body.pattern ?? current?.pattern,
            preset: body.preset ?? current?.preset,
        },
        ctx.user,
    );
    const def = config.default || config.sources[0]?.name;
    return `The product has ${config.sources.length} log source(s); default: ${def}.`;
}

/** @type {LocalType} */
const productLogSource = {
    description:
        "Log sources of a product: named shell commands the agent streams when someone opens a device's logs in thinr.",
    parent: 'product',
    id: 'name',
    schema: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'Source id (letters, digits, _ and -; up to 32).',
            },
            command: {
                type: 'string',
                description:
                    'What the agent runs and streams: "journalctl -f", "docker logs -f app", "tail -F <file>".',
            },
            default: {
                type: 'boolean',
                description: 'Shown first (and by `thinr device logs` without --source).',
            },
            preset: {
                type: 'string',
                description: 'Named line format for structured rendering (see presets below).',
            },
            pattern: {
                type: 'string',
                description: 'Or a regex with named groups time, level and msg (not with preset).',
            },
        },
        required: ['command'],
    },
    notes: 'Without any source a product shows one `system` journal source, listed with fallback: true; removing the last one brings it back. Details: {tool:doc_read} id "thinremote-metrics-logs".',
    describe: () => ({
        presets: Object.fromEntries(listPresets().map((p) => [p.name, p.description])),
    }),
    list: async (ctx) => (await logSources(ctx.parent, ctx.user)).sources,
    async get(ctx) {
        const source = (await logSources(ctx.parent, ctx.user)).sources.find(
            (s) => s.name === ctx.id,
        );
        if (!source) throw missing('log source', ctx.id, `product ${ctx.parent}`);
        return source;
    },
    create: (body, ctx) => writeLogSource(body, ctx, { replace: false }),
    update: (body, ctx) => writeLogSource(body, ctx, { replace: true }),
    async delete(ctx) {
        const { removed, config } = await removeLogSource(ctx.parent, ctx.id, ctx.user);
        if (!removed) throw missing('log source', ctx.id, `product ${ctx.parent}`);
        if (config === null)
            return 'It was the last one: the product falls back to the system journal.';
    },
};

// ─── product_playbook ───────────────────────────────────────────────

async function writePlaybook(body, ctx, { replace }) {
    const there = await findProductPlaybook(ctx.parent, ctx.id, ctx.user);
    if (there && !replace) throw exists('playbook', ctx.id, `product ${ctx.parent}`);
    if (!there && replace) throw missing('playbook', ctx.id, `product ${ctx.parent}`);
    const content =
        body.content ?? (there && (await readProductPlaybook(ctx.parent, ctx.id, ctx.user)));
    if (typeof content !== 'string') throw inputError('body.content (the YAML) is required');
    const result = await uploadProductPlaybook({
        product: ctx.parent,
        name: ctx.id,
        content,
        description: body.description ?? there?.description,
        user: ctx.user,
    });
    return result.steps.map((s) => `- ${s}`).join('\n');
}

/** @type {LocalType} */
const productPlaybook = {
    description:
        'Playbooks of a product: YAML steps the agent runs on each device (write a file, run a command, install a script…), validated, tried and rolled out in batches.',
    parent: 'product',
    id: 'name',
    schema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Playbook id (letters, digits, _ and -).' },
            content: {
                type: 'string',
                description: 'The YAML, following `playbook_format` below.',
            },
            description: { type: 'string', description: "Defaults to the YAML's own description." },
        },
    },
    notes: 'Flow: write the YAML following playbook_format, check it with the validate action, save it with resource_create (validated again: nothing is saved if invalid), try it with the run action on one device (dry_run, then check, then for real), then roll it out with the rollout action. The run and validate actions also take an unsaved playbook: no id, the YAML in body.content. Rollouts change real machines: confirm with the user and start with small batches. Guide: {tool:doc_read} id "thinremote-playbooks".',
    describe: () => ({ playbook_format: playbookSchema() }),
    list: (ctx) => listProductPlaybooks(ctx.parent, ctx.user),
    async get(ctx) {
        const entry = await findProductPlaybook(ctx.parent, ctx.id, ctx.user);
        if (!entry) throw missing('playbook', ctx.id, `product ${ctx.parent}`);
        return { ...entry, content: await readProductPlaybook(ctx.parent, ctx.id, ctx.user) };
    },
    create: (body, ctx) => writePlaybook(body, ctx, { replace: false }),
    update: (body, ctx) => writePlaybook(body, ctx, { replace: true }),
    async delete(ctx) {
        const { removed } = await deleteProductPlaybook({
            product: ctx.parent,
            name: ctx.id,
            user: ctx.user,
        });
        if (!removed) throw missing('playbook', ctx.id, `product ${ctx.parent}`);
    },
    actions: {
        validate: {
            description:
                'Check a playbook without running or saving it: a summary, or every issue found. The saved one (`id`) or the YAML in body.content.',
            on: 'either',
            body: { type: 'object', properties: { content: { type: 'string' } } },
            async run(body, ctx) {
                const content = await playbookSource(body, ctx);
                return toolPlaybookValidate({ content });
            },
        },
        run: {
            description:
                'Run a playbook now: the saved one (`id`) or the YAML in body.content. Targets body.device (one device: the pre-flight before a rollout), body.devices, body.group or, by default, every device of the product. body.dry_run gives the plan without contacting devices; body.check contacts them read-only and says what each step would change.',
            on: 'either',
            body: {
                type: 'object',
                properties: {
                    content: { type: 'string', description: 'YAML of an unsaved playbook.' },
                    device: { type: 'string' },
                    devices: { type: 'array', items: { type: 'string' } },
                    group: { type: 'string' },
                    vars: { type: 'object', description: 'Variable overrides (never stored).' },
                    dry_run: { type: 'boolean' },
                    check: { type: 'boolean' },
                    concurrency: { type: 'number' },
                    fail_fast: { type: 'boolean' },
                    continue_on_error: { type: 'boolean' },
                },
            },
            async run(body, ctx) {
                const b = body && typeof body === 'object' ? body : {};
                if (ctx.id && b.device && !b.content) {
                    return toolProductPlaybookRun({
                        product: ctx.parent,
                        name: ctx.id,
                        device_id: b.device,
                        vars: b.vars,
                        dry_run: b.dry_run,
                        check: b.check,
                        user: ctx.user,
                    });
                }
                return toolPlaybookRun({
                    content: await playbookSource(b, ctx),
                    target_product: ctx.parent,
                    target_group: b.group,
                    target_devices: b.device ? [b.device] : b.devices,
                    vars: b.vars,
                    dry_run: b.dry_run,
                    check: b.check,
                    concurrency: b.concurrency,
                    fail_fast: b.fail_fast,
                    continue_on_error: b.continue_on_error,
                    user: ctx.user,
                });
            },
        },
        rollout: {
            description: `Roll the saved playbook \`id\` out across the product's devices in batches of body.batch_size (default 5), stopping when the failure rate reaches body.failure_threshold (percent, default ${DEFAULT_FAILURE_THRESHOLD}). Narrow it with body.group or body.filter; offline devices are skipped unless body.include_offline. body.dry_run lists plan and devices; body.check says what would change. Writes a report to playbooks/runs/ in the product storage. Changes real machines: confirm with the user and try it with run on one device first.`,
            body: {
                type: 'object',
                properties: {
                    batch_size: { type: 'number' },
                    failure_threshold: { type: 'number' },
                    group: { type: 'string' },
                    filter: { type: 'object' },
                    include_offline: { type: 'boolean' },
                    vars: { type: 'object' },
                    dry_run: { type: 'boolean' },
                    check: { type: 'boolean' },
                },
            },
            run(body, ctx) {
                const b = body && typeof body === 'object' ? body : {};
                return toolProductPlaybookRollout({
                    ...b,
                    product: ctx.parent,
                    name: ctx.id,
                    user: ctx.user,
                });
            },
        },
    },
};

/** The YAML an action works on: body.content, or the saved playbook `id`. */
async function playbookSource(body, ctx) {
    if (typeof body?.content === 'string' && body.content.trim()) return body.content;
    if (!ctx.id)
        throw inputError('give the playbook: `id` (saved on the product) or body.content (YAML)');
    const entry = await findProductPlaybook(ctx.parent, ctx.id, ctx.user);
    if (!entry) {
        const names = (await listProductPlaybooks(ctx.parent, ctx.user)).map((e) => e.name);
        throw missing(
            'playbook',
            ctx.id,
            `product ${ctx.parent} (it has: ${names.join(', ') || 'none'})`,
        );
    }
    return readProductPlaybook(ctx.parent, ctx.id, ctx.user);
}

/** @type {Record<string, LocalType>} */
export const resourceTypes = {
    device_fs: deviceFs,
    device_script: deviceScript,
    product_script: productScript,
    product_metric: productMetric,
    product_log_source: productLogSource,
    product_playbook: productPlaybook,
};

/** @type {Record<string, Record<string, LocalAction>>} */
export const resourceActions = {
    device: {
        agent_update: {
            description:
                'Check for a new version of the ThinRemote agent of device `id` (body {action: "check"}) or install it (body {action: "apply", channel?: "latest" | "main" | "develop"}).',
            body: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['check', 'apply'] },
                    channel: { type: 'string' },
                },
                required: ['action'],
            },
            async run(body, ctx) {
                const { action, channel } = objectBody(body);
                if (action !== 'check' && action !== 'apply') {
                    throw inputError('body.action must be "check" or "apply"');
                }
                const { api } = getAPI(ctx.id, ctx.user);
                return api.callResource('update', { action, channel: channel || 'latest' });
            },
        },
        agent_install: {
            description:
                "The one-line shell command that installs the ThinRemote agent on a new machine and registers it as a device, with this profile's token (a credential: share it only through trusted channels). body: device (id; default the hostname), product, channel, sudo, overwrite, no_start, no_verify_ssl, http.",
            on: 'collection',
            body: {
                type: 'object',
                properties: {
                    device: { type: 'string' },
                    product: { type: 'string' },
                    channel: { type: 'string', enum: ['latest', 'main', 'develop'] },
                    sudo: { type: 'boolean' },
                    overwrite: { type: 'boolean' },
                    no_start: { type: 'boolean' },
                    no_verify_ssl: { type: 'boolean' },
                    http: { type: 'boolean' },
                },
            },
            run: (body) => agentInstallCommand(body && typeof body === 'object' ? body : {}),
        },
    },
};
