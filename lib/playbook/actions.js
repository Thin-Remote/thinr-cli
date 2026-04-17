// @ts-check
import { readFileSync } from 'fs';
import { writeFile as writeLocalFile } from 'fs/promises';
import { resolve as resolvePath } from 'path';
import { createHash } from 'crypto';
import { createDeviceAPI } from '../device-api.js';
import { setDeviceProperty, getDeviceProperty } from '../property.js';
import { callDeviceResource, readDeviceResource } from '../resource.js';
import { TIMEOUTS } from '../constants.js';

/**
 * Runtime handlers for every action in schema.js. Each handler takes
 * a `ctx` (shared per-device context: apiUser, deviceId, api client)
 * and the step's params, and either resolves with a short result
 * string or throws to fail the step.
 *
 * The execution envelope (step order, concurrency, error handling) is
 * in runner.js — handlers only care about their one job.
 */

function resolveLocalFile(relPath, baseDir) {
    const path = baseDir ? `${baseDir}/${relPath}` : relPath;
    return readFileSync(path, 'utf8');
}

function resolveLocalPath(relPath, baseDir) {
    return baseDir ? resolvePath(baseDir, relPath) : resolvePath(relPath);
}

/** @type {Record<string, (ctx: any, params: any) => Promise<string>>} */
export const HANDLERS = {
    async exec(ctx, params) {
        const timeout =
            Number.isFinite(params.timeout) && params.timeout > 0
                ? params.timeout
                : TIMEOUTS.DEFAULT_EXEC_SECONDS;
        let stdout = '';
        let stderr = '';
        const { exitCode, timedOut } = await ctx.api.execStream(params.command, {
            timeout,
            onStdout: (s) => {
                stdout += s;
            },
            onStderr: (s) => {
                stderr += s;
            },
        });
        if (timedOut) throw new Error(`timed out after ${timeout}s`);
        if (exitCode !== 0) {
            const tail = (stderr || stdout).trim().split('\n').slice(-3).join(' | ');
            throw new Error(`exit=${exitCode}${tail ? ` · ${tail}` : ''}`);
        }
        return `exit=0`;
    },

    async sleep(_ctx, params) {
        const ms = Math.max(0, Math.floor(Number(params.seconds) * 1000));
        await new Promise((r) => setTimeout(r, ms));
        return `slept ${params.seconds}s`;
    },

    async write(ctx, params) {
        if (typeof params.content !== 'string') {
            throw new Error('`content` is required');
        }
        await ctx.api.writeFile(params.path, Buffer.from(params.content, 'utf8'));
        return `wrote ${Buffer.byteLength(params.content, 'utf8')} bytes`;
    },

    async push(ctx, params) {
        const local = resolveLocalPath(params.source, ctx.baseDir);
        const content = readFileSync(local);
        await ctx.api.writeFile(params.destination, content);
        return `pushed ${content.byteLength} bytes`;
    },

    async pull(ctx, params) {
        const local = resolveLocalPath(params.destination, ctx.baseDir);
        const buf = await ctx.api.readFile(params.source);
        await writeLocalFile(local, buf);
        return `pulled ${buf.byteLength} bytes`;
    },

    async rm(ctx, params) {
        await ctx.api.delete(params.path, params.recursive !== false);
        return `removed ${params.path}`;
    },

    async mkdir(ctx, params) {
        await ctx.api.mkdir(params.path);
        return `created ${params.path}`;
    },

    async mv(ctx, params) {
        await ctx.api.move(params.source, params.destination, !!params.overwrite);
        return `moved ${params.source} → ${params.destination}`;
    },

    async property_set(ctx, params) {
        await setDeviceProperty(ctx.deviceId, params.property, params.value);
        return `set ${params.property}`;
    },

    async resource(ctx, params) {
        const result = await callDeviceResource(ctx.deviceId, params.resource, params.inputs || null);
        const summary =
            typeof result === 'string'
                ? result.slice(0, 40)
                : JSON.stringify(result).slice(0, 40);
        return `resource ${params.resource} → ${summary}`;
    },

    async update(ctx, params) {
        const op = params.op;
        if (op !== 'check' && op !== 'apply') throw new Error('`op` must be "check" or "apply"');
        const payload = { action: op, channel: params.channel || 'latest' };
        // Agent updates can take a while. Give `apply` the same 5-min
        // window the CLI's `thinr device update apply` uses.
        const timeout =
            op === 'apply' ? TIMEOUTS.DEVICE_UPDATE_APPLY_MS : TIMEOUTS.DEVICE_RESOURCE_CALL_MS;
        const result = await ctx.api.callResource('update', payload, { timeout });
        return `update ${op}: ${result?.status || 'ok'}`;
    },

    async script_install(ctx, params) {
        let content;
        if (typeof params.content === 'string') content = params.content;
        else if (typeof params.content_file === 'string')
            content = resolveLocalFile(params.content_file, ctx.baseDir);
        else throw new Error('`content` or `content_file` is required');

        if (!/^[A-Za-z0-9._-]+$/.test(params.name)) {
            throw new Error(`invalid script name "${params.name}"`);
        }
        const info = await readDeviceResource(ctx.deviceId, '$scripts/info');
        const baseDir = info?.path;
        if (!baseDir) throw new Error('agent did not return a scripts directory');
        const path = `${baseDir}/${params.name}`;
        await ctx.api.writeFile(path, content, true);
        const chmod = await ctx.api.exec(
            `chmod +x ${JSON.stringify(path)}`,
            TIMEOUTS.SCRIPT_CHMOD_SECONDS,
        );
        if (chmod.retcode !== 0) throw new Error(`chmod failed: ${chmod.stderr || chmod.retcode}`);
        await callDeviceResource(ctx.deviceId, '$scripts/reload', {});
        return `installed ${params.name}`;
    },

    async script_delete(ctx, params) {
        if (!/^[A-Za-z0-9._-]+$/.test(params.name)) {
            throw new Error(`invalid script name "${params.name}"`);
        }
        const info = await readDeviceResource(ctx.deviceId, '$scripts/info');
        const baseDir = info?.path;
        if (!baseDir) throw new Error('agent did not return a scripts directory');
        await ctx.api.delete(`${baseDir}/${params.name}`, false);
        await callDeviceResource(ctx.deviceId, '$scripts/reload', {});
        return `removed ${params.name}`;
    },
};

