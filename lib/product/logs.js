// @ts-check
import { inputError } from '../errors.js';
import {
    getProductProperty,
    setProductProperty,
    deleteProductProperty,
} from '../product.js';

/**
 * Schema, validator and helpers for the per-product `logs` property.
 *
 * A product's `logs` value declares the named log streams the dashboard,
 * CLI and MCP can offer for any device bound to that product. Each
 * source is a `{ name, command }` pair: the agent already knows how to
 * exec-stream an arbitrary shell command, so a "log source" is just a
 * label plus the command the client should send. No agent change, no
 * new IOTMP kind — the command is an opaque string that the client
 * stores and forwards.
 *
 * Fallback: when a product has no `logs` property, consumers should
 * behave as before — surface a single synthetic source named `system`
 * whose command is `FALLBACK_LOGS_COMMAND`, mirroring the journalctl
 * stream the dashboard has used historically.
 *
 * @typedef {{ name: string, command: string }} LogSource
 * @typedef {{ sources: LogSource[], default?: string }} LogsConfig
 */

/** Property id under which the config lives on the product. */
export const LOGS_PROPERTY = 'logs';

/** Source name format: slug-ish, ≤ 32 chars, must have at least one char. */
export const LOG_SOURCE_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Maximum number of sources a single config may declare. */
export const MAX_LOG_SOURCES = 32;

/** Command used by the synthetic fallback when no `logs` config exists. */
export const FALLBACK_LOGS_COMMAND = 'journalctl --no-pager --output=short -f';

/** Fallback source name for products without a configured `logs` property. */
export const FALLBACK_LOGS_SOURCE_NAME = 'system';

const SOURCE_KEYS = new Set(['name', 'command']);
const ROOT_KEYS = new Set(['sources', 'default']);

/**
 * Validate and normalize a `logs` property value.
 *
 * Accepts an unknown value, returns a clean copy stripped of unknown
 * keys. Throws `inputError` on the first problem so callers can rely
 * on the returned shape being safe to persist or hand off to the UI.
 *
 * @param {unknown} value
 * @returns {LogsConfig}
 */
export function validateLogsConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw inputError('logs must be an object with a `sources` array');
    }
    const obj = /** @type {Record<string, unknown>} */ (value);

    for (const key of Object.keys(obj)) {
        if (!ROOT_KEYS.has(key)) {
            throw inputError(`logs: unknown key "${key}" (allowed: sources, default)`);
        }
    }

    const rawSources = obj.sources;
    if (!Array.isArray(rawSources)) {
        throw inputError('logs.sources is required and must be an array');
    }
    if (rawSources.length === 0) {
        throw inputError('logs.sources must contain at least one source');
    }
    if (rawSources.length > MAX_LOG_SOURCES) {
        throw inputError(`logs.sources accepts at most ${MAX_LOG_SOURCES} entries`);
    }

    const sources = [];
    const seen = new Set();
    rawSources.forEach((raw, i) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw inputError(`logs.sources[${i}] must be an object with name and command`);
        }
        const entry = /** @type {Record<string, unknown>} */ (raw);
        for (const key of Object.keys(entry)) {
            if (!SOURCE_KEYS.has(key)) {
                throw inputError(
                    `logs.sources[${i}]: unknown key "${key}" (allowed: name, command)`,
                );
            }
        }
        const { name, command } = entry;
        if (typeof name !== 'string' || !LOG_SOURCE_NAME_RE.test(name)) {
            throw inputError(
                `logs.sources[${i}].name must be a slug (letters, digits, underscore, dash; 1-32 chars)`,
            );
        }
        if (seen.has(name)) {
            throw inputError(`logs.sources[${i}].name "${name}" is duplicated`);
        }
        if (typeof command !== 'string' || command.trim() === '') {
            throw inputError(`logs.sources[${i}].command must be a non-empty string`);
        }
        seen.add(name);
        sources.push({ name, command });
    });

    let def;
    if (obj.default !== undefined && obj.default !== null) {
        if (typeof obj.default !== 'string') {
            throw inputError('logs.default must be a string matching a source name');
        }
        if (!seen.has(obj.default)) {
            throw inputError(
                `logs.default "${obj.default}" does not match any source name`,
            );
        }
        def = obj.default;
    }

    /** @type {LogsConfig} */
    const out = { sources };
    if (def !== undefined) out.default = def;
    return out;
}

