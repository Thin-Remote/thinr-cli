import api from './api.js';
import { apiError, inputError } from './errors.js';
import { requireConfig } from './config.js';
import {
    storageExists,
    createStorage,
    deleteStorage,
    listStorageFiles,
    readStorageFile,
    storageFileExists,
    writeStorageFile,
    deleteStorageFile,
} from './storage.js';
import { parsePlaybook } from './playbook/loader.js';

/**
 * Helpers for ThinRemote products and the product-script workflow.
 *
 * Low-level helpers (`getProducts`, `getProduct`, `createProduct`, …)
 * each map to a single REST endpoint and throw `apiError` on failure
 * — except `*Exists` (boolean) and `delete*` (true if removed, false
 * if the resource was already absent).
 *
 * Higher-level orchestrators (`installProductScript`,
 * `removeProductScript`, `deleteProductWithStorage`) compose those
 * primitives and return a `{ steps: string[] }` log so callers can
 * surface a human-readable summary without re-implementing the
 * sequence.
 */

function resolveUser(user) {
    return user || requireConfig().username;
}

function v1(user) {
    return `/v1/users/${resolveUser(user)}`;
}

// ─── Low-level: products ─────────────────────────────────────────────

export async function getProducts(user) {
    try {
        const res = await api.get(`${v1(user)}/products`);
        return res.data || [];
    } catch (e) {
        throw apiError(e);
    }
}

export async function getProduct(productId, user) {
    try {
        const res = await api.get(`${v1(user)}/products/${productId}`);
        return res.data || {};
    } catch (e) {
        throw apiError(e, { notFound: `Product not found: ${productId}` });
    }
}

export async function productExists(productId, user) {
    try {
        await api.get(`${v1(user)}/products/${productId}`);
        return true;
    } catch (e) {
        if (e.response?.status === 404) return false;
        throw apiError(e);
    }
}

/**
 * Create a product with the standard ThinRemote scaffold: `type:
 * thinremote`, a Font Awesome icon (defaults to Linux), and a
 * `monitoring` bucket fed every 60 s from the device's `monitoring`
 * resource. Caller controls only `icon`, `name`, `description`.
 */
export async function createProduct(
    productId,
    user,
    { icon = 'fab fa-linux', name, description } = {},
) {
    try {
        await api.post(`${v1(user)}/products`, {
            product: productId,
            name: name || productId,
            description: description || 'ThinRemote product',
            enabled: true,
            config: {
                type: 'thinremote',
                icons: [
                    {
                        conditions: [],
                        icon: { type: 'fa', source: icon, color: '#000000', background: '#ffffff' },
                    },
                ],
            },
            profile: {
                buckets: {
                    monitoring: {
                        name: 'Monitoring Data',
                        description: 'ThinRemote device metrics',
                        enabled: true,
                        backend: 'mongodb',
                        data: {
                            source: 'resource',
                            resource: 'monitoring',
                            update: 'interval',
                            interval: 60,
                            magnitude: 'second',
                            payload: '{{payload}}',
                            payload_function: '',
                            payload_type: 'source_payload',
                        },
                        retention: { period: 3, unit: 'months' },
                        tags: [],
                    },
                },
            },
        });
    } catch (e) {
        throw apiError(e);
    }
}

export async function updateProduct(productId, user, patch) {
    try {
        await api.put(`${v1(user)}/products/${productId}`, patch);
    } catch (e) {
        throw apiError(e, { notFound: `Product not found: ${productId}` });
    }
}

export async function deleteProduct(productId, user) {
    try {
        await api.delete(`${v1(user)}/products/${productId}`);
        return true;
    } catch (e) {
        if (e.response?.status === 404) return false;
        throw apiError(e);
    }
}

// ─── Low-level: product API resources (profile/api/<name>) ───────────

/** Returns the `{ resourceName: definition }` map; `{}` when none. */
export async function getProductApi(productId, user) {
    try {
        const res = await api.get(`${v1(user)}/products/${productId}/profile/api`);
        return res.data || {};
    } catch (e) {
        if (e.response?.status === 404) return {};
        throw apiError(e);
    }
}

export async function setProductApiResource(productId, resourceName, user, payload) {
    try {
        await api.put(`${v1(user)}/products/${productId}/profile/api/${resourceName}`, payload);
    } catch (e) {
        throw apiError(e);
    }
}

