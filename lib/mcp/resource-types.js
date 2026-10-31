// @ts-check
import { readFile as readLocalFile, writeFile as writeLocalFile } from 'fs/promises';
import { basename, posix } from 'path';
import {
    callDeviceResource,
    getDeviceResources,
    readDeviceResource,
} from '@thinger-io/cli-core/resource';
import { getDevices } from '@thinger-io/cli-core/devices';
import { inputError } from '@thinger-io/cli-core/errors';
import { opRef } from '@thinger-io/cli-core/mcp/naming';
import {
    deleteProductPlaybook,
    findProductPlaybook,
    installProductScript,
    listProductPlaybooks,
    listProductScripts,
    readProductPlaybook,
    readProductScript,
    removeProductScript,
    uploadProductPlaybook,
} from '../product.js';
import { localFileToRead, localFileToWrite } from '../local-files.js';
import { getAPI } from './helpers.js';
import { agentInstallCommand } from './agent-install.js';
import { execAction } from './device-exec.js';
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
 * a product's scripts and playbooks. Plus three actions on the server's
 * `device` type: a shell command, updating the agent and the command that
 * installs it. (The product's dashboard metrics and log sources are its
 * product properties `dashboard_metrics` and `logs`: resource-hooks.js.)
 *
 * Create fails when the record is already there and update when it is
 * not, as on the server; a file of `device_fs` is written either way.
 */

/** @typedef {import('@thinger-io/cli-core/mcp/tools-resource').LocalType} LocalType */
/** @typedef {import('@thinger-io/cli-core/mcp/tools-resource').LocalAction} LocalAction */

/**
 * One write at a time per product and kind: the scripts and the playbook
 * index are each read, changed and written back, and a client often sends
 * several creates at once.
 * @type {Map<string, Promise<unknown>>}
 */
