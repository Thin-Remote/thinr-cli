#!/usr/bin/env node
// @ts-check

/**
 * End-to-end integration test for the product-playbook workflow.
 *
 * Hits a real ThinRemote cloud using the currently active CLI profile
 * (see `thinr` / `~/.config/thinr-cli/config.json`). Creates a throw-
 * away product, exercises upload / list / download / replace / reject
 * / delete paths, and — when a test device is available — runs the
 * playbook end-to-end in `check` mode with and without var overrides.
 *
 * Cleanup is unconditional: the `finally` block drops the product and
 * its companion file storage even if any assertion failed halfway.
 *
 * Usage:
 *   node tests/integration/playbook-e2e.js           # full flow
 *   node tests/integration/playbook-e2e.js --offline # parse/plan only
 *
 * Env vars:
 *   THINR_E2E_DEVICE   Device id used for the check-mode run phase.
 *                      Omit to skip that phase.
 *   THINR_PROFILE      CLI profile to use (honoured by lib/config.js).
 */

import process from 'node:process';
import { randomBytes } from 'node:crypto';

import { getActiveProfile, readConfig } from '../../lib/config.js';
import {
    createProduct,
    deleteProductPlaybook,
    deleteProductWithStorage,
    listProductPlaybooks,
    productExists,
    readProductPlaybook,
    uploadProductPlaybook,
} from '../../lib/product.js';
import { parsePlaybook } from '../../lib/playbook/loader.js';
import { listVariables, resolveVarScope } from '../../lib/playbook/vars.js';
import { buildDryRunPlan, runPlaybook } from '../../lib/playbook/runner.js';
import { getDevice } from '../../lib/devices.js';

const PREFIX = 'playbook-e2e-';

function ts() {
    return new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
}

function makeProductId() {
    return `${PREFIX}${ts()}-${randomBytes(3).toString('hex')}`;
}

function log(msg) {
    process.stdout.write(`${msg}\n`);
}

function section(title) {
    log(`\n== ${title} ==`);
}

class E2EError extends Error {}

function fail(msg) {
    throw new E2EError(msg);
}

function assertEqual(actual, expected, label) {
    if (actual !== expected) {
        fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function assertDeepEqual(actual, expected, label) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) fail(`${label}: expected ${b}, got ${a}`);
}

async function expectReject(fn, pattern, label) {
    let caught;
    try {
        await fn();
    } catch (err) {
        caught = err;
    }
    if (!caught) fail(`${label}: expected rejection but call succeeded`);
    const msg = caught?.message || String(caught);
    if (!pattern.test(msg)) fail(`${label}: error "${msg}" did not match ${pattern}`);
    log(`  · rejected as expected: ${msg.split('\n')[0]}`);
}

// ─── YAML fixtures ───────────────────────────────────────────────────

function legacyFlatYaml(productId) {
    return [
        'name: legacy-flat',
        'description: Legacy flat vars playbook',
        'target:',
        `  product: ${productId}`,
        'vars:',
        '  seconds: 1',
        '  greeting: hello',
        'steps:',
        '  - action: sleep',
        '    seconds: 1',
        '',
    ].join('\n');
}

function extendedVarsYaml(productId) {
    return [
        'name: extended-vars',
        'description: Extended-form vars playbook',
        'target:',
        `  product: ${productId}`,
        'vars:',
        '  canary:',
        '    type: string',
        '    default: hello',
        '    description: Content to write',
        '  release:',
        '    type: string',
        '    required: true',
        '    default: v1',
        '    description: Release tag to deploy',
        '  timeout_seconds:',
        '    type: number',
        '    default: 15',
        '    description: Per-step timeout override',
        'steps:',
        '  - action: write',
        '    path: /tmp/thinr-e2e-canary.txt',
        '    content: "{{ canary }} / {{ release }}"',
        '',
    ].join('\n');
}

function internalOnlyYaml(productId) {
    return [
        'name: internal-only',
        'description: Variables locked to their defaults',
        'target:',
        `  product: ${productId}`,
        'vars:',
        '  secret:',
        '    type: string',
        '    default: s3cret',
        '    overridable: false',
        '    description: Fixed internal marker',
        'steps:',
        '  - action: write',
        '    path: /tmp/thinr-e2e-internal.txt',
        '    content: "{{ secret }}"',
        '',
    ].join('\n');
}

// ─── Offline checks ──────────────────────────────────────────────────

