// @ts-check
import { filterActiveDevices, getDevices } from '../devices.js';
import { runPool } from '../concurrency.js';
import { HANDLERS, CHECKERS, createActionContext } from './actions.js';

/** Actions whose effect isn't derivable from observable state, so
 * pre-checking before apply is either pointless or harmful (sleep
 * would always skip; exec/resource have unpredictable side effects
 * we must always trigger; pull writes to local disk — pre-check
 * would hash the remote just to overwrite the local file anyway). */
const NON_IDEMPOTENT = new Set(['sleep', 'exec', 'resource', 'pull']);
import { ACTION_BY_NAME } from './schema.js';
import { interpolate, resolveVarScope } from './vars.js';
import { evaluateCondition } from './expression.js';

function buildScope(pb, opts, extras) {
    if (opts && Object.hasOwn(opts, 'overrides')) {
        return resolveVarScope(pb, opts.overrides || {}, extras);
    }
    return { ...(pb.vars || {}), ...extras };
}

/**
 * Resolve the playbook's `target` block to a concrete device list.
 * Honours optional CLI overrides (product / group / devices) that the
 * caller may pass to tweak a saved playbook without editing it.
 *
 * @param {any} pb
 * @param {{ user?: string | null, overrides?: { product?: string, group?: string, devices?: string[] } }} [opts]
 */
export async function resolveTargets(pb, opts = {}) {
    const { user, overrides = {} } = opts;
    const target = { ...pb.target, ...overrides };
    if (Array.isArray(target.devices) && target.devices.length > 0) {
        // Explicit list — we still fetch the fleet so we can attach
        // connection state, but fall back gracefully when a requested
        // id isn't in the user's fleet (unlikely).
        const all = await getDevices({}, user);
        const byId = Object.fromEntries(all.map((d) => [d.device, d]));
        return target.devices.map((id) => byId[id] || { device: id, connection: { active: false } });
    }
    if (!target.product) {
        throw new Error('playbook target has no product/devices after overrides');
    }
    const filter = { product: target.product };
    if (target.group) filter.asset_group = target.group;
    const all = await getDevices(filter, user);
    return filterActiveDevices(all);
}

/**
 * Static "what would happen" summary — does no remote calls. Returns
 * rows of `{ step, summary }` the caller can render as a plan.
 *
 * Pass `opts.overrides` to resolve variables with the new scope model
 * (declared defaults + validated overrides, throws on unknown / non-
 * overridable / wrong-type / missing-required vars). Omit it to fall
 * back to the legacy behaviour that just spreads `pb.vars` into scope.
 *
 * @param {any} pb
 * @param {{ overrides?: Record<string, unknown> }} [opts]
 */
export function buildDryRunPlan(pb, opts) {
    /** @type {Record<string, unknown>} */
    const scope = buildScope(pb, opts, { device: '<device>' });
    return pb.steps.map((s, i) => {
        const spec = ACTION_BY_NAME[s.action];
        const resolvedParams = interpolate(s.params, scope);
        return {
            index: i,
            name: s.name,
            action: s.action,
            summary: spec ? spec.summary(resolvedParams) : s.action,
            pause_after: s.pause_after,
        };
    });
}

/**
 * Run the playbook over `devices` with `concurrency` parallel workers.
 * Each worker runs every step in order against its device and records
 * the outcome per step. Handlers never throw past the runner — failures
 * are captured into the results table.
 *
 * Set `checkMode: true` to route every step through CHECKERS instead
 * of HANDLERS. Actions without a checker are reported as `unknown`
 * and skipped without side effects.
 *
 * Pass `opts.overrides` to resolve variables with the new scope model
 * (declared defaults + validated overrides). Omit it to fall back to
 * the legacy behaviour that just spreads `pb.vars` into scope.
 *
 * @param {Object} pb                 Parsed playbook.
 * @param {Object[]} devices          Device records from resolveTargets().
 * @param {{
 *   user?: string | null,
 *   concurrency?: number,
 *   failFast?: boolean,
 *   continueOnError?: boolean,
 *   baseDir?: string,
 *   checkMode?: boolean,
 *   overrides?: Record<string, unknown>,
 *   onStepStart?: (args: { deviceId: string, stepIndex: number, step: any }) => void,
 *   onStepEnd?:   (args: { deviceId: string, stepIndex: number, step: any, ok: boolean, summary: string, error?: string, durationMs: number, verdict?: 'applied' | 'changed' | 'unchanged' | 'unknown', stdout?: string, stderr?: string, exitCode?: number }) => void,
 * }} [opts]
 */
