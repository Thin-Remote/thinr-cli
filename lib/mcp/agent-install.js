// @ts-check
import { requireConfig } from '@thinger-io/cli-core/config';
import { inputError } from '@thinger-io/cli-core/errors';

const CHANNEL_SCRIPT = {
    latest: 'install.sh',
    main: 'install-main.sh',
    develop: 'install-develop.sh',
};

function shQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function decodeJwtClaims(token) {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    try {
        const pad = parts[1].length % 4 === 0 ? '' : '='.repeat(4 - (parts[1].length % 4));
        const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/') + pad;
        return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
    } catch {
        return null;
    }
}

/**
 * The command that installs the agent on a new machine: the `agent_install`
 * action of the `device` type (see resource-types.js).
 *
 * @param {{ device?: string, product?: string, channel?: string, sudo?: boolean,
 *   overwrite?: boolean, no_start?: boolean, no_verify_ssl?: boolean, http?: boolean }} args
 */
export async function agentInstallCommand(args) {
    // requireConfig throws `not_configured` if there's no active profile
    // with a token — classifyError in server.js surfaces that cleanly.
    const config = requireConfig();

    const channel = args.channel || 'latest';
    const script = CHANNEL_SCRIPT[channel];
    if (!script) {
        throw inputError(
            `Unknown channel "${channel}". Valid channels: ${Object.keys(CHANNEL_SCRIPT).join(', ')}.`,
        );
    }

    const scheme = args.http ? 'http' : 'https';
    const url = `${scheme}://get.thinremote.io/${script}`;

    const agentArgs = ['install', '--token', shQuote(config.token)];
    if (args.device) agentArgs.push('--device', shQuote(args.device));
    if (args.product) agentArgs.push('--product', shQuote(args.product));
    if (args.overwrite) agentArgs.push('--overwrite');
    if (args.no_start) agentArgs.push('--no-start');
    if (args.no_verify_ssl) agentArgs.push('--no-verify-ssl');

    const runner = args.sudo ? 'sudo sh' : 'sh';
    const command = `curl -fsSL ${url} | ${runner} -s -- ${agentArgs.join(' ')}`;

    // The agent's `install --token` flow decodes the JWT and requires
    // both `svr` and `usr` claims. Permanent user tokens minted via
    // /v1/users/{user}/tokens are missing `svr` on some server versions,
    // which makes auto-provisioning fail with "Invalid token". Warn up
    // front so the caller can switch to an OAuth-issued token or ask
    // the platform for a proper provisioning token.
    const claims = decodeJwtClaims(config.token);
    const warnings = [];
    if (!claims) {
        warnings.push(
            'The active profile token is not a decodable JWT. Auto-provisioning expects a JWT with `svr` and `usr` claims.',
        );
    } else {
        if (!claims.svr) {
            warnings.push(
                `The profile token is missing the \`svr\` claim. The agent will reject it with "Invalid token: missing 'svr' or 'usr' claim". Re-authenticate this profile via OAuth (\`thinr\`) or generate a provisioning token from the ${config.server} console.`,
            );
        }
        if (!claims.usr) {
            warnings.push('The profile token is missing the `usr` claim.');
        }
    }

    const sections = [
        `Server:  ${config.server}`,
        `User:    ${config.username}`,
        `Channel: ${channel}`,
        '',
        'Run on the target host (directly or via `ssh host "<command>"`):',
        '',
        command,
        '',
        'Notes:',
        "- The command embeds the active profile's API token — treat it as a credential.",
        '- Installing the system service needs root. Pass `sudo: true` if the target host is not already root.',
        '- The agent reads the target server from the JWT, so `--host` is not needed.',
    ];

    if (warnings.length) {
        sections.push('', 'Warnings:', ...warnings.map((w) => `- ${w}`));
    }

    return sections.join('\n');
}
