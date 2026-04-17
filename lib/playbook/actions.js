// @ts-check
import { readFileSync } from 'fs';
import { createDeviceAPI } from '../device-api.js';
import { setDeviceProperty } from '../property.js';
import { callDeviceResource, readDeviceResource } from '../resource.js';

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

/** @type {Record<string, (ctx: any, params: any) => Promise<string>>} */
export const HANDLERS = {
    async exec(ctx, params) {
        const timeout = Number.isFinite(params.timeout) && params.timeout > 0 ? params.timeout : 30;
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
        let content;
        if (typeof params.content === 'string') {
            content = params.content;
        } else if (typeof params.content_file === 'string') {
            content = resolveLocalFile(params.content_file, ctx.baseDir);
        } else {
            throw new Error('`content` or `content_file` is required');
        }
        await ctx.api.writeFile(params.path, Buffer.from(content, 'utf8'));
        return `wrote ${Buffer.byteLength(content, 'utf8')} bytes`;
    },

    async delete(ctx, params) {
        await ctx.api.delete(params.path, params.recursive !== false);
        return `deleted ${params.path}`;
    },

    async mkdir(ctx, params) {
        await ctx.api.mkdir(params.path);
        return `created ${params.path}`;
    },

    async move(ctx, params) {
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
        const timeout = op === 'apply' ? 300000 : 30000;
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
        const chmod = await ctx.api.exec(`chmod +x ${JSON.stringify(path)}`, 10);
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
