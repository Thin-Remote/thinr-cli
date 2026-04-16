// @ts-check
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readConfig } from '../config.js';
import { setBaseURL } from '../api.js';
import { classifyError } from '../output.js';
import { tools } from './registry.js';
import { withProfile } from './helpers.js';

/**
 * Start a generic MCP server for ThinRemote.
 * All tools accept device (when relevant) plus optional user/profile parameters.
 *
 * @param {{ version?: string }} [opts] `version` is echoed back in the
 *   MCP `initialize` response's `serverInfo.version`. Caller is expected
 *   to pass the CLI's `package.json#version` so the two never drift.
 */
export async function startMCPServer({ version = 'unknown' } = {}) {
    const config = readConfig();
    if (config.server) {
        setBaseURL(`https://${config.server}`);
    }

    const server = new Server(
        {
            name: 'thinr',
            version,
        },
        {
            capabilities: { tools: {} },
        },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: tools.map(({ handler: _handler, ...t }) => t),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params.name;
        const args = request.params.arguments || {};
        const tool = tools.find((t) => t.name === name);
        if (!tool) {
            return {
                content: [{ type: 'text', text: `Unknown tool: ${name}` }],
                isError: true,
            };
        }
        try {
            return await withProfile(args.profile, () => tool.handler(args));
        } catch (error) {
            // Surface the same {message, code} pair the CLI emits in JSON
            // mode so MCP clients can pattern-match on `[code]` instead of
            // doing fuzzy matches on the human message.
            const { message, code } = classifyError(error);
            return {
                content: [{ type: 'text', text: `Error [${code}]: ${message}` }],
                isError: true,
                _meta: { code, message },
            };
        }
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[thinr-mcp] Server started');
}