function runOfflineChecks() {
    section('Offline: parse + variable introspection');

    const extended = extendedVarsYaml('offline-product');
    const parsed = parsePlaybook(extended, { sourcePath: 'extended.yaml' });
    const vars = listVariables(parsed);
    const byName = Object.fromEntries(vars.map((v) => [v.name, v]));
    assertDeepEqual(Object.keys(byName).sort(), ['canary', 'release', 'timeout_seconds'], 'variables');
    assertEqual(byName.canary.type, 'string', 'canary.type');
    assertEqual(byName.canary.overridable, true, 'canary.overridable');
    assertEqual(byName.release.required, true, 'release.required');
    assertEqual(byName.timeout_seconds.type, 'number', 'timeout_seconds.type');
    log(`  · ${vars.length} variables, types inspected`);

    section('Offline: build dry-run plan + apply overrides to scope');
    const plan = buildDryRunPlan(parsed, { overrides: { canary: 'override-ok' } });
    assertEqual(plan.length, 1, 'plan length');
    assertEqual(plan[0].action, 'write', 'plan step action');
    const scope = resolveVarScope(parsed, { canary: 'override-ok' });
    assertEqual(scope.canary, 'override-ok', 'canary override');
    assertEqual(scope.release, 'v1', 'release default preserved');
    log('  · override-ok applied; defaults preserved for untouched vars');

    section('Offline: resolveVarScope rejects non-overridable overrides');
    const internal = internalOnlyYaml('offline-product');
    const internalParsed = parsePlaybook(internal, { sourcePath: 'internal.yaml' });
    try {
        resolveVarScope(internalParsed, { secret: 'nope' });
        fail('expected non-overridable override to be rejected');
    } catch (err) {
        if (!/not overridable/i.test(err.message)) throw err;
        log('  · "secret" override correctly rejected');
    }

    section('Offline: resolveVarScope rejects wrong type');
    try {
        resolveVarScope(parsed, { timeout_seconds: 'not-a-number' });
        fail('expected wrong-type override to be rejected');
    } catch (err) {
        if (!/type number/i.test(err.message)) throw err;
        log('  · wrong-type override correctly rejected');
    }
}

// ─── Cloud flow ──────────────────────────────────────────────────────

async function getTargetDeviceRecord(deviceId) {
    try {
        const info = await getDevice(deviceId);
        const active = !!info?.connection?.active;
        return { device: deviceId, connection: { active } };
    } catch {
        return { device: deviceId, connection: { active: false } };
    }
}

