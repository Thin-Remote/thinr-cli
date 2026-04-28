// @ts-check

/**
 * Very small `{{ name }}` substitution over string values only. We
 * intentionally don't recreate Jinja2 — conditionals and filters belong
 * in a future iteration with a proper templating library. For now the
 * only syntax supported is a bare variable reference, optionally wrapped
 * in whitespace.
 *
 * `scope` is a flat map of variable names to values. Anything referenced
 * but missing from the scope raises a hard error so typos don't silently
 * produce empty strings.
 *
 * @param {any} value
 * @param {any} scope
 * @returns {any}
 */
export function interpolate(value, scope) {
    if (typeof value === 'string') return interpolateString(value, scope);
    if (Array.isArray(value)) return value.map((v) => interpolate(v, scope));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, scope);
        return out;
    }
    return value;
}

const TEMPLATE_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function interpolateString(s, scope) {
    return s.replace(TEMPLATE_RE, (_match, name) => {
        if (!(name in scope)) {
            throw new Error(`Undefined playbook variable: ${name}`);
        }
        const v = scope[name];
        return v == null ? '' : String(v);
    });
}

/** Allowed variable types in the extended `vars` form. */
export const VAR_TYPES = ['string', 'number', 'boolean', 'object'];

/**
 * Check that `value` matches the declared playbook var `type`. Object
 * means non-null object or array (any JSON-serialisable composite).
 *
 * @param {unknown} value
 * @param {string} type
 */
export function checkVarType(value, type) {
    switch (type) {
        case 'string':
            return typeof value === 'string';
        case 'number':
            return typeof value === 'number' && Number.isFinite(value);
        case 'boolean':
            return typeof value === 'boolean';
        case 'object':
            return value !== null && typeof value === 'object';
        default:
            return false;
    }
}

/**
 * Infer a declared type from a plain-form default value. Mirrors the
 * rules in {@link checkVarType}.
 *
 * @param {unknown} value
 * @returns {'string' | 'number' | 'boolean' | 'object'}
 */
export function inferVarType(value) {
    if (typeof value === 'string') return 'string';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number' && Number.isFinite(value)) return 'number';
    return 'object';
}

function describeValueType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

/**
 * Public view of a playbook's declared variables. Consumed by CLI, MCP
 * and the dashboard to render forms and validate overrides. `default`
 * is omitted entirely when the variable was declared without one.
 *
 * @param {{ variables?: Array<{
 *   name: string,
 *   description: string | null,
 *   type: string,
 *   default?: unknown,
 *   hasDefault: boolean,
 *   overridable: boolean,
 *   required: boolean,
 * }> }} pb
 */
export function listVariables(pb) {
    const defs = pb?.variables || [];
    return defs.map((d) => {
        const out = {
            name: d.name,
            description: d.description,
            type: d.type,
            overridable: d.overridable,
            required: d.required,
        };
        if (d.hasDefault) out.default = d.default;
        return out;
    });
}

/**
 * Coerce a CLI-provided raw string `--var key=value` into the declared
 * type of the matching variable. Unknown variables are passed through
 * unchanged so {@link resolveVarScope} can produce the canonical error.
 *
 * Accepted string shapes per type:
 *  - string  → as-is
 *  - number  → anything parsed by `Number` to a finite value
 *  - boolean → the literal strings `"true"` / `"false"`
 *  - object  → a valid JSON document (object or array)
 *
 * @param {any} pb
 * @param {string} name
 * @param {string} raw  Raw CLI value (right-hand side of `key=value`).
 * @returns {unknown}
 */
export function coerceCliVarValue(pb, name, raw) {
    const def = (pb?.variables || []).find((d) => d.name === name);
    if (!def) return raw;
    switch (def.type) {
        case 'number': {
            const n = Number(raw);
            if (!Number.isFinite(n)) {
                throw new Error(`Variable "${name}" expects a number, got "${raw}".`);
            }
            return n;
        }
        case 'boolean':
            if (raw === 'true') return true;
            if (raw === 'false') return false;
            throw new Error(`Variable "${name}" expects true or false, got "${raw}".`);
        case 'object':
            try {
                return JSON.parse(raw);
            } catch (err) {
                throw new Error(
                    `Variable "${name}" expects a JSON object/array, got "${raw}": ${err.message}`,
                    { cause: err },
                );
            }
        case 'string':
        default:
            return raw;
    }
}

/**
 * Build the final interpolation scope for a playbook run. Seeds with
 * declared defaults, applies validated overrides, enforces `required`
 * and `overridable`, then layers runtime-only `extras` (e.g. the
 * implicit `device`) on top. Throws a descriptive Error on any failure.
 *
 * @param {any} pb
 * @param {Record<string, unknown>} [overrides]  External values (CLI / MCP / dashboard).
 * @param {Record<string, unknown>} [extras]     Runtime-only scope additions.
 */
export function resolveVarScope(pb, overrides = {}, extras = {}) {
    const defs = pb?.variables || [];
    const byName = new Map(defs.map((d) => [d.name, d]));

    /** @type {Record<string, unknown>} */
    const scope = {};
    for (const d of defs) {
        if (d.hasDefault) scope[d.name] = d.default;
    }

    for (const [name, value] of Object.entries(overrides || {})) {
        const def = byName.get(name);
        if (!def) {
            throw new Error(`Unknown playbook variable: ${name}`);
        }
        if (!def.overridable) {
            throw new Error(`Playbook variable "${name}" is not overridable.`);
        }
        if (!checkVarType(value, def.type)) {
            throw new Error(
                `Playbook variable "${name}" expects type ${def.type}, got ${describeValueType(value)}.`,
            );
        }
        scope[name] = value;
    }

    for (const d of defs) {
        if (d.required && !(d.name in scope)) {
            throw new Error(`Required playbook variable "${d.name}" has no value.`);
        }
    }

    for (const [name, value] of Object.entries(extras || {})) {
        scope[name] = value;
    }

    return scope;
}
