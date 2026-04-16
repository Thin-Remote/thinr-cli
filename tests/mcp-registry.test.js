import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tools } from '../lib/mcp/registry.js';

describe('mcp registry', () => {
    it('exports a non-empty array of tools', () => {
        assert.ok(Array.isArray(tools));
        assert.ok(tools.length > 0);
    });

    it('every tool has name, description, inputSchema and handler', () => {
        for (const t of tools) {
            assert.equal(typeof t.name, 'string', `missing name on ${JSON.stringify(t)}`);
            assert.equal(typeof t.description, 'string', `missing description on ${t.name}`);
            assert.equal(typeof t.inputSchema, 'object', `missing inputSchema on ${t.name}`);
            assert.equal(typeof t.handler, 'function', `missing handler on ${t.name}`);
        }
    });

    it('tool names are unique', () => {
        const names = tools.map((t) => t.name);
        const set = new Set(names);
        assert.equal(set.size, names.length, 'duplicate tool name detected');
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
});
