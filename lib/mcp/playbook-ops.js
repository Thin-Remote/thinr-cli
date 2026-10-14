// @ts-check
import {
    findProductPlaybook,
    listProductPlaybooks,
    readProductPlaybook,
    uploadFleetRunReport,
} from '../product.js';
import { requireConfig } from '@thinger-io/cli-core/config';
import { filterActiveDevices, getDevices } from '@thinger-io/cli-core/devices';
import { inputError } from '@thinger-io/cli-core/errors';
import { parsePlaybook } from '../playbook/loader.js';
import { buildDryRunPlan, resolveTargets, runPlaybook } from '../playbook/runner.js';
import { DEFAULT_FAILURE_THRESHOLD, runFleetPlaybook } from '../playbook/fleet.js';
import { playbookSchema } from '../playbook/schema.js';
import { listVariables, resolveVarScope } from '../playbook/vars.js';
import { mcpLocalRoot } from '../local-files.js';

/**
 * Validating, running and rolling out playbooks: the actions of the
 * `product_playbook` resource type (see resource-types.js). Each takes the
 * arguments of the tools they used to be and answers a whole tool result,
 * flagged as an error when a device did not complete.
 */

export { DEFAULT_FAILURE_THRESHOLD, playbookSchema };

export async function toolPlaybookValidate(args) {
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

export async function toolPlaybookRun(args) {
    if (typeof args.content !== 'string' || !args.content.trim()) {
        throw inputError('content (YAML playbook source) is required');
    }
    const pb = parsePlaybook(args.content);
    if (args.target_product) pb.target.product = args.target_product;
    if (args.target_group) pb.target.group = args.target_group;
    // The whole product (or one of its groups), whatever devices the YAML lists.
    if (args.target_all) pb.target.devices = null;
    if (Array.isArray(args.target_devices) && args.target_devices.length) {
        pb.target.devices = args.target_devices;
        pb.target.group = null;
    }
    if (Number.isInteger(args.concurrency) && args.concurrency > 0) {
        pb.target.concurrency = args.concurrency;
    }
    if (typeof args.fail_fast === 'boolean') pb.target.fail_fast = args.fail_fast;
    // Overrides are checked against what the playbook declares (unknown,
    // not overridable, wrong type, required and missing) before anything
    // runs, as for saved playbooks.
    const rawVars =
        args.vars && typeof args.vars === 'object' && !Array.isArray(args.vars) ? args.vars : {};
    let resolvedScope;
    try {
        resolvedScope = resolveVarScope(pb, rawVars);
    } catch (err) {
        throw inputError(err.message);
    }

    if (args.dry_run) {
        const plan = buildDryRunPlan(pb, { overrides: rawVars });
        const out = {
            dry_run: true,
            name: pb.name,
            target: pb.target,
            vars: resolvedScope,
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
        overrides: rawVars,
        localRoot: mcpLocalRoot(),
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

export async function toolProductPlaybookRun(args) {
    if (!args.product) throw inputError('product is required');
    if (!args.name) throw inputError('name is required');
    if (!args.device_id) throw inputError('device is required (single-device only)');

    const entry = await findProductPlaybook(args.product, args.name, args.user);
    if (!entry) {
        const available = await listProductPlaybooks(args.product, args.user);
        throw inputError(
            `Playbook "${args.name}" is not registered on product "${args.product}". Available: ${available.map((e) => e.name).join(', ') || '(none)'}`,
        );
    }

    const content = await readProductPlaybook(args.product, args.name, args.user);
    const pb = parsePlaybook(content, { sourcePath: `${args.name}.yaml` });

    const rawVars =
        args.vars && typeof args.vars === 'object' && !Array.isArray(args.vars) ? args.vars : {};

    let resolvedScope;
    try {
        resolvedScope = resolveVarScope(pb, rawVars);
    } catch (err) {
        throw inputError(err.message);
    }

    pb.target.devices = [args.device_id];
    pb.target.product = args.product;
    pb.target.group = null;

    if (args.dry_run) {
        const plan = buildDryRunPlan(pb, { overrides: rawVars });
        const payload = {
            dry_run: true,
            product: args.product,
            name: args.name,
            device: args.device_id,
            variables: listVariables(pb),
            vars: resolvedScope,
            steps: plan,
        };
        return {
            content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
            isError: false,
        };
    }

    const all = await getDevices({ product: args.product }, args.user);
    const device = all.find((d) => d.device === args.device_id) || {
        device: args.device_id,
        connection: { active: false },
    };

    const results = await runPlaybook(pb, [device], {
        localRoot: mcpLocalRoot(),
        user: args.user,
        concurrency: 1,
        failFast: true,
        checkMode: !!args.check,
        overrides: rawVars,
    });
    const result = results[0];
    const payload = {
        product: args.product,
        name: args.name,
        device: args.device_id,
        mode: args.check ? 'check' : 'apply',
        ok: !!result?.ok,
        result,
    };
    return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: !result?.ok,
    };
}

export async function toolProductPlaybookRollout(args) {
    if (!args.product) throw inputError('product is required');
    if (!args.name) throw inputError('name is required');

    const batchSize =
        Number.isFinite(args.batch_size) && args.batch_size > 0 ? Math.floor(args.batch_size) : 5;
    const failureThreshold =
        args.failure_threshold === undefined || args.failure_threshold === null
            ? DEFAULT_FAILURE_THRESHOLD
            : Number(args.failure_threshold);
    if (!Number.isFinite(failureThreshold) || failureThreshold < 0 || failureThreshold > 100) {
        throw inputError('failure_threshold must be a number between 0 and 100');
    }

    const entry = await findProductPlaybook(args.product, args.name, args.user);
    if (!entry) {
        const available = await listProductPlaybooks(args.product, args.user);
        throw inputError(
            `Playbook "${args.name}" is not registered on product "${args.product}". Available: ${available.map((e) => e.name).join(', ') || '(none)'}`,
        );
    }

    const content = await readProductPlaybook(args.product, args.name, args.user);
    const pb = parsePlaybook(content, { sourcePath: `${args.name}.yaml` });

    const rawVars =
        args.vars && typeof args.vars === 'object' && !Array.isArray(args.vars) ? args.vars : {};

    let resolvedScope;
    try {
        resolvedScope = resolveVarScope(pb, rawVars);
    } catch (err) {
        throw inputError(err.message);
    }

    const filters = {};
    if (args.filter && typeof args.filter === 'object' && !Array.isArray(args.filter)) {
        for (const [k, v] of Object.entries(args.filter)) {
            if (!/^[A-Za-z0-9_]+$/.test(k)) {
                throw inputError(`Invalid filter key "${k}"`);
            }
            filters[k] = v;
        }
    }

    const baseFilter = { product: args.product };
    if (args.group) baseFilter.asset_group = args.group;
    Object.assign(baseFilter, filters);
    let devices = await getDevices(baseFilter, args.user);
    if (!args.include_offline) devices = filterActiveDevices(devices);

    pb.target.devices = null;
    pb.target.product = args.product;
    pb.target.group = args.group || null;

    if (args.dry_run) {
        const plan = buildDryRunPlan(pb, { overrides: rawVars });
        const payload = {
            dry_run: true,
            product: args.product,
            name: args.name,
            fleet: true,
            device_count: devices.length,
            devices: devices.map((d) => d.device),
            batch_size: batchSize,
            failure_threshold: failureThreshold,
            variables: listVariables(pb),
            vars: resolvedScope,
            steps: plan,
        };
        return {
            content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
            isError: false,
        };
    }

    if (devices.length === 0) {
        const payload = {
            product: args.product,
            name: args.name,
            fleet: true,
            device_count: 0,
            aborted: false,
            summary: { attempted: 0, succeeded: 0, failed: 0, failureRate: 0 },
            message: 'no matching devices',
        };
        return {
            content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
            isError: false,
        };
    }

    const startedAt = new Date().toISOString();
    const outcome = await runFleetPlaybook(pb, devices, {
        localRoot: mcpLocalRoot(),
        user: args.user,
        batchSize,
        failureThreshold,
        overrides: rawVars,
        checkMode: !!args.check,
    });
    const finishedAt = new Date().toISOString();

    const summary = {
        attempted: outcome.attempted,
        succeeded: outcome.succeeded,
        failed: outcome.failed,
        failureRate: outcome.failureRate,
        total: devices.length,
    };

    const report = {
        product: args.product,
        name: args.name,
        user: args.user || requireConfig().username,
        startedAt,
        finishedAt,
        durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
        mode: args.check ? 'check' : 'apply',
        playbook: {
            name: pb.name || null,
            description: pb.description || null,
            steps: pb.steps.length,
        },
        rollout: {
            batchSize,
            failureThreshold,
            filters: Object.keys(filters).length > 0 ? filters : null,
            group: args.group || null,
            includeOffline: !!args.include_offline,
        },
        vars: resolvedScope,
        summary,
        aborted: outcome.aborted,
        reason: outcome.reason,
        batches: outcome.batches,
        devices: outcome.results.map((r) => ({
            device: r?.device,
            ok: !!r?.ok,
            skipped: !!r?.skipped,
            error: r?.error || null,
        })),
    };

    const upload = await uploadFleetRunReport({ product: args.product, report, user: args.user });

    const payload = {
        product: args.product,
        name: args.name,
        fleet: true,
        mode: args.check ? 'check' : 'apply',
        startedAt,
        finishedAt,
        batch_size: batchSize,
        failure_threshold: failureThreshold,
        device_count: devices.length,
        batches: outcome.batches,
        summary,
        aborted: outcome.aborted,
        reason: outcome.reason,
        results: outcome.results,
        report_uploaded: upload.ok,
        report_path: upload.ok ? upload.path : null,
        report_error: upload.ok ? null : upload.reason,
    };
    return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: outcome.aborted || summary.failed > 0,
    };
}
