// @ts-check
import { connectToDeviceConsole } from '../../lib/console.js';
import { ensureConfigured, runInteractive } from './_shared.js';

export function registerConsoleCommand(device) {
    device
        .command('console <deviceId>')
        .description('Open an interactive terminal on the device')
        .action((deviceId) =>
            runInteractive(() => {
                ensureConfigured();
                return connectToDeviceConsole(deviceId);
            }),
        );
}
