import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaybook } from '../lib/playbook/loader.js';
import { coerceCliVarValue, listVariables, resolveVarScope } from '../lib/playbook/vars.js';

const stepsOnly = `
steps:
  - action: sleep
    seconds: 1
`;

function makePb(varsYaml) {
    return parsePlaybook(`
target:
  product: demo
vars:
${varsYaml}
${stepsOnly}`);
}

describe('playbook variables — plain form', () => {
    it('normalises scalar values and keeps pb.vars as a flat map', () => {
        const pb = makePb(`  version: "1.2.3"\n  port: 8080\n  debug: true\n`);
        assert.deepEqual(pb.vars, { version: '1.2.3', port: 8080, debug: true });
        const listed = listVariables(pb);
        assert.deepEqual(
            listed.map((v) => ({ name: v.name, type: v.type, default: v.default, overridable: v.overridable, required: v.required })),
            [
                { name: 'version', type: 'string', default: '1.2.3', overridable: true, required: false },
                { name: 'port', type: 'number', default: 8080, overridable: true, required: false },
                { name: 'debug', type: 'boolean', default: true, overridable: true, required: false },
            ],
        );
    });

    it('treats a plain-object value (no metadata keys) as an object default', () => {
        const pb = makePb(`  config:\n    host: api\n    retries: 3\n`);
        assert.deepEqual(pb.vars.config, { host: 'api', retries: 3 });
        const [def] = listVariables(pb);
        assert.equal(def.type, 'object');
        assert.equal(def.overridable, true);
        assert.deepEqual(def.default, { host: 'api', retries: 3 });
    });
});

describe('playbook variables — extended form', () => {
    it('exposes metadata via listVariables()', () => {
        const pb = makePb(
            '  release:\n    default: "v1"\n    description: "Release tag"\n    type: string\n    overridable: true\n    required: false\n',
        );
        const [def] = listVariables(pb);
        assert.deepEqual(def, {
            name: 'release',
            description: 'Release tag',
            type: 'string',
            default: 'v1',
            overridable: true,
            required: false,
        });
        assert.equal(pb.vars.release, 'v1');
    });

    it('omits `default` for required variables without one', () => {
        const pb = makePb('  release:\n    type: string\n    required: true\n');
        const [def] = listVariables(pb);
        assert.equal('default' in def, false);
        assert.equal(def.required, true);
        assert.equal(pb.vars.release, undefined);
    });

    it('accepts mixed plain and extended entries in the same block', () => {
        const pb = makePb(
            '  svc: nginx\n  port:\n    default: 80\n    type: number\n    description: "Listen port"\n',
        );
        const listed = listVariables(pb);
        assert.equal(listed.length, 2);
        assert.equal(listed[0].name, 'svc');
        assert.equal(listed[0].type, 'string');
        assert.equal(listed[0].description, null);
        assert.equal(listed[1].name, 'port');
        assert.equal(listed[1].description, 'Listen port');
        assert.equal(listed[1].default, 80);
    });

    it('rejects unknown metadata keys', () => {
        assert.throws(
            () => makePb('  bad:\n    default: 1\n    flavor: weird\n'),
            /unknown metadata key "flavor"/,
        );
    });

    it('rejects a default that does not match the declared type', () => {
        assert.throws(
            () => makePb('  port:\n    default: "eighty"\n    type: number\n'),
            /does not match declared type number/,
        );
    });

    it('rejects an invalid type name', () => {
        assert.throws(
            () => makePb('  x:\n    default: 1\n    type: banana\n'),
            /`vars.x.type` must be one of: string, number, boolean, object\./,
        );
    });

    it('rejects non-identifier variable names', () => {
        assert.throws(
            () => makePb('  "bad-name": 1\n'),
            /`vars.bad-name` is not a valid identifier/,
        );
    });
});

