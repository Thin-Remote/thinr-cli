#!/usr/bin/env node

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import figlet from 'figlet';
import { defineIdentity } from '@thinger-io/cli-core/identity';
import { runCli } from '@thinger-io/cli-core/cli';
import { authenticate } from '@thinger-io/cli-core/auth';
import { configExists } from '@thinger-io/cli-core/config';
import { accent, info } from '@thinger-io/cli-core/format';
import { mcpInstructions, thinrIdentity } from '../lib/identity.js';
import { tools as mcpTools } from '../lib/mcp/registry.js';
import { resourceHooks } from '../lib/mcp/resource-hooks.js';
import { guides } from '../lib/guides.js';
import { registerDeviceCommands } from '../commands/device/index.js';
import { registerProductCommands } from '../commands/product/index.js';
import { fleetCommand } from '../commands/fleet/index.js';
import { playbookCommand } from '../commands/playbook/index.js';
import { runDashboard } from '../commands/dashboard.js';

// Single source of truth for the version: package.json. Avoids the drift
// between `package.json#version` and a hardcoded string in this file.
const pkg = JSON.parse(
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'),
);

function displayBanner() {
    console.log(accent(figlet.textSync('thinr-cli', { horizontalLayout: 'full' })));
    console.log(info('Thin Remote CLI - Remote management for IoT devices'));
    console.log();
}

defineIdentity(thinrIdentity);

await runCli({
    version: pkg.version,
    mcpTools,
    resourceHooks,
    docs: guides,
    mcpInstructions,
    register(program, groups) {
        registerDeviceCommands(groups.device);
        registerProductCommands(groups.product);
        fleetCommand(program);
        playbookCommand(program);

        const originalHelp = program.help;
        program.help = function (cb) {
            displayBanner();
            return originalHelp.call(this, cb);
        };
    },
    // Just `thinr`: launch the dashboard when running interactively (signing
    // in first if there is no profile yet). Non-TTY contexts (pipes,
    // scripts, `thinr | cat`) fall back to `--help` so they get something
    // useful instead of an Ink crash.
    async onNoCommand(program) {
        if (!process.stdout.isTTY) program.help();
        if (!configExists()) {
            displayBanner();
            try {
                await authenticate();
            } catch (error) {
                console.error(`Configuration error: ${error.message}`);
                process.exit(1);
            }
        }
        await runDashboard();
    },
});