async function runCloudFlow() {
    const profile = getActiveProfile();
    const cfg = readConfig();
    if (!cfg?.token || !cfg?.server || !cfg?.username) {
        fail(
            'No active CLI profile. Run `thinr` once to authenticate before invoking this E2E, ' +
                'or pass --offline to run the offline checks only.',
        );
    }

    const productId = makeProductId();
    const deviceId = process.env.THINR_E2E_DEVICE || null;

    log(`Profile: ${profile}`);
    log(`Server:  ${cfg.server}`);
    log(`User:    ${cfg.username}`);
    log(`Product: ${productId}`);
    log(deviceId ? `Device:  ${deviceId}` : 'Device:  (none — check-mode run will be skipped)');

    let createdProduct = false;
    let cleanupError;

    try {
        section('Create temporary product');
        await createProduct(productId, null, {
            name: productId,
            description: 'Temporary product for playbook E2E tests',
        });
        createdProduct = true;
        log(`  · created "${productId}"`);

        const flat = legacyFlatYaml(productId);
        const extended = extendedVarsYaml(productId);
        const internal = internalOnlyYaml(productId);

        section('Upload three playbooks (flat / extended / internal)');
        await uploadProductPlaybook({ product: productId, name: 'flat', content: flat });
        log('  · uploaded "flat" (legacy flat vars)');
        await uploadProductPlaybook({ product: productId, name: 'extended', content: extended });
        log('  · uploaded "extended" (typed + required vars)');
        await uploadProductPlaybook({ product: productId, name: 'internal', content: internal });
        log('  · uploaded "internal" (non-overridable vars)');

        section('List playbooks');
        const list = await listProductPlaybooks(productId, null);
        const names = list.map((e) => e.name).sort();
        assertDeepEqual(names, ['extended', 'flat', 'internal'], 'initial listing');
        log(`  · listed: ${names.join(', ')}`);

        section('Download and compare bytes');
        const roundTrip = await readProductPlaybook(productId, 'extended', null);
        assertEqual(roundTrip, extended, 'extended roundtrip');
        log(`  · ${Buffer.byteLength(extended, 'utf8')} bytes match upload`);

        section('Replace an existing playbook (same key)');
        const updatedFlat = flat.replace('greeting: hello', 'greeting: world');
        assertEqual(updatedFlat === flat, false, 'fixture mutation check');
        await uploadProductPlaybook({ product: productId, name: 'flat', content: updatedFlat });
        const flatRoundTrip = await readProductPlaybook(productId, 'flat', null);
        assertEqual(flatRoundTrip, updatedFlat, 'flat replaced content');
        const afterReplace = await listProductPlaybooks(productId, null);
        assertEqual(afterReplace.length, 3, 'list length after replace');
        log('  · "flat" replaced; index length unchanged');

        section('Reject invalid playbook name (state preserved)');
        await expectReject(
            () =>
                uploadProductPlaybook({
                    product: productId,
                    name: 'has space',
                    content: flat,
                }),
            /Invalid playbook name/,
            'upload with invalid name',
        );
        const afterBadName = await listProductPlaybooks(productId, null);
        assertDeepEqual(
            afterBadName.map((e) => e.name).sort(),
            ['extended', 'flat', 'internal'],
            'listing after invalid-name reject',
        );

        section('Reject invalid YAML (state preserved)');
        await expectReject(
            () =>
                uploadProductPlaybook({
                    product: productId,
                    name: 'broken',
                    content: 'target: product: [broken',
                }),
            /Invalid YAML|Invalid playbook/,
            'upload with invalid YAML',
        );
        const afterBadYaml = await listProductPlaybooks(productId, null);
        assertDeepEqual(
            afterBadYaml.map((e) => e.name).sort(),
            ['extended', 'flat', 'internal'],
            'listing after invalid-YAML reject',
        );

        section('Parse cloud-hosted playbook');
        const parsedExtended = parsePlaybook(roundTrip, { sourcePath: 'extended.yaml' });
        const vars = listVariables(parsedExtended);
        log(`  · variables reported: ${vars.map((v) => v.name).join(', ')}`);

        if (deviceId) {
            section(`Run "extended" in --check mode on ${deviceId} (defaults)`);
            const dev = await getTargetDeviceRecord(deviceId);
            const resDefault = await runPlaybook(parsedExtended, [dev], {
                concurrency: 1,
                failFast: true,
                checkMode: true,
                overrides: {},
            });
            log(`  · result ok=${!!resDefault[0]?.ok} steps=${resDefault[0]?.steps?.length ?? 0}`);

            section(`Run "extended" in --check mode on ${deviceId} (overrides)`);
            const resOverride = await runPlaybook(parsedExtended, [dev], {
                concurrency: 1,
                failFast: true,
                checkMode: true,
                overrides: { canary: 'override-ok', release: 'v2' },
            });
            log(
                `  · result ok=${!!resOverride[0]?.ok} steps=${resOverride[0]?.steps?.length ?? 0}`,
            );
        } else {
            section('Skip single-device run');
            log('  · set THINR_E2E_DEVICE=<device-id> to exercise check-mode execution');
        }

        section('Delete one playbook (idempotent)');
        const del = await deleteProductPlaybook({ product: productId, name: 'internal' });
        if (!del.removed) fail('expected "internal" to be removed');
        const afterDelete = await listProductPlaybooks(productId, null);
        if (afterDelete.some((e) => e.name === 'internal')) {
            fail('"internal" still present after delete');
        }
        log('  · "internal" removed from index and file storage');

        log('\nE2E succeeded.');
    } finally {
        cleanupError = await cleanupProduct(productId, createdProduct);
    }

    if (cleanupError) throw cleanupError;
}

async function cleanupProduct(productId, createdProduct) {
    section('Cleanup');
    const stillThere =
        createdProduct || (await productExists(productId, null).catch(() => false));
    if (!stillThere) {
        log('  · nothing to clean up');
        return null;
    }
    try {
        const result = await deleteProductWithStorage(productId, null);
        for (const step of result.steps) log(`  · ${step}`);
        return null;
    } catch (err) {
        log(`  · cleanup FAILED: ${err?.message || err}`);
        log(`  · manual fallback: remove product "${productId}" and its file storage by hand.`);
        return err;
    }
}

// ─── Entry point ─────────────────────────────────────────────────────

async function main() {
    const offline = process.argv.includes('--offline');
    runOfflineChecks();
    if (offline) {
        log('\nOffline checks passed. Skipping cloud flow (--offline).');
        return;
    }
    await runCloudFlow();
}

main().catch((err) => {
    process.exitCode = 1;
    process.stderr.write(`\n[FAIL] ${err?.stack || err}\n`);
});
