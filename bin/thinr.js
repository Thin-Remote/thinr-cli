#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import figlet from 'figlet';
import ora from 'ora';
import { configExists, readConfig, setActiveProfile } from '../lib/config.js';
import { detectJsonModeFromArgv } from '../lib/output.js';

// Pick up --profile early so subsequent config reads use the right one.
// Commander parses options later, but the config is touched before that.
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--profile' && process.argv[i + 1]) { setActiveProfile(process.argv[i + 1]); break; }
    if (a.startsWith('--profile=')) { setActiveProfile(a.slice('--profile='.length)); break; }
}

// Set JSON mode before any command runs so spinners/logs can opt out.
detectJsonModeFromArgv();
import { authenticate } from '../lib/auth.js';
import { deviceCommand } from '../commands/device.js';
import { logoutCommand } from '../commands/logout.js';
import { productCommand } from "../commands/product.js";
import { profileCommand } from '../commands/profile.js';
import { setBaseURL } from '../lib/api.js';
import { startMCPServer } from '../lib/mcp-server.js';

// Function to display the banner
function displayBanner() {
    console.log(
        chalk.cyan(
            figlet.textSync('thinr-cli', { horizontalLayout: 'full' })
        )
    );
    console.log(chalk.blue('Thin Remote CLI - Remote management for IoT devices'));
    console.log();
}

const program = new Command();

// Set up CLI information
program
    .name('thinr')
    .description('CLI for ThinRemote - Remote management for IoT devices')
    .version('1.0.2')
    .option('-u, --user <username>', 'API user override (admin impersonation)')
    .option('--profile <name>', 'Configuration profile to use (defaults to the saved default)');

// Register commands
deviceCommand(program);
productCommand(program);
profileCommand(program);
logoutCommand(program);

program
    .command('mcp')
    .description('Start MCP server for AI tool integration')
    .option('-d, --device <deviceId>', 'Default device ID')
    .action(async (options) => {
        // Allow env vars to set defaults (used by thinr env)
        if (options.device) process.env.THINR_DEVICE = options.device;
        if (program.opts().user) process.env.THINR_USER = program.opts().user;
        try {
            await startMCPServer();
        } catch (error) {
            console.error(`Error: ${error.message}`);
            process.exit(1);
        }
    });

// Handle help
const originalHelp = program.help;
program.help = function(cb) {
    displayBanner();
    return originalHelp.call(this, cb);
};

// initialize API base URL
if (configExists()) {
    const config = readConfig();
    if (config.server) {
        // Initialize API with the server if configured
        setBaseURL(`https://${config.server}`);
    }
}

// Handle no command (just "thinr")
if (process.argv.length <= 2) {
    const spinner = ora('Checking configuration...').start();

    try {
        if (!configExists()) {
            // Display banner only if configuration doesn't exist
            displayBanner();
            spinner.succeed('No configuration found. Starting setup...');
            await authenticate();
            program.help();
        } else {
            spinner.succeed('Configuration found');
            // Show help if already configured, but don't display banner twice
            program.help();
        }
    } catch (error) {
        spinner.fail(`Configuration error: ${error.message}`);
        process.exit(1);
    }
    spinner.succeed('Configuration found');
} else {
    // Parse arguments - don't show banner for regular commands
    program.parse(process.argv);
}