/**
 * Read-only verdicts for `--check` mode. Each entry receives the same
 * ctx/params as the corresponding HANDLERS entry and returns a verdict
 * describing what would happen if the step ran. Must never write.
 *
 *   { status: 'changed' | 'unchanged' | 'unknown', summary: string }
 *
 * Actions without an entry here fall back to 'unknown' automatically
 * (e.g. `exec`, `resource` — their effect can't be predicted without
 * running them; `write` / `script_install` — depend on the agent
 * exposing a filesystem hash op, handled in a follow-up).
 *
 * @type {Record<string, (ctx: any, params: any) => Promise<{ status: 'changed' | 'unchanged' | 'unknown', summary: string }>>}
 */
export const CHECKERS = {
    async sleep(_ctx, params) {
        return { status: 'unchanged', summary: `would sleep ${params.seconds}s` };
    },

    async write(ctx, params) {
        if (typeof params.content !== 'string') {
            throw new Error('`content` is required');
        }
        return hashCheck(ctx.api, params.path, Buffer.from(params.content, 'utf8'));
    },

    async push(ctx, params) {
        const local = resolveLocalPath(params.source, ctx.baseDir);
        const content = readFileSync(local);
        return hashCheck(ctx.api, params.destination, content);
    },

    async pull(ctx, params) {
        try {
            const info = await ctx.api.info(params.source);
            const size = info?.size ?? '?';
            return { status: 'changed', summary: `would pull ${params.source} (${size} bytes) → ${params.destination}` };
        } catch (err) {
            if (err?.response?.status === 404) {
                return { status: 'changed', summary: `source ${params.source} not found on device` };
            }
            throw err;
        }
    },

    async script_install(ctx, params) {
        if (!/^[A-Za-z0-9._-]+$/.test(params.name)) {
            throw new Error(`invalid script name "${params.name}"`);
        }
        const content = resolveWriteContent(params, ctx.baseDir);
        const localHash = sha256Hex(content);
        const info = await readDeviceResource(ctx.deviceId, '$scripts/info');
        const baseDir = info?.path;
        if (!baseDir) throw new Error('agent did not return a scripts directory');
        const remotePath = `${baseDir}/${params.name}`;
        let remote;
        try {
            remote = await ctx.api.hashFile(remotePath);
        } catch (err) {
            if (err?.response?.status === 404) {
                return { status: 'changed', summary: `install ${params.name}` };
            }
            if (err?.response?.status === 405 || err?.response?.status === 501) {
                return { status: 'unknown', summary: 'agent lacks $fs/hash — cannot predict' };
            }
            throw err;
        }
        if (remote?.hash === localHash) {
            return { status: 'unchanged', summary: `${params.name} already matches` };
        }
        return { status: 'changed', summary: `${params.name} would be replaced` };
    },

    async property_set(ctx, params) {
        let current;
        try {
            current = await getDeviceProperty(ctx.deviceId, params.property);
        } catch (err) {
            if (err?.code === 'not_found') {
                return { status: 'changed', summary: `create property ${params.property}` };
            }
            throw err;
        }
        if (stableStringify(current) === stableStringify(params.value)) {
            return { status: 'unchanged', summary: `property ${params.property} already set` };
        }
        return { status: 'changed', summary: `property ${params.property} would change` };
    },

    async rm(ctx, params) {
        try {
            await ctx.api.info(params.path);
        } catch (err) {
            if (err?.response?.status === 404) {
                return { status: 'unchanged', summary: `${params.path} does not exist` };
            }
            throw err;
        }
        return { status: 'changed', summary: `would remove ${params.path}` };
    },

    async mkdir(ctx, params) {
        try {
            const info = await ctx.api.info(params.path);
            if (info?.type === 'directory') {
                return { status: 'unchanged', summary: `${params.path} already exists` };
            }
            return {
                status: 'changed',
                summary: `${params.path} exists as ${info?.type || 'non-dir'} — mkdir would fail`,
            };
        } catch (err) {
            if (err?.response?.status === 404) {
                return { status: 'changed', summary: `would create ${params.path}` };
            }
            throw err;
        }
    },

    async mv(ctx, params) {
        try {
            await ctx.api.info(params.source);
        } catch (err) {
            if (err?.response?.status === 404) {
                return { status: 'unchanged', summary: `source ${params.source} does not exist` };
            }
            throw err;
        }
        if (!params.overwrite) {
            try {
                await ctx.api.info(params.destination);
                return {
                    status: 'unchanged',
                    summary: `destination ${params.destination} already exists (overwrite=false)`,
                };
            } catch (err) {
                if (err?.response?.status !== 404) throw err;
            }
        }
        return {
            status: 'changed',
            summary: `would move ${params.source} → ${params.destination}`,
        };
    },

    async update(ctx, params) {
        if (params.op !== 'check' && params.op !== 'apply') {
            throw new Error('`op` must be "check" or "apply"');
        }
        const result = await ctx.api.callResource(
            'update',
            { action: 'check', channel: params.channel || 'latest' },
            { timeout: TIMEOUTS.DEVICE_RESOURCE_CALL_MS },
        );
        const upToDate = result?.status === 'up_to_date';
        return {
            status: upToDate ? 'unchanged' : 'changed',
            summary: `update ${params.op}: ${result?.status || 'unknown'}` +
                (result?.latest ? ` (latest=${result.latest})` : ''),
        };
    },

    async script_delete(ctx, params) {
        if (!/^[A-Za-z0-9._-]+$/.test(params.name)) {
            throw new Error(`invalid script name "${params.name}"`);
        }
        const info = await readDeviceResource(ctx.deviceId, '$scripts/info');
        const baseDir = info?.path;
        if (!baseDir) throw new Error('agent did not return a scripts directory');
        try {
            await ctx.api.info(`${baseDir}/${params.name}`);
        } catch (err) {
            if (err?.response?.status === 404) {
                return { status: 'unchanged', summary: `${params.name} is not installed` };
            }
            throw err;
        }
        return { status: 'changed', summary: `would remove ${params.name}` };
    },
};

