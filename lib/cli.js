// @ts-check
import figlet from 'figlet';
import { authenticate } from '@thinger-io/cli-core/auth';
import { configExists } from '@thinger-io/cli-core/config';
import { accent, info } from '@thinger-io/cli-core/format';
import { mcpInstructions } from './identity.js';
import { resourceHooks } from './mcp/resource-hooks.js';
import { resourceActions, resourceTypes } from './mcp/resource-types.js';
import { guides } from './guides.js';
import { registerDeviceCommands } from '../commands/device/index.js';
import { registerProductCommands } from '../commands/product/index.js';
import { agentCommand } from '../commands/agent/index.js';
import { playbookCommand } from '../commands/playbook/index.js';
import { runDashboard } from '../commands/dashboard.js';

/**
 * What thinr adds to the CLI of @thinger-io/cli-core: its commands, MCP
 * tools, resource types and guides. `bin/thinr.js` runs it with runCli;
 * the tests build the same tree with buildProgram.
 */

function displayBanner() {
    console.log(accent(figlet.textSync('thinr-cli', { horizontalLayout: 'full' })));
    console.log(info('Thin Remote CLI - Remote management for IoT devices'));
    console.log();
}

/**
 * Exceptions of thinr's commands to the grammar of cli-core
 * (`checkGrammar`): the verbs of a remote shell and file system, its
 * groups, and the options it published with another meaning.
 *
 * @type {import('@thinger-io/cli-core/commands/grammar').GrammarExceptions}
 */
export const grammarExceptions = {
    root: ['agent', 'playbook'],
    verbs: [
        // Remote access and execution.
        'tcp',
        'tls',
        'http',
        'console',
        'exec',
        'status',
        'logs',
        // Files of a device (`read` and `write` are verbs already).
        'ls',
        'mkdir',
        'rm',
        'mv',
        'push',
        'pull',
        // Agent, fan-outs, playbooks and log sources.
        'check',
        'device-property',
        'device-resource',
        'run',
        'validate',
        'set-default',
        'presets',
    ],
    shorts: {
        'device logs': { '-f': '--follow' },
        'device mv': { '-f': '--force' },
        'product mv': { '-f': '--force' },
    },
    skip: {
        // Interactive sessions.
        'device console': ['json'],
        'device tcp': ['json'],
        'device tls': ['json'],
        'device http': ['json'],
        // A file written on the device, a log source, an agent update: not JSON bodies.
        'device write': ['body'],
        'product logs create': ['body'],
        'agent update': ['body'],
        // Entries of a product property: short lists.
        'product logs list': ['list'],
        'product metric list': ['list'],
        'product playbook list': ['list'],
        // The presets ship with thinr: they belong to no product.
        'product logs presets': ['parents'],
    },
};

/** @type {Omit<Parameters<typeof import('@thinger-io/cli-core/cli').runCli>[0], 'version'>} */
export const cliOptions = {
    resourceHooks,
    resourceTypes,
    resourceActions,
    docs: guides,
    mcpInstructions,
    argumentHelp: {
        byCommand: {
            'device tcp': { target: 'Port on the device, or host:port (default: 22)' },
            'device tls': { target: 'Port on the device, or host:port (default: 443)' },
            'device http': { target: 'Port on the device, or host:port (default: 80)' },
            'device exec': { command: 'Command to run on the device' },
            'device ls': { path: 'Folder on the device (default: /)' },
            'device read': { path: 'File on the device' },
            'device write': {
                path: 'File on the device',
                content: 'What to write (default: stdin)',
            },
            'device mkdir': { path: 'Folder to create on the device' },
            'device rm': { path: 'File or folder to delete on the device' },
            'device mv': { source: 'Path on the device', destination: 'New path on the device' },
            'device push': {
                'local-path': 'Local file or folder',
                'remote-path': 'Where on the device',
            },
            'device pull': {
                'remote-path': 'File or folder on the device',
                'local-path': 'Where to save it',
            },
            'product exec': { command: 'Command to run on every device' },
            'product mkdir': { path: 'Folder to create on every device' },
            'product rm': { path: 'File or folder to delete on every device' },
            'product mv': { source: 'Path on the devices', destination: 'New path on the devices' },
            'product push': {
                'local-path': 'Local file or folder',
                'remote-path': 'Where on every device',
            },
            'product device-property': { property: 'Property to read on every device' },
            'product device-resource': { resource: 'Resource to call on every device' },
            'product metric set': { name: 'Name of the metric' },
            'product metric delete': { name: 'Name of the metric' },
            'product logs get': { name: 'Name of the log source' },
            'product logs create': { name: 'Name of the log source' },
            'product logs delete': { name: 'Name of the log source' },
            'product logs set-default': { name: 'Name of the log source' },
            'product playbook upload': {
                name: 'Name of the playbook',
                file: 'YAML file (default: stdin)',
            },
            'product playbook download': { name: 'Name of the playbook' },
            'product playbook delete': { name: 'Name of the playbook' },
            'product playbook run': { name: 'Name of the playbook' },
            'playbook run': { file: 'Playbook file (YAML)' },
            'playbook validate': { file: 'Playbook file (YAML)' },
        },
    },
    register(program, groups) {
        registerDeviceCommands(groups.device);
        registerProductCommands(groups.product);
        agentCommand(program);
        playbookCommand(program);

        const originalHelp = program.help;
        /** @type {any} */ (program).help = function (cb) {
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
};