export async function deleteProductApiResource(productId, resourceName, user) {
    try {
        await api.delete(`${v1(user)}/products/${productId}/profile/api/${resourceName}`);
        return true;
    } catch (e) {
        if (e.response?.status === 404) return false;
        throw apiError(e);
    }
}

// ─── Low-level: product code link (profile/code) ─────────────────────

export async function getProductCode(productId, user) {
    try {
        const res = await api.get(`${v1(user)}/products/${productId}/profile/code`);
        return res.data || {};
    } catch (e) {
        if (e.response?.status === 404) return {};
        throw apiError(e);
    }
}

export async function setProductCode(productId, user, payload) {
    try {
        await api.put(`${v1(user)}/products/${productId}/profile/code`, payload);
    } catch (e) {
        throw apiError(e);
    }
}

// ─── Low-level: product properties (/v1/.../products/<id>/properties) ─
//
// Product-level properties are structured JSON values attached to the
// product itself (not to any single device). Typical uses: dashboard
// configuration, shared feature flags, a list of metrics to stream.
// Endpoint mirrors device properties but lives under the v1 product
// namespace on the server.

export async function getProductProperties(productId, user) {
    try {
        const res = await api.get(`${v1(user)}/products/${productId}/properties`);
        return res.data || [];
    } catch (e) {
        throw apiError(e, { notFound: `Product not found: ${productId}` });
    }
}

export async function getProductProperty(productId, propertyId, user) {
    try {
        const res = await api.get(
            `${v1(user)}/products/${productId}/properties/${propertyId}`,
        );
        return res.data?.value;
    } catch (e) {
        throw apiError(e, {
            notFound: `Property not found: ${propertyId} on product ${productId}`,
        });
    }
}

export async function setProductProperty(productId, propertyId, value, user) {
    try {
        const res = await api.put(
            `${v1(user)}/products/${productId}/properties/${propertyId}`,
            { value },
        );
        return res.data;
    } catch (e) {
        throw apiError(e, { notFound: `Product not found: ${productId}` });
    }
}

export async function deleteProductProperty(productId, propertyId, user) {
    try {
        await api.delete(`${v1(user)}/products/${productId}/properties/${propertyId}`);
        return true;
    } catch (e) {
        if (e.response?.status === 404) return false;
        throw apiError(e);
    }
}

// ─── Low-level: device ↔ product binding ─────────────────────────────

export async function setDeviceProduct(deviceId, productId, user) {
    try {
        await api.put(`${v1(user)}/devices/${deviceId}`, { product: productId });
    } catch (e) {
        throw apiError(e, { notFound: `Device not found: ${deviceId}` });
    }
}

// ─── Orchestrators ───────────────────────────────────────────────────

/**
 * Generic wrapper hosted in the storage's `index.js`. Dispatches the
 * incoming product-API event to the matching script file by name,
 * shelling out via the device's `cmd` resource. Idempotent on
 * subsequent writes — the wrapper only changes if the contract does.
 */
const PRODUCT_SCRIPT_INDEX_JS = `function script(ev) {
  const fs = require("fs"), path = require("path");
  const dir = path.join(__dirname, "scripts");
  const match = fs.readdirSync(dir).find(f =>
    f === ev.resource || f.replace(/\\.[^.]+$/, "") === ev.resource
  );
  if (!match) throw new Error("script not found: " + ev.resource);
  const body = fs.readFileSync(path.join(dir, match), "utf8");
  // Input can arrive in three shapes depending on payload_type:
  //  - template_payload:  ev.input                 (envelope from buildInputTemplate)
  //  - source_event:      ev.payload.input  or ev.payload (free-form)
  //  - source_payload:    ev (already the payload)
  const inp = ev.input !== undefined ? ev.input
    : (ev.payload && ev.payload.input !== undefined) ? ev.payload.input
    : ev.payload;
  return {
    cmd: body, mode: "api", timeout: 30,
    stdin: inp !== undefined && inp !== null ? JSON.stringify(inp) : undefined
  };
}

function parse_stdout(ev) {
  const p = (ev && ev.payload) || {};
  if (p.retcode !== 0) {
    const msg = (p.stderr && String(p.stderr).trim()) ||
      ("script exited with code " + p.retcode);
    return { error: msg, retcode: p.retcode };
  }
  try {
    return JSON.parse(p.stdout);
  } catch (e) {
    return {
      error: "invalid JSON in stdout",
      detail: e.message,
      stdout: p.stdout
    };
  }
}
`;