const queues = new Map();
function oneAtATime(ctx, kind, fn) {
    const key = JSON.stringify([ctx.user ?? null, ctx.parent, kind]);
    const run = (queues.get(key) || Promise.resolve()).then(fn, fn);
    const settled = run.catch(() => {});
    queues.set(key, settled);
    settled.then(() => queues.get(key) === settled && queues.delete(key));
    return run;
}

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
            path: { type: 'string', description: 'Absolute path on the device (ids.path).' },
            content: { type: 'string', description: 'Text to write (create, update).' },
            type: {
                type: 'string',
                enum: ['file', 'directory'],
                description: 'create only: "directory" creates a folder (default file).',
            },
        },
    },
    notes: 'ids.path is absolute on the device; the tools act as the agent\'s OS user (root for a system install; check before writing to /etc). resource_list takes filter {path: "<folder>", include_hidden?: true} (default "/", which means the agent\'s working directory, normally the root). resource_get reads a text file; binary files are copied with the pull action. resource_create writes a file (body {content}) or creates a folder (body {type: "directory"}); resource_update writes a file whether it exists or not; resource_delete deletes a file or a folder with all it holds, never "/" or a folder right under it (use {op:device.exec} for that). push and pull read and write files of the machine running this MCP server only inside its local folder (THINR_MCP_LOCAL_DIR, or where the server started), and pull replaces a file only with body.overwrite.',
    filter: {
        type: 'object',
        additionalProperties: false,
        properties: {
            path: { type: 'string', description: 'Folder to list (default "/").' },
            include_hidden: { type: 'boolean', description: 'Also dot files.' },
        },
    },
    examples: [
        {
            tool: 'resource_list',
            arguments: { type: 'device_fs', ids: { device: 'gw_1' }, filter: { path: '/etc' } },
            does: 'List /etc on the device gw_1.',
        },
        {
            tool: 'resource_create',
            arguments: {
                type: 'device_fs',
                ids: { device: 'gw_1', path: '/tmp/app.conf' },
                body: { content: 'port=8080\n' },
            },
            does: 'Write a text file on the device.',
        },
    ],
    async list(ctx) {
        const { api } = getAPI(ctx.parent, ctx.user);
        const asked = ctx.filter?.path || '/';
        const entries = await api.listDir(asked, !!ctx.filter?.include_hidden);
        // "/" alone is the agent's working directory, normally the root but
        // not always: give each entry its real path.
        let dir = asked;
        if (posix.normalize(asked) === '/') {
            dir = (await api.info('/').catch(() => null))?.path || '/';
        }
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
            return `Binary file of ${buf.byteLength} bytes: copy it to this machine with ${opRef('device_fs', 'pull')}.`;
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
        // A slip of a path that empties a whole machine: not from here.
        const path = posix.normalize(String(ctx.id));
        if (!path.startsWith('/') || path.split('/').filter(Boolean).length < 2) {
            throw inputError(
                `Not deleting ${ctx.id}: only absolute paths at least two levels deep (/var/tmp/x). For more, ${opRef('device', 'exec')}.`,
            );
        }
        const { api } = getAPI(ctx.parent, ctx.user);
        await api.delete(path, true);
    },
    actions: {
        move: {
            description:
                'Move or rename the path ids.path to body.destination; body.overwrite replaces what is there. Write to a temporary file and move it into place for a change that is never seen half done.',
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
                'Copy a file of the machine running this MCP server (body.source, inside its local folder: see notes) to the device (body.destination; ending in "/" keeps the name). For binary or large files.',
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
                const local = localFileToRead(source);
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
                'Copy the file ids.path of the device to the machine running this MCP server (body.destination, inside its local folder: see notes; ending in "/" keeps the name). An existing file is replaced only with body.overwrite.',
            body: {
                type: 'object',
                properties: { destination: { type: 'string' }, overwrite: { type: 'boolean' } },
                required: ['destination'],
            },
            async run(body, ctx) {
                const { destination, overwrite } = objectBody(body);
                if (!destination) throw inputError('body.destination (local) is required');
                const local = localFileToWrite(
                    destination.endsWith('/') ? destination + basename(ctx.id) : destination,
                    undefined,
                    { overwrite: !!overwrite },
                );
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
    if (current && current.path && basename(current.path) !== name) {
        throw inputError(
            `The script "${current.name}" is ${basename(current.path)}: use that id (delete it first to change its language)`,
        );
    }
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
        `Script at ${path}; resource "${resource}": call it with ${opRef('device_resource', 'call')} ids {"device": "${ctx.parent}", "resource": "${resource}"}.`,
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
    id: 'script',
    bodyId: 'name',
    schema: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'File name (ids.script); without extension it names the resource.',
            },
            content: { type: 'string', description: 'Script source, shebang included.' },
            force: {
                type: 'boolean',
                description:
                    'Install even if it replaces a built-in resource (cmd, monitoring, update…).',
            },
        },
    },
    notes: 'ids.script is the file name with its extension ("uptime.sh"), in create, update and delete alike; the resource it becomes is named without it ("uptime"). Scripts run on whatever OS the device has: check it (resource_get of the device, agent.system_info) before relying on /proc or GNU tools. A script runs with the agent\'s privileges (root for a system install): installing one grants permanent remote execution of that code. Contract (--describe, JSON on stdin and stdout): {op:doc.get} ids {"doc": "thinremote-scripts"}. For every device of a product use type "product_script" instead.',
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
    // One API resource per stem: backup.sh and backup.py would share one.
    const stem = String(ctx.id).replace(/\.[^.]+$/, '');
    const same = (await listProductScripts(ctx.parent, ctx.user)).find((s) => s.stem === stem);
    if (same && same.name !== ctx.id) {
        throw inputError(
            `The resource "${stem}" is already the script ${same.name}: use that id, or delete it first`,
        );
    }
    if (same && !replace) throw exists('script', ctx.id, `product ${ctx.parent}`);
    if (!same && replace) throw missing('script', ctx.id, `product ${ctx.parent}`);
    const { steps } = await installProductScript({
        product: ctx.parent,
        name: ctx.id,
        content: body.content,
        input: body.input,
        output: body.output,
        user: ctx.user,
    });
    return [
        ...steps.map((s) => `- ${s}`),
        `Call it on any device of the product: ${opRef('device_resource', 'call')} ids {"device": <device>, "resource": "${stem}"}.`,
    ].join('\n');
}

/** @type {LocalType} */
const productScript = {
    description:
        'Scripts of a product: kept once in its storage, they run on any of its devices as a product API resource named after the file (backup.sh → "backup").',
    parent: 'product',
    id: 'script',
    bodyId: 'name',
    schema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'File name (ids.script), e.g. "backup.sh".' },
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
    notes: 'Writing one sets up all it needs (storage, wrapper, product code, API resource); the product must exist. Records listed with registered: false are files without their API resource. Contract and examples: {op:doc.get} ids {"doc": "thinremote-scripts"}.',
    list: (ctx) => listProductScripts(ctx.parent, ctx.user),
    async get(ctx) {
        return { name: ctx.id, content: await readProductScript(ctx.parent, ctx.id, ctx.user) };
    },
    create: (body, ctx) =>
        oneAtATime(ctx, 'script', () => writeProductScript(body, ctx, { replace: false })),
    update: (body, ctx) =>
        oneAtATime(ctx, 'script', () => writeProductScript(body, ctx, { replace: true })),
    async delete(ctx) {
        const { steps } = await oneAtATime(ctx, 'script', () =>
            removeProductScript({ product: ctx.parent, name: ctx.id, user: ctx.user }),
        );
        return steps.map((s) => `- ${s}`).join('\n');
    },
};

