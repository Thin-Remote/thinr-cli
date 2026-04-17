// @ts-check
import { readFileSync } from 'fs';
import YAML from 'yaml';
import { ACTION_BY_NAME } from './schema.js';

/**
 * Parse and validate a playbook document. Returns the normalised shape
 * ready to feed into the runner, or throws a descriptive Error listing
 * every issue found (one per line).
 *
 * @param {string} source  YAML source text.
 * @param {{ sourcePath?: string }} [opts]
 */
export function parsePlaybook(source, { sourcePath } = {}) {
    let raw;
    try {
        raw = YAML.parse(source);
    } catch (err) {
        throw new Error(
            `Invalid YAML${sourcePath ? ` in ${sourcePath}` : ''}: ${err.message}`,
            { cause: err },
        );
    }

    const errors = [];

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Playbook root must be a YAML mapping with `target` and `steps`.');
    }

    const target = validateTarget(raw.target, errors);
    const vars = validateVars(raw.vars, errors);
    const steps = validateSteps(raw.steps, errors);

    if (errors.length) {
        throw new Error(`Invalid playbook:\n  - ${errors.join('\n  - ')}`);
    }

    return {
        name: typeof raw.name === 'string' ? raw.name : null,
        description: typeof raw.description === 'string' ? raw.description : null,
        target,
        vars,
        steps,
    };
}

/** Read + parse a playbook from disk. */
export function loadPlaybookFile(path) {
    const source = readFileSync(path, 'utf8');
    return parsePlaybook(source, { sourcePath: path });
}

function validateTarget(t, errors) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
        errors.push('`target` is required and must be a mapping.');
        return { product: null, group: null, devices: null, concurrency: 10, fail_fast: false };
    }
    const hasProduct = typeof t.product === 'string' && t.product;
    const hasDevices = Array.isArray(t.devices) && t.devices.length > 0;
    if (!hasProduct && !hasDevices) {
        errors.push('`target.product` or `target.devices` must be provided.');
    }
    if (t.devices !== undefined && !Array.isArray(t.devices)) {
        errors.push('`target.devices` must be a list of device IDs.');
    }
    if (t.group !== undefined && typeof t.group !== 'string') {
        errors.push('`target.group` must be a string.');
    }
    if (t.concurrency !== undefined && (!Number.isInteger(t.concurrency) || t.concurrency <= 0)) {
        errors.push('`target.concurrency` must be a positive integer.');
    }
    if (t.fail_fast !== undefined && typeof t.fail_fast !== 'boolean') {
        errors.push('`target.fail_fast` must be a boolean.');
    }
    return {
        product: hasProduct ? t.product : null,
        group: typeof t.group === 'string' ? t.group : null,
        devices: hasDevices ? [...t.devices] : null,
        concurrency: Number.isInteger(t.concurrency) && t.concurrency > 0 ? t.concurrency : 10,
        fail_fast: !!t.fail_fast,
    };
}

function validateVars(v, errors) {
    if (v === undefined || v === null) return {};
    if (typeof v !== 'object' || Array.isArray(v)) {
        errors.push('`vars` must be a mapping of name → value.');
        return {};
    }
    return { ...v };
}

function validateSteps(s, errors) {
    if (!Array.isArray(s) || s.length === 0) {
        errors.push('`steps` must be a non-empty list.');
        return [];
    }
    const out = [];
    s.forEach((raw, i) => {
        const where = `step[${i}]${raw?.name ? ` "${raw.name}"` : ''}`;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            errors.push(`${where}: must be a mapping.`);
            return;
        }
        const { action, pause_after, when, register, label, ...rest } = raw;
        if (typeof action !== 'string' || !action) {
            errors.push(`${where}: \`action\` is required.`);
            return;
        }
        const spec = ACTION_BY_NAME[action];
        if (!spec) {
            errors.push(`${where}: unknown action "${action}".`);
            return;
        }
        // `name` is usually the step's human label, but actions like
        // `script_install` / `script_delete` declare a `name` of their
        // own. Resolve the clash transparently: if the action owns
        // `name`, route it to params; otherwise treat it as the label.
        // A top-level `label:` field is always honoured as an explicit
        // override for the clashing case.
        const actionOwnsName = spec.params.some((p) => p.name === 'name');
        let stepLabel = null;
        let params;
        if (actionOwnsName) {
            params = rest;
        } else {
            const { name: stepName, ...others } = rest;
            params = others;
            if (typeof stepName === 'string' && stepName) stepLabel = stepName;
        }
        if (typeof label === 'string' && label) stepLabel = label;

        for (const p of spec.params) {
            if (p.required && params[p.name] === undefined) {
                errors.push(`${where}: \`${p.name}\` is required for action "${action}".`);
            }
        }
        if (pause_after !== undefined && (!Number.isFinite(pause_after) || pause_after < 0)) {
            errors.push(`${where}: \`pause_after\` must be a non-negative number of seconds.`);
            return;
        }
        if (when !== undefined && typeof when !== 'string') {
            errors.push(`${where}: \`when\` must be a string expression.`);
            return;
        }
        if (register !== undefined && (typeof register !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(register))) {
            errors.push(`${where}: \`register\` must be a valid identifier (letters, digits, underscore; no leading digit).`);
            return;
        }
        out.push({
            name: stepLabel || spec.summary(params),
            action,
            params,
            pause_after: Number.isFinite(pause_after) ? pause_after : 0,
            when: typeof when === 'string' ? when : null,
            register: typeof register === 'string' ? register : null,
        });
    });
    return out;
}