/** Drop a product (and, by default, its companion file storage). */
export async function deleteProductWithStorage(productId, user, { keepStorage = false } = {}) {
    const steps = [];

    if (await deleteProduct(productId, user)) {
        steps.push(`deleted product "${productId}"`);
    } else {
        steps.push(`product "${productId}" already absent`);
    }

    if (keepStorage) {
        steps.push(`kept file storage "${productId}" (keepStorage=true)`);
    } else if (await deleteStorage(productId, user)) {
        steps.push(`deleted file storage "${productId}"`);
    } else {
        steps.push(`file storage "${productId}" already absent`);
    }

    return { steps };
}

function buildInputTemplate(input) {
    const pairs = Object.entries(input).map(([k, v]) => {
        if (typeof v === 'string') {
            return `    "${k}": "{{payload.${k}="${v}"}}"`;
        }
        if (typeof v === 'number' || typeof v === 'boolean') {
            return `    "${k}": {{payload.${k}=${v}}}`;
        }
        return `    "${k}": ${JSON.stringify(v)}`;
    });
    // Keep {{resource}} in the envelope so the wrapper can still discover
    // which script to dispatch — template_payload strips the event context
    // away and only hands the rendered object to the payload_function.
    return [
        '{',
        '  "resource": "{{resource}}",',
        '  "input": {',
        pairs.join(',\n'),
        '  }',
        '}',
    ].join('\n');
}

/**
 * Install (create or update) a product script. Ensures the product
 * exists, the storage exists, the index.js wrapper is present, the
 * script body is uploaded, the product is enabled and linked to the
 * storage, and the API resource named after the script's stem is
 * registered. Idempotent.
 */
export async function installProductScript({ product, name, content, user, icon, input, output } = {}) {
    if (!product) throw inputError('product is required');
    if (!name) throw inputError('name is required');
    if (typeof content !== 'string') throw inputError('content is required (string)');
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        throw inputError(
            `Invalid script name "${name}" (allowed: letters, digits, dot, dash, underscore)`,
        );
    }
    if (input !== undefined && input !== null) {
        if (typeof input !== 'object' || Array.isArray(input)) {
            throw inputError('input must be a plain object mapping field names to default values');
        }
        for (const k of Object.keys(input)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
                throw inputError(`Invalid input field name "${k}"`);
            }
        }
    }

    const storage = product;
    const stem = name.replace(/\.[^.]+$/, '');
    const steps = [];

    // 1. Ensure product exists
    if (!(await productExists(product, user))) {
        const usedIcon = icon || 'fab fa-linux';
        await createProduct(product, user, { icon: usedIcon });
        steps.push(`created product "${product}" (icon: ${usedIcon})`);
    }

    // 2. Ensure storage exists
    if (!(await storageExists(storage, user))) {
        await createStorage(storage, user, { description: `Product scripts for ${product}` });
        steps.push(`created storage "${storage}"`);
    }

    // 3. Ensure the generic index.js wrapper is in place and up to date.
    //    Rewrite only when the contents differ, so hand-edited wrappers are
    //    preserved if the user tweaked theirs and still match.
    let needsWrapper = true;
    if (await storageFileExists(storage, 'index.js', user)) {
        try {
            const current = await readStorageFile(storage, 'index.js', user);
            if (current === PRODUCT_SCRIPT_INDEX_JS) needsWrapper = false;
        } catch {
            // unreadable → just overwrite.
        }
    }
    if (needsWrapper) {
        await writeStorageFile(storage, 'index.js', PRODUCT_SCRIPT_INDEX_JS, user);
        steps.push('wrote index.js wrapper');
    }

    // 4. Upload the script body
    await writeStorageFile(storage, `scripts/${name}`, content, user);
    steps.push(`wrote scripts/${name} (${content.length} bytes)`);

    // 5. Ensure profile.code.storage points at this storage
    const code = await getProductCode(product, user);
    if (code.storage !== storage) {
        await setProductCode(product, user, { storage, code: '', version: '1.0' });
        steps.push(`linked profile.code.storage → ${storage}`);
    }

    // 6. Ensure product is enabled
    const prod = await getProduct(product, user);
    if (!prod.enabled) {
        await updateProduct(product, user, { enabled: true });
        steps.push('enabled product');
    }

    // 7. Create/update the API resource bound to the script stem.
    //    With an input schema, register a template_payload so the UI can
    //    render typed fields; without one, fall back to source_event so any
    //    object the caller sends flows straight through.
    const requestData = {
        target: 'resource',
        resource: 'cmd',
        payload_function: 'script',
    };
    if (input && Object.keys(input).length > 0) {
        // The frontend encodes "Template Payload" as an empty payload_type
        // string (see profile-source-configurator.html), and the backend
        // defaults to template_payload when the value is unrecognised.
        requestData.payload_type = '';
        requestData.payload = buildInputTemplate(input);
    } else {
        requestData.payload_type = 'source_event';
    }
    // When the caller explicitly opts out of the response (output: false)
    // the resource becomes fire-and-forget: no parse_stdout, no body back.
    // Combined with no input this classifies as a "run" resource.
    const wantOutput = output !== false;
    const responseData = wantOutput
        ? {
              source: 'request_response',
              payload_type: 'source_event',
              payload_function: 'parse_stdout',
          }
        : { payload_type: 'none' };
    await setProductApiResource(product, stem, user, {
        enabled: true,
        request: { data: requestData },
        response: { data: responseData },
    });
    steps.push(`upserted API resource "${stem}"`);

    return { steps, stem };
}

