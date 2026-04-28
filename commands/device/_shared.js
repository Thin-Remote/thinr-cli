// @ts-check
import { classifyError } from '../../lib/output.js';
import { error as errorStyle } from '../../lib/format.js';

export {
    ensureConfigured,
    applyJsonFlag,
    getGlobalUser,
    parsePositiveInt,
    collectKeyValue,
    collectInput,
    collectVar,
    extractField,
    ProgressSpinner,
    runDeviceCommand,
} from '../_shared.js';

// Wrapper for the proxy / console handlers, which return a Promise that
// resolves with an exit code or rejects with a tagged Error (instead of
// calling process.exit themselves). Kept local to `device/` because only
// the interactive device subcommands use it.
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
