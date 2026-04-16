// @ts-check
import { handleProxyAction } from '../../lib/proxy.js';
import { ensureConfigured, runInteractive } from './_shared.js';

export function registerProxyCommands(device) {
    device
        .command('tcp <deviceId> [target]')
        .description('Create a TCP proxy (no TLS). Default target: 22.')
        .option('-p, --port <port>', 'Local port to use (default: random)')
        .action((deviceId, target, opts) =>
            runInteractive(() => {
                ensureConfigured();
                return handleProxyAction(deviceId, 'tcp', target, { port: opts.port });
            }),
        );

    device
        .command('tls <deviceId> [target]')
        .description('Create a TLS proxy. Default target: 443.')
        .option('-p, --port <port>', 'Local port to use (default: random)')
        .action((deviceId, target, opts) =>
            runInteractive(() => {
                ensureConfigured();
                return handleProxyAction(deviceId, 'tls', target, { port: opts.port });
            }),
        );

    device
        .command('http <deviceId> [target]')
        .description('Create an HTTP proxy. Default target: 80.')
        .option('-p, --port <port>', 'Local port to use (default: random)')
        .option('--no-open', 'Do not open the browser')
        .action((deviceId, target, opts) =>
            runInteractive(() => {
                ensureConfigured();
                return handleProxyAction(deviceId, 'http', target, {
                    port: opts.port,
                    openBrowser: opts.open,
                });
            }),
        );
}