/** Reverse of installProductScript: drops both the file and the API resource. */
export async function removeProductScript({ product, name, user } = {}) {
    if (!product) throw inputError('product is required');
    if (!name) throw inputError('name is required');
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        throw inputError(`Invalid script name "${name}"`);
    }
    const stem = name.replace(/\.[^.]+$/, '');
    const steps = [];

    if (await deleteStorageFile(product, `scripts/${name}`, user)) {
        steps.push(`deleted scripts/${name}`);
    } else {
        steps.push(`scripts/${name} already absent`);
    }

    if (await deleteProductApiResource(product, stem, user)) {
        steps.push(`deleted API resource "${stem}"`);
    } else {
        steps.push(`API resource "${stem}" already absent`);
    }

    return { steps, stem };
}

/**
 * List script files in a product's storage and pair them with the
 * matching API resource (or flag as `[orphan]` when the file exists
 * but no API resource references it).
 */
export async function listProductScripts(productId, user) {
    const allFiles = await listStorageFiles(productId, user);
    const files = allFiles.filter((f) => f.type === 'file' && f.path.startsWith('scripts/'));
    const apis = await getProductApi(productId, user);
    return files.map((f) => {
        const stem = f.name.replace(/\.[^.]+$/, '');
        return {
            name: f.name,
            path: f.path,
            size: f.size,
            stem,
            registered: Boolean(apis[stem]),
        };
    });
}

export async function readProductScript(productId, name, user) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        throw inputError(`Invalid script name "${name}"`);
    }
    return readStorageFile(productId, `scripts/${name}`, user);
}

// ─── Orchestrators: dashboard metrics ────────────────────────────────
//
// The dashboard reads its metric panels from a single product property
// (`dashboard_metrics`) whose value is an array of metric entries. These
// helpers read/modify/write that list so callers don't have to care
// about the encoding — each metric is addressed by its stable `name`
// key, idempotently upserted or removed.

export const DASHBOARD_METRICS_PROPERTY = 'dashboard_metrics';

const METRIC_VISUALIZATIONS = new Set(['kpi', 'bar', 'sparkline', 'list']);
const METRIC_AGGREGATIONS = new Set(['sum', 'avg', 'max', 'min', 'count', 'top', 'none']);

function validateMetric(m) {
    if (!m || typeof m !== 'object') throw inputError('metric must be an object');
    if (!m.name || typeof m.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(m.name)) {
        throw inputError('metric.name is required (letters, digits, underscore, dash)');
    }
    if (!m.resource || typeof m.resource !== 'string') {
        throw inputError('metric.resource is required (product API resource name)');
    }
    if (m.aggregation && !METRIC_AGGREGATIONS.has(m.aggregation)) {
        throw inputError(
            `metric.aggregation must be one of: ${[...METRIC_AGGREGATIONS].join(', ')}`,
        );
    }
    if (m.visualization && !METRIC_VISUALIZATIONS.has(m.visualization)) {
        throw inputError(
            `metric.visualization must be one of: ${[...METRIC_VISUALIZATIONS].join(', ')}`,
        );
    }
    if (m.interval != null) {
        const n = Number(m.interval);
        if (!Number.isFinite(n) || n < 1) {
            throw inputError('metric.interval must be a positive number of seconds');
        }
    }
}

