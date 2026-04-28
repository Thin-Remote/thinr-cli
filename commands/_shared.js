// @ts-check
import { InvalidArgumentError } from 'commander';
import { configExists } from '../lib/config.js';
import {
    setJsonMode,
    isJsonMode,
    printOk,
    printErr,
    createSpinner,
    classifyError,
} from '../lib/output.js';

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

export function parsePositiveInt(label) {
    return (value) => {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
            throw new InvalidArgumentError(`${label} must be a positive integer`);
        }
        return n;
    };
}

// Collect repeatable `-i key=value` / `-v key=value` pairs into a single
// object. Uses Commander's InvalidArgumentError so a bad value prints a
// clean "error: option … argument is invalid" line instead of a stack trace.
export function collectKeyValue(value, previous = {}) {
    const idx = value.indexOf('=');
    if (idx === -1) throw new InvalidArgumentError('must be key=value');
    return { ...previous, [value.slice(0, idx)]: value.slice(idx + 1) };
}

// Historical aliases kept so existing subcommands don't need renaming at
// the call sites. Same function, different names where it reads better.
export const collectInput = collectKeyValue;
export const collectVar = collectKeyValue;

// Resolve a dot-path against a nested object. Returns `undefined` as soon
// as any intermediate hop is missing — matching the previous inline
// `reduce((o, k) => o && o[k], obj)` behaviour across the CLI.
export function extractField(obj, path) {
    if (!path) return obj;
    return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

/**
 * Live counter for fan-out spinners. Wraps an ora spinner and rewrites
 * its text as work enters/leaves the pool and completes. Use it to avoid
 * reimplementing the `done/in flight` bookkeeping in every fan-out
 * command (product exec, product fs, product push, playbook run…).
 *
 *   const progress = new ProgressSpinner(spinner, devices.length,
 *       ({ done, total, inFlight }) =>
 *           `Running on ${total} devices — ${done}/${total} done · ${inFlight} in flight`);
 *   progress.render();
 *   // inside worker:
 *   progress.startItem();
 *   // …
 *   progress.finishItem();
 */
export class ProgressSpinner {
    constructor(spinner, total, formatText) {
        this.spinner = spinner;
        this.total = total;
        this.formatText = formatText;
        this.done = 0;
        this.inFlight = 0;
    }

    render() {
        this.spinner.text = this.formatText({
            done: this.done,
            total: this.total,
            inFlight: this.inFlight,
        });
    }

    startItem() {
        this.inFlight++;
        this.render();
    }

    finishItem() {
        this.inFlight--;
        this.done++;
        this.render();
    }

    stop() {
        this.spinner.stop();
    }
}

/**
 * One-shot command skeleton shared by read-only device subcommands
 * (status, list, property, resource…). Handles the spinner start,
 * try/catch, `classifyError`+`printErr` on failure, and the
 * `isJsonMode() ? printOk : console.log` default for the success path.
 *
 * Shape:
 *   await runDeviceCommand({
 *       start: 'Fetching devices…',          // spinner label
 *       fn: () => getDevices(filter),        // async unit of work
 *       success: n => `Found ${n} device(s)`,// string | (result) => string | null
 *       failure: 'Failed to list devices',   // string on failure
 *       onSuccess: (result) => { … },        // optional full render override
 *   });
 *
 * When `success` is `null` the spinner just stops (no checkmark), which
 * matches the idiom used by commands whose output block already speaks
 * for the "found" state. When `onSuccess` is omitted the result is
 * printed verbatim (`printOk` in JSON mode, `console.log` otherwise).
 */
export async function runDeviceCommand({ start, fn, success, failure, onSuccess }) {
    const spinner = createSpinner(start).start();
    try {
        const result = await fn();
        if (success === null) {
            spinner.stop();
        } else {
            spinner.succeed(typeof success === 'function' ? success(result) : success);
        }
        if (onSuccess) {
            await onSuccess(result);
        } else if (isJsonMode()) {
            printOk(result);
        } else {
            console.log(result);
        }
    } catch (error) {
        spinner.fail(typeof failure === 'function' ? failure(error) : failure);
        const { message, code } = classifyError(error);
        printErr(message, { code });
    }
}