/**
 * Resolve the payload of a script_install step into a Buffer — same
 * logic the handler uses — so the check path hashes exactly the same
 * bytes that would be uploaded.
 */
function resolveWriteContent(params, baseDir) {
    if (typeof params.content === 'string') {
        return Buffer.from(params.content, 'utf8');
    }
    if (typeof params.content_file === 'string') {
        return Buffer.from(resolveLocalFile(params.content_file, baseDir), 'utf8');
    }
    throw new Error('`content` or `content_file` is required');
}

/**
 * Shared check-mode helper for write / push: compare the locally
 * computed sha256 against the agent's remote hash, mapping the
 * usual HTTP error codes into verdicts.
 */
async function hashCheck(api, path, contentBuffer) {
    const localHash = sha256Hex(contentBuffer);
    let remote;
    try {
        remote = await api.hashFile(path);
    } catch (err) {
        if (err?.response?.status === 404) {
            return { status: 'changed', summary: `create ${path} (${contentBuffer.length} bytes)` };
        }
        if (err?.response?.status === 400) {
            return { status: 'changed', summary: `${path} is not a regular file — would overwrite` };
        }
        if (err?.response?.status === 405 || err?.response?.status === 501) {
            return { status: 'unknown', summary: 'agent lacks $fs/hash — cannot predict' };
        }
        throw err;
    }
    if (remote?.hash === localHash) {
        return { status: 'unchanged', summary: `${path} already matches (${remote.size} bytes)` };
    }
    return {
        status: 'changed',
        summary: `${path} would change (${remote?.size ?? '?'} → ${contentBuffer.length} bytes)`,
    };
}

function sha256Hex(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

/**
 * JSON stringify with sorted object keys, so two structurally equal
 * values compare equal regardless of property declaration order.
 */
function stableStringify(value) {
    return JSON.stringify(value, function replacer(_k, v) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            return Object.keys(v)
                .sort()
                .reduce((acc, k) => {
                    acc[k] = v[k];
                    return acc;
                }, {});
        }
        return v;
    });
}

/**
 * Build a per-device execution context that handlers share.
 */
export function createActionContext({ deviceId, user, baseDir }) {
    return {
        deviceId,
        user,
        baseDir,
        api: createDeviceAPI(deviceId, { user: user || undefined }),
    };
}