/**
 * Resolve the active source from a (validated) config. Returns the
 * entry whose name matches `default`, falling back to the first
 * source. Useful for "what should I show first?" decisions in the UI.
 *
 * @param {LogsConfig} config
 * @returns {LogSource}
 */
export function resolveDefaultLogSource(config) {
    if (config.default) {
        const match = config.sources.find((s) => s.name === config.default);
        if (match) return match;
    }
    return config.sources[0];
}

/**
 * Synthetic config returned by `getProductLogs` when the product has
 * no `logs` property set. Keeps consumers compatible with how the
 * dashboard streamed logs before this feature existed.
 *
 * @returns {LogsConfig}
 */
export function fallbackLogsConfig() {
    return {
        sources: [{ name: FALLBACK_LOGS_SOURCE_NAME, command: FALLBACK_LOGS_COMMAND }],
        default: FALLBACK_LOGS_SOURCE_NAME,
    };
}

/**
 * Read a product's `logs` config, validating the stored value before
 * returning it. When the property is missing, returns the synthetic
 * fallback so callers can render a `system` source unconditionally.
 *
 * The returned object always carries a `__fallback` flag so the UI can
 * tell "operator configured this" from "we made one up". The flag is
 * non-enumerable to keep it out of JSON round-trips.
 *
 * @param {string} productId
 * @param {string} [user]
 * @returns {Promise<LogsConfig & { __fallback?: boolean }>}
 */
export async function getProductLogs(productId, user) {
    let raw;
    try {
        raw = await getProductProperty(productId, LOGS_PROPERTY, user);
    } catch (e) {
        if (/Property not found/.test(e?.message || '')) {
            return markFallback(fallbackLogsConfig());
        }
        throw e;
    }
    if (raw === undefined || raw === null) {
        return markFallback(fallbackLogsConfig());
    }
    return validateLogsConfig(raw);
}

function markFallback(config) {
    Object.defineProperty(config, '__fallback', {
        value: true,
        enumerable: false,
        writable: false,
    });
    return config;
}

/**
 * Validate and persist a product's `logs` config. Returns the
 * normalized value that was written.
 *
 * @param {string} productId
 * @param {unknown} value
 * @param {string} [user]
 * @returns {Promise<LogsConfig>}
 */
export async function setProductLogs(productId, value, user) {
    const normalized = validateLogsConfig(value);
    await setProductProperty(productId, LOGS_PROPERTY, normalized, user);
    return normalized;
}

/**
 * Remove the `logs` property from a product. Returns true when the
 * property existed, false when it was already absent.
 *
 * @param {string} productId
 * @param {string} [user]
 * @returns {Promise<boolean>}
 */
export async function deleteProductLogs(productId, user) {
    return deleteProductProperty(productId, LOGS_PROPERTY, user);
}

/**
 * Read the raw stored config without applying the synthetic fallback.
 * Returns `null` when the property is missing — callers that need the
 * fallback should reach for `getProductLogs` instead.
 *
 * @param {string} productId
 * @param {string} [user]
 * @returns {Promise<LogsConfig | null>}
 */
async function readStoredLogs(productId, user) {
    let raw;
    try {
        raw = await getProductProperty(productId, LOGS_PROPERTY, user);
    } catch (e) {
        if (/Property not found/.test(e?.message || '')) return null;
        throw e;
    }
    if (raw === undefined || raw === null) return null;
    return validateLogsConfig(raw);
}

/**
 * Add or replace a source on a product's `logs` config. When the
 * product has no `logs` property yet, the call creates it from scratch
 * with this single source. Pass `makeDefault` to mark the new source
 * as the active default; otherwise the previous default is preserved
 * (or, on a fresh config, no default is set so the first-source rule
 * applies).
 *
 * @param {string} productId
 * @param {{ name?: string, command?: string, makeDefault?: boolean }} [source]
 * @param {string} [user]
 * @returns {Promise<{ config: LogsConfig, action: 'added' | 'updated' }>}
 */