describe('resolveVarScope', () => {
    it('seeds defaults when no overrides are provided', () => {
        const pb = makePb('  svc: nginx\n  port:\n    default: 80\n    type: number\n');
        const scope = resolveVarScope(pb);
        assert.deepEqual(scope, { svc: 'nginx', port: 80 });
    });

    it('applies valid overrides on top of defaults', () => {
        const pb = makePb('  svc: nginx\n  port:\n    default: 80\n    type: number\n');
        const scope = resolveVarScope(pb, { port: 9090 });
        assert.equal(scope.port, 9090);
        assert.equal(scope.svc, 'nginx');
    });

    it('rejects overrides for variables marked overridable: false', () => {
        const pb = makePb('  token:\n    default: "fixed"\n    overridable: false\n');
        assert.throws(
            () => resolveVarScope(pb, { token: 'other' }),
            /"token" is not overridable/,
        );
    });

    it('rejects overrides with the wrong type', () => {
        const pb = makePb('  port:\n    default: 80\n    type: number\n');
        assert.throws(
            () => resolveVarScope(pb, { port: '9090' }),
            /expects type number, got string/,
        );
    });

    it('rejects overrides for unknown variable names', () => {
        const pb = makePb('  svc: nginx\n');
        assert.throws(
            () => resolveVarScope(pb, { ghost: 'boo' }),
            /Unknown playbook variable: ghost/,
        );
    });

    it('fails when a required variable has neither default nor override', () => {
        const pb = makePb('  release:\n    type: string\n    required: true\n');
        assert.throws(
            () => resolveVarScope(pb, {}),
            /Required playbook variable "release" has no value/,
        );
    });

    it('accepts a required variable when supplied via overrides', () => {
        const pb = makePb('  release:\n    type: string\n    required: true\n');
        const scope = resolveVarScope(pb, { release: 'v2.0.0' });
        assert.equal(scope.release, 'v2.0.0');
    });

    it('layers extras on top of overrides and defaults', () => {
        const pb = makePb('  svc: nginx\n');
        const scope = resolveVarScope(pb, {}, { device: 'dev-42' });
        assert.equal(scope.svc, 'nginx');
        assert.equal(scope.device, 'dev-42');
    });

    it('validates boolean and object types on override', () => {
        const pb = makePb('  debug:\n    default: false\n    type: boolean\n  conf:\n    default: {}\n    type: object\n');
        const ok = resolveVarScope(pb, { debug: true, conf: { a: 1 } });
        assert.equal(ok.debug, true);
        assert.deepEqual(ok.conf, { a: 1 });
        assert.throws(() => resolveVarScope(pb, { debug: 'yes' }), /expects type boolean/);
        assert.throws(() => resolveVarScope(pb, { conf: 'nope' }), /expects type object/);
    });
});

describe('coerceCliVarValue', () => {
    it('passes string variables through unchanged', () => {
        const pb = makePb('  svc: nginx\n');
        assert.equal(coerceCliVarValue(pb, 'svc', 'redis'), 'redis');
    });

    it('parses numeric variables', () => {
        const pb = makePb('  port:\n    default: 80\n    type: number\n');
        assert.equal(coerceCliVarValue(pb, 'port', '9090'), 9090);
    });

    it('rejects numeric overrides that are not finite numbers', () => {
        const pb = makePb('  port:\n    default: 80\n    type: number\n');
        assert.throws(
            () => coerceCliVarValue(pb, 'port', 'eighty'),
            /expects a number/,
        );
    });

    it('parses boolean variables from "true" / "false"', () => {
        const pb = makePb('  debug:\n    default: false\n    type: boolean\n');
        assert.equal(coerceCliVarValue(pb, 'debug', 'true'), true);
        assert.equal(coerceCliVarValue(pb, 'debug', 'false'), false);
        assert.throws(
            () => coerceCliVarValue(pb, 'debug', 'yes'),
            /expects true or false/,
        );
    });

    it('parses object variables via JSON', () => {
        const pb = makePb('  conf:\n    default: {}\n    type: object\n');
        assert.deepEqual(coerceCliVarValue(pb, 'conf', '{"k":1}'), { k: 1 });
        assert.throws(
            () => coerceCliVarValue(pb, 'conf', 'not json'),
            /expects a JSON object\/array/,
        );
    });

    it('passes unknown variable names through so resolveVarScope can reject them', () => {
        const pb = makePb('  svc: nginx\n');
        assert.equal(coerceCliVarValue(pb, 'ghost', 'boo'), 'boo');
    });
});
