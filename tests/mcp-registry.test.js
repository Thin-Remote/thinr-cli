import './setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTools } from '@thinger-io/cli-core/mcp/registry';
import { tools as thinrTools } from '../lib/mcp/registry.js';
import { resourceHooks } from '../lib/mcp/resource-hooks.js';
import { resourceActions, resourceTypes } from '../lib/mcp/resource-types.js';
import { guides } from '../lib/guides.js';
import { mcpInstructions } from '../lib/identity.js';
import fs from 'node:fs';

// What the MCP server serves: the generic tools of the core, over the
// server's types and thinr's, plus thinr's one tool.
const tools = buildTools(thinrTools, {
    hooks: resourceHooks,
    types: resourceTypes,
    actions: resourceActions,
});
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

describe('mcp registry', () => {
    it("serves the generic tools and thinr's own", () => {
        const names = new Set(tools.map((t) => t.name));
        for (const name of ['thinr_resource_list', 'thinr_bucket_data_read', 'thinr_doc_read']) {
            assert.ok(names.has(name), `generic ${name} missing`);
        }
        // thinr's only own tool: the rest are resource types and actions.
        assert.deepEqual(
            thinrTools.map((t) => t.name),
            ['device_exec'],
        );
        assert.equal(tools.length, 24);
    });

    it('serves its resource types and actions through the generic tools', () => {
        const typeEnum = (tool) => byName[tool].inputSchema.properties.type.enum;
        for (const type of Object.keys(resourceTypes)) {
            assert.ok(typeEnum('thinr_resource_list').includes(type), `${type} not listable`);
            assert.ok(typeEnum('thinr_resource_describe').includes(type), type);
        }
        for (const type of ['device_fs', 'product_playbook', 'device']) {
            assert.ok(typeEnum('thinr_resource_call').includes(type), `${type} has no actions`);
        }
        assert.deepEqual(Object.keys(resourceActions.device), ['agent_update', 'agent_install']);
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

    // ThinRemote adds to the generic tools through hooks, not by replacing
    // them: a device read also asks its agent, a product delete also drops
    // its script storage.
    it('extends the generic device and product tools through hooks', () => {
        assert.equal(typeof resourceHooks.device.afterGet, 'function');
        assert.equal(typeof resourceHooks.product.afterDelete, 'function');
        assert.ok(!tools.some((t) => /^thinr_(device_info|product_delete)$/.test(t.name)));
    });

    it("thinr's own names follow <object>[_<sub>]_<verb>", () => {
        const verbs =
            /_(list|get|describe|create|update|delete|clone|call|read|write|send|exec|move|push|pull|run|validate|rollout|publish|add|remove|presets|default)$/;
        for (const t of thinrTools) assert.match(t.name, verbs, t.name);
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

    it('every tool (except thinr_profile_list) has the injected `profile` option', () => {
        for (const t of tools) {
            if (t.name === 'thinr_profile_list') continue;
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

    // Descriptions stay short and point at the guides for the how-to: every
    // guide they name must exist, and ship with the package.
    it('points only at guides that exist', () => {
        const ids = new Set(guides.map((g) => g.id));
        for (const g of guides) assert.ok(fs.existsSync(g.file), `${g.id}: missing ${g.file}`);
        const text = JSON.stringify([
            ...tools.map(({ handler: _h, ...t }) => t),
            ...Object.values(resourceTypes).map((t) => t.notes),
        ]);
        const refs = [
            ...text.matchAll(/(?:thinr_doc_read|\{tool:doc_read\}) id \\"([a-z0-9-]+)\\"/g),
        ];
        for (const [, id] of refs) {
            assert.ok(ids.has(id), `descriptions refer to unknown guide ${id}`);
        }
        assert.ok(refs.some(([, id]) => id === 'thinremote-scripts'));
    });

    it('instructions name tools that exist', () => {
        const names = new Set(tools.map((t) => t.name));
        for (const ref of mcpInstructions.match(/thinr_[a-z_]+/g) || []) {
            if (ref.endsWith('_')) continue; // thinr_resource_list / _get… shorthand
            assert.ok(names.has(ref), `instructions mention ${ref}`);
        }
    });
});
