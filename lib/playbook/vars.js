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
