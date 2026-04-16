import api from './api.js';
import { apiError } from './errors.js';
import { readConfig } from './config.js';
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
    return user || readConfig().username;
}

function v1(user) { return `/v1/users/${resolveUser(user)}`; }

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
export async function createProduct(productId, user, { icon = 'fab fa-linux', name, description } = {}) {
    try {
        await api.post(`${v1(user)}/products`, {
            product: productId,
            name: name || productId,
            description: description || 'ThinRemote product',
            enabled: true,
            config: {
                type: 'thinremote',
                icons: [{
                    conditions: [],
                    icon: { type: 'fa', source: icon, color: '#000000', background: '#ffffff' },
                }],
            },
            profile: {
                buckets: {
                    monitoring: {
                        name: 'Monitoring Data',
                        description: 'ThinRemote device metrics',
                        enabled: true,
                        backend: 'mongodb',
                        data: {
                            source: 'resource', resource: 'monitoring',
                            update: 'interval', interval: 60, magnitude: 'second',
                            payload: '{{payload}}', payload_function: '', payload_type: 'source_payload',
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
  return {
    cmd: body, mode: "api", timeout: 30,
    stdin: ev.payload && ev.payload.input !== undefined
      ? JSON.stringify(ev.payload.input) : undefined
  };
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

/**
 * Install (create or update) a product script. Ensures the product
 * exists, the storage exists, the index.js wrapper is present, the
 * script body is uploaded, the product is enabled and linked to the
 * storage, and the API resource named after the script's stem is
 * registered. Idempotent.
 */
export async function installProductScript({ product, name, content, user, icon } = {}) {
    if (!product) throw new Error('product is required');
    if (!name) throw new Error('name is required');
    if (typeof content !== 'string') throw new Error('content is required (string)');
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        throw new Error(`Invalid script name "${name}" (allowed: letters, digits, dot, dash, underscore)`);
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

    // 3. Ensure the generic index.js wrapper is in place
    if (!(await storageFileExists(storage, 'index.js', user))) {
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

    // 7. Create/update the API resource bound to the script stem
    await setProductApiResource(product, stem, user, {
        enabled: true,
        request: { data: { target: 'resource', resource: 'cmd', payload_type: 'source_event', payload_function: 'script' } },
        response: { data: { source: 'request_response', payload_type: 'source_payload' } },
    });
    steps.push(`upserted API resource "${stem}"`);

    return { steps, stem };
}

/** Reverse of installProductScript: drops both the file and the API resource. */
export async function removeProductScript({ product, name, user } = {}) {
    if (!product) throw new Error('product is required');
    if (!name) throw new Error('name is required');
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        throw new Error(`Invalid script name "${name}"`);
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
    const files = allFiles.filter(f => f.type === 'file' && f.path.startsWith('scripts/'));
    const apis = await getProductApi(productId, user);
    return files.map(f => {
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
        throw new Error(`Invalid script name "${name}"`);
    }
    return readStorageFile(productId, `scripts/${name}`, user);
}
