import './setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTools } from '@thinger-io/cli-core/mcp/registry';
import { resourceHooks } from '../lib/mcp/resource-hooks.js';
import { resourceActions, resourceTypes } from '../lib/mcp/resource-types.js';
import { guides } from '../lib/guides.js';
import { mcpInstructions } from '../lib/identity.js';
import fs from 'node:fs';

// What the MCP server serves: the eight resource tools of the core, over
// the server's types, the core's and thinr's.
const tools = buildTools({
    hooks: resourceHooks,
    types: resourceTypes,
    actions: resourceActions,
});
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

describe('mcp registry', () => {
    it('serves the eight resource tools and nothing else', () => {
        assert.deepEqual(
            tools.map((t) => t.name).sort(),
            ['call', 'clone', 'create', 'delete', 'describe', 'get', 'list', 'update'].map(
                (v) => `thinr_resource_${v}`,
            ),
        );
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
        assert.deepEqual(Object.keys(resourceActions.device), [
            'exec',
            'agent_update',
            'agent_install',
        ]);
        const actions = byName.thinr_resource_call.inputSchema.properties.action.enum;
        for (const a of ['exec', 'agent_update', 'agent_install', 'rollout', 'validate', 'run']) {
            assert.ok(actions.includes(a), `action ${a} not offered`);
        }
        // Dashboard metrics and log sources are product properties now.
        assert.ok(!('product_metric' in resourceTypes));
        assert.ok(!('product_log_source' in resourceTypes));
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
        assert.equal(typeof resourceHooks.product_property.beforeCreate, 'function');
        assert.equal(typeof resourceHooks.product_property.describe, 'function');
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

    it('every tool has the injected `profile` option', () => {
        for (const t of tools) {
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
            mcpInstructions,
        ]);
        const refs = [
            ...text.matchAll(
                /(?:thinr_resource_get type \\"doc\\"|\{op:doc\.get\}) ids \{\\"doc\\": \\"([a-z0-9-]+)\\"\}/g,
            ),
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

    it('instructions name types and actions that exist', () => {
        const types = new Set(byName.thinr_resource_describe.inputSchema.properties.type.enum);
        const actions = new Set(byName.thinr_resource_call.inputSchema.properties.action.enum);
        const named = [...mcpInstructions.matchAll(/type "([a-z_]+)"/g)].map((m) => m[1]);
        assert.ok(named.length > 4);
        for (const type of named) assert.ok(types.has(type), `instructions mention type ${type}`);
        for (const [, action] of mcpInstructions.matchAll(/action "([a-z_]+)"/g)) {
            assert.ok(actions.has(action), `instructions mention action ${action}`);
        }
        assert.doesNotMatch(mcpInstructions, /\b(parent|id) "|_doc_read|_device_exec/);
    });
});
