// @ts-check
import { InvalidArgumentError } from 'commander';
import { configExists } from '../../lib/config.js';
import { setJsonMode, classifyError, printErr } from '../../lib/output.js';
import { error as errorStyle } from '../../lib/format.js';

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

// Walks up to the root program so subcommands can read `--user` regardless
// of nesting depth.
export function getGlobalUser(cmd) {
    let root = cmd;
    while (root.parent) root = root.parent;
    return root.opts().user || null;
}

// Collect repeatable `-i key=value` pairs into a single object. Uses
// Commander's InvalidArgumentError so a bad value prints a clean
// "error: option … argument is invalid" line instead of a stack trace.
export function collectInput(value, previous = {}) {
    const idx = value.indexOf('=');
    if (idx === -1) throw new InvalidArgumentError('must be key=value');
    return { ...previous, [value.slice(0, idx)]: value.slice(idx + 1) };
}

// Wrapper for the proxy / console handlers, which return a Promise that
// resolves with an exit code or rejects with a tagged Error (instead of
// calling process.exit themselves).
export const runInteractive = async (fn) => {
    try {
        const exitCode = await fn();
        process.exit(exitCode ?? 0);
    } catch (error) {
        const { message, code } = classifyError(error);
        console.error(errorStyle(`Error [${code}]: ${message}`));
        process.exit(1);
    }
};
