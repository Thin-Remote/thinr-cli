#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import figlet from 'figlet';
import ora from 'ora';
import { configExists } from '../lib/config.js';
import { authenticate } from '../lib/auth.js';
import { deviceCommand } from '../commands/device.js';
import { logoutCommand } from '../commands/logout.js';
import { productCommand } from "../commands/product.js";
import { setBaseURL } from '../lib/api.js';

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
    .version('1.0.0');

// Register commands
deviceCommand(program);
productCommand(program);
logoutCommand(program);

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