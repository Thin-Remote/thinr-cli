import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Profile-based configuration store.
 *
 * On disk the config file looks like:
 *   {
 *     "default": "<profile-name>",
 *     "profiles": {
 *       "<profile-name>": { server, username, token, refresh_token, ... }
 *     }
 *   }
 *
 * Profile names default to the server hostname so login against a new
 * server automatically creates an isolated profile.
 *
 * Legacy single-profile files (top-level server/username/token) are
 * detected on read and migrated to the new layout transparently. The
 * migration uses the legacy `server` field as the profile name.
 *
 * The "active" profile is the one all helpers operate on. It is picked
 * (in order): explicit override via setActiveProfile(), the THINR_PROFILE
 * environment variable, the file's `default` field.
 */

let activeProfileOverride = null;

/**
 * Get the config file path
 * @returns {string} Config file path
 */
export function getConfigPath() {
    const homeDir = os.homedir();
    const configDir = path.join(homeDir, '.config', 'thinr-cli');

    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }

    return path.join(configDir, 'config.json');
}

function emptyStore() {
    return { default: null, profiles: {} };
}

function readStore() {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) return emptyStore();
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
        return emptyStore();
    }

    // Legacy format: top-level {server, username, token, ...}. Migrate to
    // a profile keyed by the server hostname.
    if (raw && typeof raw === 'object' && !raw.profiles && raw.server) {
        const name = String(raw.server);
        return { default: name, profiles: { [name]: { ...raw } } };
    }

    if (!raw || typeof raw !== 'object' || !raw.profiles) return emptyStore();
    return raw;
}

function writeStore(store) {
    const configPath = getConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(store, null, 2), 'utf8');
}

/**
 * Override the active profile for the current process. Pass null to fall
 * back to env var / file default. Used by the CLI entry point when the
 * user passes --profile.
 */
export function setActiveProfile(name) {
    activeProfileOverride = name || null;
}

/**
 * Resolve the active profile name, or null if no profile exists.
 */
export function getActiveProfile() {
    if (activeProfileOverride) return activeProfileOverride;
    if (process.env.THINR_PROFILE) return process.env.THINR_PROFILE;
    const store = readStore();
    if (store.default && store.profiles[store.default]) return store.default;
    // Fall back to the only profile if there's exactly one.
    const names = Object.keys(store.profiles);
    return names.length === 1 ? names[0] : null;
}

/**
 * List all profile names.
 */
export function listProfiles() {
    return Object.keys(readStore().profiles);
}

/**
 * Get a specific profile by name (or undefined if missing).
 */
export function getProfile(name) {
    const store = readStore();
    return store.profiles[name];
}

/**
 * Set the persisted default profile.
 */
export function setDefaultProfile(name) {
    const store = readStore();
    if (!store.profiles[name]) {
        throw new Error(`Profile not found: ${name}`);
    }
    store.default = name;
    writeStore(store);
}

/**
 * Remove a profile by name. Returns true if removed.
 */
export function deleteProfile(name) {
    const store = readStore();
    if (!store.profiles[name]) return false;
    delete store.profiles[name];
    if (store.default === name) {
        const remaining = Object.keys(store.profiles);
        store.default = remaining[0] || null;
    }
    writeStore(store);
    return true;
}

/**
 * Check if any profile is configured.
 */
export function configExists() {
    const store = readStore();
    if (!Object.keys(store.profiles).length) return false;
    return getActiveProfile() != null;
}

/**
 * Read the active profile's data.
 * @returns {Object} Active profile fields (server, username, token, ...) or {}
 */
export function readConfig() {
    const store = readStore();
    const name = getActiveProfile();
    if (!name) return {};
    return store.profiles[name] || {};
}

/**
 * Read the active profile and assert that it has the fields every API
 * call needs (server, username, token). Throws a tagged error so the
 * MCP and CLI surfaces both classify the failure as `not_configured`
 * via classifyError. Replaces the same boilerplate that used to live
 * at the top of every helper in lib/.
 */
export function requireConfig() {
    const config = readConfig();
    if (!config.token || !config.server || !config.username) {
        const err = new Error('Not configured. Run thinr without parameters to set up.');
        err.code = 'not_configured';
        throw err;
    }
    return config;
}

/**
 * Write a fresh profile from the supplied data. The profile name is
 * derived from the supplied `server`, or from the active profile name
 * if no server is provided. Becomes the default if there isn't one yet.
 */
export function writeConfig(config) {
    const store = readStore();
    const name = (config && config.server) || getActiveProfile();
    if (!name) {
        throw new Error('Cannot write config without a server / profile name');
    }
    store.profiles[name] = { ...config };
    if (!store.default) store.default = name;
    writeStore(store);
}

/**
 * Merge fields into the active profile.
 */
export function mergeConfig(newConfig) {
    const store = readStore();
    const name = getActiveProfile();
    if (!name) {
        // No active profile yet: fall back to writeConfig semantics.
        return writeConfig(newConfig);
    }
    store.profiles[name] = { ...store.profiles[name], ...newConfig };
    writeStore(store);
}

/**
 * Delete the entire config (all profiles).
 */
export function deleteConfig() {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) return true;
    try {
        fs.unlinkSync(configPath);
        return true;
    } catch {
        return false;
    }
}