export async function addLogSource(productId, source = {}, user) {
    const { name, command, makeDefault } = source;
    if (typeof name !== 'string' || !LOG_SOURCE_NAME_RE.test(name)) {
        throw inputError(
            'name must be a slug (letters, digits, underscore, dash; 1-32 chars)',
        );
    }
    if (typeof command !== 'string' || command.trim() === '') {
        throw inputError('command must be a non-empty string');
    }
    const stored = (await readStoredLogs(productId, user)) || { sources: [] };
    const nextSources = [...stored.sources];
    const idx = nextSources.findIndex((s) => s.name === name);
    const action = idx >= 0 ? 'updated' : 'added';
    if (idx >= 0) nextSources[idx] = { name, command };
    else nextSources.push({ name, command });

    /** @type {LogsConfig} */
    const next = { sources: nextSources };
    if (makeDefault) next.default = name;
    else if (stored.default) next.default = stored.default;

    const normalized = validateLogsConfig(next);
    await setProductProperty(productId, LOGS_PROPERTY, normalized, user);
    return { config: normalized, action };
}

/**
 * Remove a source by name from a product's `logs` config. When the
 * removed source was the default, the default is dropped (downstream
 * `resolveDefaultLogSource` will pick the first remaining source).
 * Removing the last source deletes the property entirely so callers
 * fall back to the synthetic `system` config.
 *
 * @param {string} productId
 * @param {string} name
 * @param {string} [user]
 * @returns {Promise<{ removed: boolean, config: LogsConfig | null }>}
 */
export async function removeLogSource(productId, name, user) {
    if (typeof name !== 'string' || !name) {
        throw inputError('name is required');
    }
    const stored = await readStoredLogs(productId, user);
    if (!stored) return { removed: false, config: null };

    const nextSources = stored.sources.filter((s) => s.name !== name);
    if (nextSources.length === stored.sources.length) {
        return { removed: false, config: stored };
    }
    if (nextSources.length === 0) {
        await deleteProductProperty(productId, LOGS_PROPERTY, user);
        return { removed: true, config: null };
    }

    /** @type {LogsConfig} */
    const next = { sources: nextSources };
    if (stored.default && stored.default !== name) next.default = stored.default;

    const normalized = validateLogsConfig(next);
    await setProductProperty(productId, LOGS_PROPERTY, normalized, user);
    return { removed: true, config: normalized };
}

/**
 * Set the active default source on a product's `logs` config. The
 * named source must already exist; passing `null` clears the default
 * so the first-source rule applies.
 *
 * @param {string} productId
 * @param {string | null} name
 * @param {string} [user]
 * @returns {Promise<LogsConfig>}
 */
export async function setDefaultLogSource(productId, name, user) {
    const clear = name === null || name === undefined;
    if (!clear && typeof name !== 'string') {
        throw inputError('default must be a string matching a source name');
    }
    const stored = await readStoredLogs(productId, user);
    if (!stored) {
        throw inputError(
            `Product "${productId}" has no logs sources configured. Add one first.`,
        );
    }
    /** @type {LogsConfig} */
    const next = { sources: stored.sources };
    if (!clear) {
        if (!stored.sources.some((s) => s.name === name)) {
            throw inputError(
                `Source "${name}" is not configured on this product (have: ${stored.sources.map((s) => s.name).join(', ')})`,
            );
        }
        next.default = name;
    }
    const normalized = validateLogsConfig(next);
    await setProductProperty(productId, LOGS_PROPERTY, normalized, user);
    return normalized;
}

/**
 * Look up a single source by name on a product's `logs` config. When
 * the property is missing, the synthetic fallback is consulted so
 * `getLogSource(p, "system")` always resolves on products that have
 * not been explicitly configured. Returns `null` when no source
 * matches.
 *
 * @param {string} productId
 * @param {string} name
 * @param {string} [user]
 * @returns {Promise<LogSource | null>}
 */
export async function getLogSource(productId, name, user) {
    if (typeof name !== 'string' || !name) {
        throw inputError('name is required');
    }
    const cfg = await getProductLogs(productId, user);
    return cfg.sources.find((s) => s.name === name) || null;
}
