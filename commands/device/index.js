// @ts-check
import { registerProxyCommands } from './proxy.js';
import { registerConsoleCommand } from './console.js';
import { registerStatusCommand } from './status.js';
import { registerExecCommand } from './exec.js';
import { registerUpdateCommand } from './update.js';
import { registerTransferCommands } from './transfer.js';
import { registerFsCommands } from './fs.js';
import { registerLogsCommand } from './logs.js';

/**
 * `thinr device <subcommand> [<deviceId>] …` — the agent-backed actions
 * (console, proxies, exec, files, logs, status, agent updates), added to
 * the generic `device` group of @thinger-io/cli-core, which already holds
 * list, info, create, delete, set-product, property and resource.
 */
export function registerDeviceCommands(device) {
    registerProxyCommands(device);
    registerConsoleCommand(device);
    registerStatusCommand(device);
    registerExecCommand(device);
    registerUpdateCommand(device);
    registerTransferCommands(device);
    registerFsCommands(device);
    registerLogsCommand(device);
}