async function loadMetricList(productId, user) {
    try {
        const value = await getProductProperty(productId, DASHBOARD_METRICS_PROPERTY, user);
        if (Array.isArray(value)) return value;
        if (Array.isArray(value?.metrics)) return value.metrics;
        return [];
    } catch (e) {
        if (/Property not found/.test(e.message || '')) return [];
        throw e;
    }
}

export async function listDashboardMetrics(productId, user) {
    return loadMetricList(productId, user);
}

export async function upsertDashboardMetric(productId, metric, user) {
    validateMetric(metric);
    const list = await loadMetricList(productId, user);
    const idx = list.findIndex((m) => m.name === metric.name);
    const next = [...list];
    const action = idx >= 0 ? 'updated' : 'added';
    if (idx >= 0) next[idx] = { ...list[idx], ...metric };
    else next.push(metric);
    await setProductProperty(productId, DASHBOARD_METRICS_PROPERTY, next, user);
    return { action, metric, count: next.length };
}

export async function removeDashboardMetric(productId, name, user) {
    if (!name || typeof name !== 'string') throw inputError('metric name is required');
    const list = await loadMetricList(productId, user);
    const next = list.filter((m) => m.name !== name);
    if (next.length === list.length) return { action: 'noop', count: next.length };
    if (next.length === 0) {
        await deleteProductProperty(productId, DASHBOARD_METRICS_PROPERTY, user);
    } else {
        await setProductProperty(productId, DASHBOARD_METRICS_PROPERTY, next, user);
    }
    return { action: 'removed', count: next.length };
}

// ─── Orchestrators: product playbooks ────────────────────────────────
//
// Playbooks live as YAML files inside the product's file storage under
// a reserved `playbooks/` folder. A lightweight index kept in the
// product property `playbooks` mirrors the available entries with just
// name, description and storage path, so listing is a single property
// read instead of a storage scan. Defaults for playbook variables
// travel inside the YAML itself (see lib/playbook/loader.js) — the
// execution tasks consume them without a separate metadata file.

export const PLAYBOOK_INDEX_PROPERTY = 'playbooks';
export const PLAYBOOK_NAME_RE = /^[A-Za-z0-9_-]+$/;

export function playbookStoragePath(name) {
    return `playbooks/${name}.yaml`;
}

function assertPlaybookName(name) {
    if (!name || typeof name !== 'string') {
        throw inputError('playbook name is required');
    }
    if (!PLAYBOOK_NAME_RE.test(name)) {
        throw inputError(
            `Invalid playbook name "${name}" (allowed: letters, digits, underscore, dash)`,
        );
    }
}

async function loadPlaybookIndex(productId, user) {
    try {
        const value = await getProductProperty(productId, PLAYBOOK_INDEX_PROPERTY, user);
        if (Array.isArray(value)) return value;
        if (Array.isArray(value?.playbooks)) return value.playbooks;
        return [];
    } catch (e) {
        if (/Property not found/.test(e.message || '')) return [];
        throw e;
    }
}

async function savePlaybookIndex(productId, list, user) {
    if (!list || list.length === 0) {
        await deleteProductProperty(productId, PLAYBOOK_INDEX_PROPERTY, user);
        return;
    }
    await setProductProperty(productId, PLAYBOOK_INDEX_PROPERTY, list, user);
}

export async function listProductPlaybooks(productId, user) {
    const list = await loadPlaybookIndex(productId, user);
    return list.map((e) => ({
        name: e.name,
        description: typeof e.description === 'string' ? e.description : '',
        path: e.path || playbookStoragePath(e.name),
    }));
}

export async function findProductPlaybook(productId, name, user) {
    assertPlaybookName(name);
    const list = await loadPlaybookIndex(productId, user);
    const entry = list.find((e) => e.name === name);
    if (!entry) return null;
    return {
        name: entry.name,
        description: typeof entry.description === 'string' ? entry.description : '',
        path: entry.path || playbookStoragePath(entry.name),
    };
}