// ─── product_playbook ───────────────────────────────────────────────

/** What resource_describe shows next to the format: fields at the top level. */
const PLAYBOOK_EXAMPLE = `name: app-config
description: Deploy app.conf and restart the service
target:
    product: gateways
vars:
    port: { default: 8080, type: number, description: Listening port }
steps:
    - name: Write it to a temporary file
      action: write
      path: /tmp/app.conf.new
      content: "port={{ port }}"
    - name: Move it into place
      action: move
      source: /tmp/app.conf.new
      destination: /etc/app.conf
      overwrite: true
    - name: Restart
      action: exec
      command: systemctl restart app
`;

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
    id: 'playbook',
    bodyId: 'name',
    schema: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'Playbook id (ids.playbook; letters, digits, _ and -).',
            },
            content: {
                type: 'string',
                description: 'The YAML, following `playbook_format` below.',
            },
            description: { type: 'string', description: "Defaults to the YAML's own description." },
        },
    },
    notes: 'Flow: write the YAML following playbook_format, check it with the validate action, save it with resource_create (validated again: nothing is saved if invalid), try it with the run action on one device (dry_run, then check, then for real), then roll it out with the rollout action. The run and validate actions also take an unsaved playbook: no ids.playbook, the YAML in body.content. Rollouts and runs on several devices change real machines: they answer their plan first, run with confirm: true once the user agrees; start with small batches. Guide: {op:doc.get} ids {"doc": "thinremote-playbooks"}.',
    examples: [
        {
            tool: 'resource_call',
            arguments: {
                type: 'product_playbook',
                action: 'run',
                ids: { product: 'gateways', playbook: 'app-config' },
                body: { device: 'gw_1', check: true },
            },
            does: 'Contact one device read-only and say what each step of the saved playbook would change.',
        },
    ],
    describe: () => {
        // The schema calls the top-level fields "document": said plainly,
        // with an example, so nobody nests them under a `document:` key.
        const { document, ...rest } = playbookSchema();
        return {
            playbook_format: { top_level_fields: document, ...rest },
            playbook_example: PLAYBOOK_EXAMPLE,
        };
    },
    list: (ctx) => listProductPlaybooks(ctx.parent, ctx.user),
    async get(ctx) {
        const entry = await findProductPlaybook(ctx.parent, ctx.id, ctx.user);
        if (!entry) throw missing('playbook', ctx.id, `product ${ctx.parent}`);
        return { ...entry, content: await readProductPlaybook(ctx.parent, ctx.id, ctx.user) };
    },
    create: (body, ctx) =>
        oneAtATime(ctx, 'playbooks', () => writePlaybook(body, ctx, { replace: false })),
    update: (body, ctx) =>
        oneAtATime(ctx, 'playbooks', () => writePlaybook(body, ctx, { replace: true })),
    async delete(ctx) {
        const { removed } = await oneAtATime(ctx, 'playbooks', () =>
            deleteProductPlaybook({ product: ctx.parent, name: ctx.id, user: ctx.user }),
        );
        if (!removed) throw missing('playbook', ctx.id, `product ${ctx.parent}`);
    },
    actions: {
        validate: {
            description:
                'Check a playbook without running or saving it: a summary, or every issue found. The saved one (ids.playbook) or the YAML in body.content.',
            on: 'either',
            body: { type: 'object', properties: { content: { type: 'string' } } },
            async run(body, ctx) {
                const content = await playbookSource(body, ctx);
                return toolPlaybookValidate({ content });
            },
        },
        run: {
            description:
                'Run a playbook now, on the target given: body.device (one device: the pre-flight before a rollout), body.devices (of this product), body.group, or body.all: true for every device of the product at once (no batches or failure threshold: for a fleet, prefer rollout; on several devices it answers its targets until confirmed). The playbook is the saved one (ids.playbook) or the YAML in body.content. body.dry_run gives the plan without contacting devices; body.check contacts them read-only and says what each step would change. body.vars overrides its variables (checked against what it declares).',
            on: 'either',
            confirm: true,
            body: {
                type: 'object',
                properties: {
                    content: { type: 'string', description: 'YAML of an unsaved playbook.' },
                    device: { type: 'string' },
                    devices: { type: 'array', items: { type: 'string' } },
                    group: { type: 'string' },
                    all: { type: 'boolean', description: 'Every device of the product.' },
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
                const listed = Array.isArray(b.devices) && b.devices.length > 0;
                const targets = [b.device, listed, b.group, b.all === true].filter(Boolean);
                if (targets.length !== 1) {
                    throw inputError(
                        'give one target in the body: device (one device), devices, group, or all: true (every device of the product; for a fleet prefer the rollout action)',
                    );
                }
                if (listed) {
                    const ids = new Set(
                        (await getDevices({ product: ctx.parent }, ctx.user)).map((d) => d.device),
                    );
                    const foreign = b.devices.filter((d) => !ids.has(d));
                    if (foreign.length) {
                        throw inputError(`Not devices of ${ctx.parent}: ${foreign.join(', ')}`);
                    }
                }
                if (!b.device && !b.dry_run && !b.check && !ctx.confirmed && ctx.plan) {
                    const which = listed
                        ? `the devices ${b.devices.join(', ')}`
                        : await groupDevices(ctx, b.group);
                    return ctx.plan(
                        `It would run the playbook ${ctx.id ? `"${ctx.id}"` : 'given in body.content'} now on ${which}, all at once.`,
                    );
                }
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
                    target_devices: b.device ? [b.device] : listed ? b.devices : undefined,
                    target_all: b.all === true || !!b.group,
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
            description: `Roll the saved playbook ids.playbook out across the product's devices in batches of body.batch_size (default 5), stopping when the failure rate reaches body.failure_threshold (percent, default ${DEFAULT_FAILURE_THRESHOLD}). Narrow it with body.group or body.filter; offline devices are skipped unless body.include_offline. body.dry_run lists plan and devices; body.check says what would change. Writes a report to playbooks/runs/ in the product storage. Changes real machines: it answers its plan (devices, batches) until confirmed; try it with run on one device first.`,
            confirm: true,
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
            async run(body, ctx) {
                const b = body && typeof body === 'object' ? body : {};
                const args = { ...b, product: ctx.parent, name: ctx.id, user: ctx.user };
                if (!b.dry_run && !b.check && !ctx.confirmed && ctx.plan) {
                    return ctx.plan(
                        rolloutPlan(await toolProductPlaybookRollout({ ...args, dry_run: true })),
                    );
                }
                return toolProductPlaybookRollout(args);
            },
        },
    },
};

/** The devices of a product (or of one of its groups) a run reaches, in words. */
async function groupDevices(ctx, group) {
    const filter = { product: ctx.parent, ...(group ? { asset_group: group } : {}) };
    const ids = (await getDevices(filter, ctx.user)).map((d) => d.device);
    const where = group ? `group "${group}" of product "${ctx.parent}"` : `product "${ctx.parent}"`;
    return `every device of ${where} (${ids.length}${ids.length ? `: ${ids.join(', ')}` : ''})`;
}

/** What a rollout would do, from its dry run. */
function rolloutPlan(dry) {
    const text = dry?.content?.[0]?.text ?? '';
    try {
        const p = JSON.parse(text);
        return `It would roll out the playbook "${p.name}" on ${p.device_count} device(s) of product "${p.product}" in batches of ${p.batch_size}, stopping at ${p.failure_threshold}% failures: ${(p.devices || []).join(', ')}. Steps: ${(p.steps || []).length}.`;
    } catch {
        return `It would roll out the playbook:\n${text}`;
    }
}

/** The YAML an action works on: body.content, or the saved playbook ids.playbook. */
async function playbookSource(body, ctx) {
    if (typeof body?.content === 'string' && body.content.trim()) return body.content;
    if (!ctx.id)
        throw inputError(
            'give the playbook: ids.playbook (saved on the product) or body.content (YAML)',
        );
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
    product_playbook: productPlaybook,
};

/** @type {Record<string, Record<string, LocalAction>>} */
export const resourceActions = {
    device: {
        exec: execAction,
        agent_update: {
            description:
                'Check for a new version of the ThinRemote agent of the device ids.device (body {action: "check"}) or install it (body {action: "apply", channel?: "latest" | "main" | "develop"}).',
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
