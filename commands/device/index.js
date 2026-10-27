// @ts-check
import { registerProxyCommands } from './proxy.js';
import { registerConsoleCommand } from './console.js';
import { registerStatusCommand } from './status.js';
import { registerExecCommand } from './exec.js';
import { registerTransferCommands } from './transfer.js';
import { registerFsCommands } from './fs.js';
import { registerLogsCommand } from './logs.js';

/**
 * `thinr device <verb> <device> …` — the agent-backed actions (console,
 * proxies, exec, files, logs, status), added to the generic `device` group
 * of @thinger-io/cli-core, which holds its records, properties, resources
 * and children. Agent updates are `thinr agent`.
 */
export function registerDeviceCommands(device) {
    registerProxyCommands(device);
    registerConsoleCommand(device);
    registerStatusCommand(device);
    registerExecCommand(device);
    registerTransferCommands(device);
    registerFsCommands(device);
    registerLogsCommand(device);
}