export async function readProductPlaybook(productId, name, user) {
    assertPlaybookName(name);
    const entry = await findProductPlaybook(productId, name, user);
    const path = entry?.path || playbookStoragePath(name);
    return readStorageFile(productId, path, user);
}

/**
 * Upload a playbook YAML to a product. Validates the name, optionally
 * validates the YAML against the playbook schema, ensures the storage
 * exists, writes the file, and only then registers the entry in the
 * index property. If the index update fails the file is rolled back
 * so no orphans are left behind. Returns `{ action, entry, replaced }`.
 *
 * @param {{
 *   product?: string,
 *   name?: string,
 *   content?: unknown,
 *   description?: string,
 *   user?: string,
 *   skipValidation?: boolean,
 * }} [opts]
 */
export async function uploadProductPlaybook({
    product,
    name,
    content,
    description,
    user,
    skipValidation = false,
} = {}) {
    if (!product) throw inputError('product is required');
    assertPlaybookName(name);
    if (typeof content !== 'string') throw inputError('content is required (string)');

    let parsedDescription = null;
    if (!skipValidation) {
        const pb = parsePlaybook(content, { sourcePath: `${name}.yaml` });
        parsedDescription = pb.description;
    }

    const storage = product;
    const path = playbookStoragePath(name);
    const steps = [];

    if (!(await storageExists(storage, user))) {
        await createStorage(storage, user, { description: `Product storage for ${product}` });
        steps.push(`created storage "${storage}"`);
    }

    const existing = await loadPlaybookIndex(product, user);
    const priorIdx = existing.findIndex((e) => e.name === name);
    const replaced = priorIdx >= 0;

    await writeStorageFile(storage, path, content, user);
    steps.push(`${replaced ? 'overwrote' : 'wrote'} ${path} (${content.length} bytes)`);

    const entry = {
        name,
        description:
            typeof description === 'string'
                ? description
                : typeof parsedDescription === 'string'
                ? parsedDescription
                : '',
        path,
    };
    const next = [...existing];
    if (replaced) next[priorIdx] = entry;
    else next.push(entry);

    try {
        await savePlaybookIndex(product, next, user);
        steps.push(`${replaced ? 'updated' : 'registered'} index entry "${name}"`);
    } catch (indexErr) {
        // Rollback the file so the user doesn't end up with an orphan
        // that `list` can't see. If rollback itself fails, surface that
        // alongside the original error so the user can clean up.
        let rollbackNote;
        try {
            if (replaced) {
                // The file existed before — we overwrote it. Leaving it
                // in its new shape is the least destructive option.
                rollbackNote = ' (overwritten file kept, previous content lost)';
            } else {
                await deleteStorageFile(storage, path, user);
                rollbackNote = ' (uploaded file rolled back)';
            }
        } catch (rollbackErr) {
            rollbackNote = ` (rollback failed: ${rollbackErr.message || rollbackErr})`;
        }
        const err = new Error(
            `Failed to update playbook index for "${name}"${rollbackNote}: ${indexErr.message || indexErr}`,
        );
        err.code = indexErr.code || 'error';
        throw err;
    }

    return { action: replaced ? 'updated' : 'created', entry, replaced, steps };
}

export async function deleteProductPlaybook({ product, name, user } = {}) {
    if (!product) throw inputError('product is required');
    assertPlaybookName(name);

    const steps = [];
    const list = await loadPlaybookIndex(product, user);
    const idx = list.findIndex((e) => e.name === name);
    const entry = idx >= 0 ? list[idx] : null;
    const path = entry?.path || playbookStoragePath(name);

    if (idx >= 0) {
        const next = list.filter((_, i) => i !== idx);
        await savePlaybookIndex(product, next, user);
        steps.push(`removed index entry "${name}"`);
    } else {
        steps.push(`index entry "${name}" already absent`);
    }

    let fileRemoved = false;
    try {
        fileRemoved = await deleteStorageFile(product, path, user);
        steps.push(fileRemoved ? `deleted ${path}` : `${path} already absent`);
    } catch (e) {
        // Index is already clean at this point. Surface the file error
        // as a warning step rather than failing the whole op, since the
        // user now just has an orphan to clean up manually.
        steps.push(`warning: failed to delete ${path}: ${e.message || e}`);
    }

    return {
        removed: idx >= 0 || fileRemoved,
        indexRemoved: idx >= 0,
        fileRemoved,
        entry,
        steps,
    };
}
