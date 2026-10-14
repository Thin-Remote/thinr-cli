// @ts-check
import { tools as execTools } from './tools-exec.js';

/**
 * ThinRemote's own MCP tools: only `device_exec`, the command on one device
 * or a fleet. Everything else ThinRemote adds is served by the generic
 * `resource_*` tools of @thinger-io/cli-core: its resource types (a
 * device's files and scripts; a product's scripts, metrics, log sources
 * and playbooks) and its actions on devices, in resource-types.js, and
 * what it adds to the server's types, in resource-hooks.js.
 */
export const tools = [...execTools];
