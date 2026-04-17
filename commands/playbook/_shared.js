// @ts-check
import { InvalidArgumentError } from 'commander';
import { configExists } from '../../lib/config.js';
import { setJsonMode, printErr } from '../../lib/output.js';

export function ensureConfigured() {
    if (!configExists()) {
        printErr('Not configured. Run thinr without parameters to set up.', {
            code: 'not_configured',
        });
    }
}

export function applyJsonFlag(opts) {
    if (opts.json) setJsonMode(true);
}

export function getGlobalUser(cmd) {
    let root = cmd;
    while (root.parent) root = root.parent;
    return root.opts().user || null;
}

export function parsePositiveInt(label) {
    return (value) => {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
            throw new InvalidArgumentError(`${label} must be a positive integer`);
        }
        return n;
    };
}

// `-v key=value` pairs: repeatable, merges into a single object. Values
// stay strings — YAML's type coercion does the rest at validate time.
export function collectVar(value, previous = {}) {
    const idx = value.indexOf('=');
    if (idx === -1) throw new InvalidArgumentError('must be key=value');
    return { ...previous, [value.slice(0, idx)]: value.slice(idx + 1) };
}
