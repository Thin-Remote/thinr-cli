// @ts-check
import { InvalidArgumentError } from 'commander';
// Helpers shared with every CLI on @thinger-io/cli-core; `runDeviceCommand`
// is the name thinr's subcommands have always used for its `runCommand`.
export {
    applyJsonFlag,
    ensureConfigured,
    extractField,
    getGlobalUser,
    parsePositiveInt,
    runCommand as runDeviceCommand,
} from '@thinger-io/cli-core/commands/_shared';

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
