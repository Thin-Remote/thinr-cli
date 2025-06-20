import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Get the config file path
 * @returns {string} Config file path
 */
export function getConfigPath() {
    const homeDir = os.homedir();
    const configDir = path.join(homeDir, '.config', 'thinr-cli');

    // Create config directory if it doesn't exist
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }

    return path.join(configDir, 'config.json');
}

/**
 * Check if configuration exists
 * @returns {boolean} True if configuration exists
 */
export function configExists() {
    const configPath = getConfigPath();
    return fs.existsSync(configPath);
}

/**
 * Read configuration
 * @returns {Object} Configuration object
 */
export function readConfig() {
    const configPath = getConfigPath();

    if (!fs.existsSync(configPath)) {
        return {};
    }

    try {
        const configData = fs.readFileSync(configPath, 'utf8');
        return JSON.parse(configData);
    } catch (error) {
        // If there's an error reading the config, return an empty object
        return {};
    }
}

/**
 * Write configuration
 * @param {Object} config - Configuration object
 */
export function writeConfig(config) {
    const configPath = getConfigPath();
    const configData = JSON.stringify(config, null, 2);

    fs.writeFileSync(configPath, configData, 'utf8');
}

/**
 * Merge new configuration properties with existing one
 * @param {Object} newConfig - New configuration properties
 */
export function mergeConfig(newConfig) {
    const existingConfig = readConfig();
    const mergedConfig = {...existingConfig, ...newConfig};
    writeConfig(mergedConfig);
}

/**
 * Delete configuration
 * @returns {boolean} True if deleted successfully
 */
export function deleteConfig() {
    const configPath = getConfigPath();

    if (fs.existsSync(configPath)) {
        try {
            fs.unlinkSync(configPath);
            return true;
        } catch (error) {
            return false;
        }
    }

    return true; // Already doesn't exist
}