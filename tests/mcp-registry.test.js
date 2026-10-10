import './setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTools } from '@thinger-io/cli-core/mcp/registry';
import { tools as thinrTools } from '../lib/mcp/registry.js';

// What the MCP server serves: the generic tools of the core plus thinr's.
const tools = buildTools(thinrTools);

describe('mcp registry', () => {
    it("serves the generic tools and thinr's own", () => {
        const names = new Set(tools.map((t) => t.name));
        for (const name of ['thinr_devices', 'thinr_bucket_read', 'thinr_token_list']) {
            assert.ok(names.has(name), `generic ${name} missing`);
        }
        for (const name of ['thinr_exec', 'thinr_ls', 'thinr_playbook_run', 'thinr_monitoring']) {
            assert.ok(names.has(name), `thinr ${name} missing`);
        }
    });

    it('every tool has name, description, inputSchema and handler', () => {
        for (const t of tools) {
            assert.equal(typeof t.name, 'string', `missing name on ${JSON.stringify(t)}`);
            assert.equal(typeof t.description, 'string', `missing description on ${t.name}`);
            assert.equal(typeof t.inputSchema, 'object', `missing inputSchema on ${t.name}`);
            assert.equal(typeof t.handler, 'function', `missing handler on ${t.name}`);
        }
    });

    it('tool names are unique and prefixed with thinr_', () => {
        const names = tools.map((t) => t.name);
        assert.equal(new Set(names).size, names.length, 'duplicate tool name detected');
        for (const name of names) assert.match(name, /^thinr_[a-z0-9_]+$/);
    });

    it("thinr's agent-aware tools replace the generic ones", () => {
        const info = tools.filter((t) => t.name === 'thinr_device_info');
        assert.equal(info.length, 1);
        assert.match(info[0].description, /hostname/);
        const del = tools.filter((t) => t.name === 'thinr_product_delete');
        assert.equal(del.length, 1);
        assert.ok(del[0].inputSchema.properties.keep_storage);
    });

    it('every required field is declared in properties', () => {
        for (const t of tools) {
            const required = t.inputSchema.required || [];
            const properties = t.inputSchema.properties || {};
            for (const field of required) {
                assert.ok(
                    field in properties,
                    `${t.name}.required lists "${field}" but it's missing from properties`,
                );
            }
        }
    });

    it('every tool (except thinr_profiles) has the injected `profile` option', () => {
        for (const t of tools) {
            if (t.name === 'thinr_profiles') continue;
            assert.ok(
                t.inputSchema.properties?.profile,
                `${t.name} is missing the injected profile param`,
            );
        }
    });

    it('descriptions are fully expanded and name only thinr tools', () => {
        const text = JSON.stringify(tools.map(({ handler: _h, ...t }) => t));
        assert.doesNotMatch(text, /\{(tool|family):/);
        assert.doesNotMatch(text, /thinger_/);
    });
});
