import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import ora from 'ora';
import { createDeviceAPI } from './device-api.js';

/**
 * Ensure the MCP server is registered in Claude Code for this device
 * @param {string} deviceId - Device ID
 * @param {string} mcpName - MCP server name
 * @param {string} [user] - API user override
 * @returns {boolean} true if newly registered
 */
function ensureMCPRegistered(deviceId, mcpName, user = null) {
    // Check if already registered
    try {
        const list = execSync('claude mcp list 2>&1', { encoding: 'utf8', timeout: 10000 });
        if (list.includes(mcpName)) return false;
    } catch {}

    // Register with device context
    const cmdParts = ['thinr'];
    if (user) cmdParts.push('--user', user);
    cmdParts.push('mcp', '--device', deviceId);
    const args = ['mcp', 'add', mcpName, '-s', 'user', '--', ...cmdParts];

    execSync(`claude ${args.join(' ')}`, { stdio: 'pipe', timeout: 10000 });
    return true;
}

/**
 * Create or update the project directory with CLAUDE.md
 * @param {string} projectDir - Project directory path
 * @param {string} deviceId - Device ID
 * @param {string} deviceName - Human-readable device name
 * @param {string} [user] - API user
 */
function ensureProjectDir(projectDir, deviceId, deviceName, user = null) {
    if (!fs.existsSync(projectDir)) {
        fs.mkdirSync(projectDir, { recursive: true });
    }

    const claudeMd = `# Remote Environment — ${deviceName || deviceId}

You are working on a remote device via ThinRemote.
- Device: ${deviceId}${user ? `\n- User: ${user}` : ''}

## Rules

- Use \`remote_exec\` for ALL command execution. Do NOT use the built-in Bash tool.
- Use \`remote_read\` to read files from the server.
- Use \`remote_write\` to write files to the server.
- Use \`remote_ls\` to list directories.
- All paths are absolute paths on the remote device (e.g., /home, /etc, /var/log).
`;

    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), claudeMd);
}

/**
 * Launch a remote environment: register MCP + create project + launch command
 * @param {string} deviceId - Device ID
 * @param {string} mountpoint - Project directory path
 * @param {string[]} command - Command and args to run (e.g., ['claude'])
 * @param {Object} [options] - Options
 * @param {string} [options.user] - API user override
 */
export async function launchEnv(deviceId, mountpoint, command = [], options = {}) {
    const api = createDeviceAPI(deviceId, { user: options.user });
    const projectDir = path.resolve(mountpoint || path.join(os.tmpdir(), `thinr-${deviceId}`));

    // 1. Verify device connectivity
    const statusSpinner = ora(`Checking device ${deviceId}...`).start();
    let deviceName = deviceId;
    try {
        const result = await api.exec('hostname', 5);
        deviceName = result.stdout?.trim() || deviceId;
        statusSpinner.succeed(`Device ${chalk.bold(deviceName)} is online`);
    } catch (error) {
        statusSpinner.fail(`Cannot reach device ${deviceId}`);
        throw new Error(`Device not reachable: ${error.message}`);
    }

    // 2. Register MCP server in Claude Code
    const mcpName = options.user ? `${options.user}-${deviceId}` : deviceId;
    const mcpSpinner = ora('Configuring MCP server...').start();
    try {
        const isNew = ensureMCPRegistered(deviceId, mcpName, options.user);
        mcpSpinner.succeed(isNew
            ? `MCP server ${chalk.cyan(mcpName)} registered`
            : `MCP server ${chalk.cyan(mcpName)} ready`);
    } catch (error) {
        mcpSpinner.fail('Failed to register MCP server');
        throw error;
    }

    // 3. Create project directory with CLAUDE.md
    ensureProjectDir(projectDir, deviceId, deviceName, options.user);

    // 4. Determine command to run
    let cmd, args;
    if (command.length === 0) {
        cmd = 'claude';
        args = [];
    } else {
        cmd = command[0];
        args = command.slice(1);
    }

    console.log(chalk.green(`\nLaunching ${chalk.bold(cmd)} for ${chalk.bold(deviceName)}...`));
    console.log(chalk.gray(`  MCP:     ${mcpName}`));
    console.log(chalk.gray(`  Project: ${projectDir}\n`));

    // 5. Spawn the command
    const child = spawn(cmd, args, {
        cwd: projectDir,
        stdio: 'inherit',
    });

    return new Promise((resolve, reject) => {
        child.on('exit', (code) => resolve(code || 0));
        child.on('error', (error) => reject(error));
        process.on('SIGINT', () => child.kill('SIGINT'));
        process.on('SIGTERM', () => child.kill('SIGTERM'));
    });
}