export async function runPlaybook(pb, devices, opts = {}) {
    const checkMode = !!opts.checkMode;
    const concurrency = opts.concurrency ?? pb.target.concurrency ?? 10;
    const failFast = opts.failFast ?? pb.target.fail_fast ?? false;
    const continueOnError = opts.continueOnError ?? pb.target.continue_on_error ?? false;
    const user = opts.user ?? null;
    const baseDir = opts.baseDir;

    /** @type {boolean} */
    let aborted = false;

    const results = await runPool(devices, concurrency, async (device) => {
        const deviceId = device.device;
        const ctx = createActionContext({ deviceId, user, baseDir });
        /** @type {Record<string, unknown>} */
        const scope = buildScope(pb, opts, { device: deviceId });
        const steps = [];
        let deviceOk = true;

        for (let i = 0; i < pb.steps.length; i++) {
            if (aborted) {
                steps.push({ index: i, name: pb.steps[i].name, ok: false, skipped: true, summary: 'skipped (fail-fast)', durationMs: 0 });
                continue;
            }
            const step = pb.steps[i];

            // `when` gate. Evaluated against the live scope (playbook
            // vars + `device` + every `register`-ed step result so far).
            // A parse/eval error fails the step — less confusing than
            // silently skipping and continuing.
            if (step.when) {
                let gate;
                try {
                    gate = evaluateCondition(step.when, scope);
                } catch (err) {
                    const durationMs = 0;
                    const msg = err instanceof Error ? err.message : String(err);
                    steps.push({
                        index: i,
                        name: step.name,
                        ok: false,
                        summary: `when-expression error: ${msg}`,
                        error: msg,
                        durationMs,
                    });
                    opts.onStepEnd?.({ deviceId, stepIndex: i, step, ok: false, summary: msg, error: msg, durationMs });
                    deviceOk = false;
                    if (failFast) aborted = true;
                    break;
                }
                if (!gate) {
                    steps.push({
                        index: i,
                        name: step.name,
                        ok: true,
                        skipped: true,
                        summary: `skipped (when: ${step.when})`,
                        durationMs: 0,
                    });
                    opts.onStepEnd?.({ deviceId, stepIndex: i, step, ok: true, summary: 'skipped', durationMs: 0 });
                    continue;
                }
            }

            const handler = HANDLERS[step.action];
            const checker = CHECKERS[step.action];
            const resolvedParams = interpolate(step.params, scope);
            opts.onStepStart?.({ deviceId, stepIndex: i, step });

            const t0 = Date.now();
            try {
                let summary;
                let verdict;
                let stdout;
                let stderr;
                let exitCode;
                if (checkMode) {
                    if (checker) {
                        const result = await checker(ctx, resolvedParams);
                        verdict = result.status;
                        summary = result.summary;
                    } else {
                        verdict = 'unknown';
                        summary = `check not supported for ${step.action}`;
                    }
                } else {
                    let preCheck = null;
                    if (checker && !NON_IDEMPOTENT.has(step.action)) {
                        try {
                            preCheck = await checker(ctx, resolvedParams);
                        } catch {
                            preCheck = null;
                        }
                    }
                    if (preCheck && preCheck.status === 'unchanged') {
                        verdict = 'unchanged';
                        summary = preCheck.summary;
                    } else {
                        const out = await handler(ctx, resolvedParams);
                        if (typeof out === 'string') {
                            summary = out;
                        } else {
                            summary = out.summary;
                            stdout = out.stdout;
                            stderr = out.stderr;
                            exitCode = out.exitCode;
                        }
                        verdict = 'changed';
                    }
                }
                const durationMs = Date.now() - t0;
                const entry = { index: i, name: step.name, ok: true, summary, durationMs, verdict };
                if (stdout !== undefined) entry.stdout = stdout;
                if (stderr !== undefined) entry.stderr = stderr;
                if (exitCode !== undefined) entry.exitCode = exitCode;
                steps.push(entry);
                if (step.register) {
                    scope[step.register] = {
                        ok: true,
                        result: summary,
                        duration_ms: durationMs,
                    };
                }
                opts.onStepEnd?.({
                    deviceId,
                    stepIndex: i,
                    step,
                    ok: true,
                    summary,
                    durationMs,
                    verdict,
                    stdout,
                    stderr,
                    exitCode,
                });
            } catch (err) {
                const durationMs = Date.now() - t0;
                const msg = err instanceof Error ? err.message : String(err);
                const stdout = err && typeof err === 'object' ? err.stdout : undefined;
                const stderr = err && typeof err === 'object' ? err.stderr : undefined;
                const exitCode = err && typeof err === 'object' ? err.exitCode : undefined;
                const entry = { index: i, name: step.name, ok: false, summary: msg, error: msg, durationMs };
                if (stdout !== undefined) entry.stdout = stdout;
                if (stderr !== undefined) entry.stderr = stderr;
                if (exitCode !== undefined) entry.exitCode = exitCode;
                steps.push(entry);
                if (step.register) {
                    scope[step.register] = {
                        ok: false,
                        error: msg,
                        duration_ms: durationMs,
                    };
                }
                opts.onStepEnd?.({
                    deviceId,
                    stepIndex: i,
                    step,
                    ok: false,
                    summary: msg,
                    error: msg,
                    durationMs,
                    stdout,
                    stderr,
                    exitCode,
                });
                deviceOk = false;
                if (failFast) aborted = true;
                if (continueOnError) continue;
                break;
            }

            if (step.pause_after > 0) {
                await new Promise((r) => setTimeout(r, step.pause_after * 1000));
            }
        }

        return { device: deviceId, ok: deviceOk, steps };
    });

    return results.map((r, i) => {
        if (r && r.ok) return r.value;
        let msg = 'unknown error';
        if (r && r.ok === false) {
            const err = r.error;
            msg = err instanceof Error ? err.message : String(err);
        }
        return {
            device: devices[i].device,
            ok: false,
            steps: [],
            error: msg,
        };
    });
}
